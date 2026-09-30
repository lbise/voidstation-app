import type { MediaService } from "./media-contract.ts";
import type { DownloadItem, DownloadQueue, DownloadStatus, ServiceQueue } from "./downloads-contract.ts";
import { MediaToolError, isRecord, parseServiceConfig, readConfigSource, runPython, type ServiceConfig } from "./media.ts";

/** Dashboard polling shares one upstream read per service within this window. */
const CACHE_MS = 10_000;
/** Leaves headroom inside the Dashboard's 10 s worker deadline. */
const QUEUE_PROCESS_TIMEOUT_MS = 8_000;
/** 200 projected records with escaped non-ASCII text can exceed the tool budget. */
const QUEUE_OUTPUT_BYTES = 6 * 1024 * 1024;
const MAX_ITEMS = 50;
const MAX_PROBLEM_LENGTH = 200;
const MAX_TITLE_LENGTH = 300;
const SAFE_DOWNLOAD_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type Unavailable = Extract<ServiceQueue, { status: "unavailable" }>["reason"];

interface QueueRecord {
  id?: number;
  downloadId?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  errorMessage?: string;
  estimatedCompletionTime?: string;
  size?: number;
  sizeLeft?: number;
  statusMessages: { title?: string; messages: string[] }[];
  mediaTitle?: string;
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

class InvalidQueue extends Error {}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 1_000 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Untrusted upstream text becomes one plain line of at most `max` UTF-16 units. */
export function plainText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= max) return cleaned;
  let result = "";
  for (const character of cleaned) {
    if (result.length + character.length > max - 1) break;
    result += character;
  }
  return `${result.trimEnd()}…`;
}

function parseRecord(value: unknown): QueueRecord {
  if (!isRecord(value)) throw new InvalidQueue();
  const statusMessages = Array.isArray(value.statusMessages)
    ? value.statusMessages.filter(isRecord).map((item) => ({
      ...(text(item.title) ? { title: text(item.title) } : {}),
      messages: Array.isArray(item.messages) ? item.messages.map(text).filter((message): message is string => message !== undefined) : [],
    }))
    : [];
  const record: QueueRecord = { statusMessages };
  const id = nonNegativeInteger(value.id);
  if (id !== undefined && id > 0) record.id = id;
  for (const key of ["downloadId", "status", "trackedDownloadStatus", "trackedDownloadState", "errorMessage", "estimatedCompletionTime", "mediaTitle"] as const) {
    const field = text(value[key]);
    if (field !== undefined) record[key] = field;
  }
  for (const key of ["size", "sizeLeft", "year", "seasonNumber", "episodeNumber"] as const) {
    const field = nonNegativeInteger(value[key]);
    if (field !== undefined) record[key] = field;
  }
  return record;
}

/**
 * Status precedence, compared case-insensitively:
 * failed    – trackedDownloadState failed/failedPending, or status failed
 * warning   – trackedDownloadStatus warning/error, trackedDownloadState importBlocked,
 *             or status warning/downloadClientUnavailable
 * importing – trackedDownloadState importPending/importing
 * otherwise status downloading/queued/paused/completed map directly and delay → delayed;
 * trackedDownloadState imported → completed; anything else (unknown, fallback) → queued.
 */
export function downloadStatus(record: Pick<QueueRecord, "status" | "trackedDownloadStatus" | "trackedDownloadState">): DownloadStatus {
  const status = record.status?.toLowerCase();
  const trackedStatus = record.trackedDownloadStatus?.toLowerCase();
  const trackedState = record.trackedDownloadState?.toLowerCase();
  if (trackedState === "failed" || trackedState === "failedpending" || status === "failed") return "failed";
  if (trackedStatus === "warning" || trackedStatus === "error" || trackedState === "importblocked" || status === "warning" || status === "downloadclientunavailable") return "warning";
  if (trackedState === "importpending" || trackedState === "importing") return "importing";
  switch (status) {
    case "downloading": return "downloading";
    case "queued": return "queued";
    case "paused": return "paused";
    case "delay": return "delayed";
    case "completed": return "completed";
  }
  return trackedState === "imported" ? "completed" : "queued";
}

const STATUS_SEVERITY: DownloadStatus[] = ["failed", "warning", "importing", "downloading", "paused", "delayed", "queued", "completed"];

function problem(records: QueueRecord[]): string | null {
  const candidates = [
    ...records.map((record) => record.errorMessage),
    ...records.flatMap((record) => record.statusMessages.flatMap((message) => message.messages)),
    ...records.flatMap((record) => record.statusMessages.map((message) => message.title)),
  ];
  for (const candidate of candidates) {
    const cleaned = plainText(candidate, MAX_PROBLEM_LENGTH);
    if (cleaned) return cleaned;
  }
  return null;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

function title(service: MediaService, records: QueueRecord[]): string {
  const first = records[0]!;
  const name = plainText(first.mediaTitle, MAX_TITLE_LENGTH - 40);
  if (service === "radarr") {
    const movie = name ?? "Unknown movie";
    return first.year !== undefined && first.year >= 1800 && first.year <= 3000 ? `${movie} (${first.year})` : movie;
  }
  const series = name ?? "Unknown series";
  const episodes = new Map<string, { season: number; episode: number }>();
  for (const record of records) {
    if (record.seasonNumber !== undefined && record.episodeNumber !== undefined) {
      episodes.set(`${record.seasonNumber}:${record.episodeNumber}`, { season: record.seasonNumber, episode: record.episodeNumber });
    }
  }
  const seasons = [...new Set(records.map((record) => record.seasonNumber).filter((season): season is number => season !== undefined))].sort((a, b) => a - b);
  if (episodes.size === 1) {
    const [only] = episodes.values();
    return `${series} · S${pad(only!.season)}E${pad(only!.episode)}`;
  }
  const count = episodes.size > 1 ? ` (${episodes.size} episodes)` : "";
  if (seasons.length === 1) return `${series} · Season ${seasons[0]}${count}`;
  if (seasons.length > 1) return `${series} · Seasons ${seasons[0]}–${seasons.at(-1)}${count}`;
  return series;
}

function estimatedCompletion(records: QueueRecord[]): string | null {
  for (const record of records) {
    if (!record.estimatedCompletionTime) continue;
    const time = Date.parse(record.estimatedCompletionTime);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return null;
}

function itemFor(service: MediaService, records: QueueRecord[], id: string): DownloadItem {
  // Sonarr repeats the whole release size on every episode record of a pack,
  // so the largest record describes the download rather than a sum.
  const sized = records.filter((record) => record.size !== undefined).sort((a, b) => b.size! - a.size!)[0];
  const size = sized?.size ?? null;
  const sizeLeft = sized ? sized.sizeLeft ?? null : records.find((record) => record.sizeLeft !== undefined)?.sizeLeft ?? null;
  const progress = size !== null && size > 0 && sizeLeft !== null
    ? Math.round(Math.min(100, Math.max(0, ((size - sizeLeft) / size) * 100)) * 10) / 10
    : null;
  const status = records.map(downloadStatus).sort((a, b) => STATUS_SEVERITY.indexOf(a) - STATUS_SEVERITY.indexOf(b))[0]!;
  return { id, service, title: title(service, records), status, problem: problem(records), size, sizeLeft, progress, estimatedCompletion: estimatedCompletion(records) };
}

function problemRank(status: DownloadStatus): number {
  return status === "failed" ? 0 : status === "warning" ? 1 : 2;
}

/** Converts one restricted adapter payload into the Dashboard queue for a service. */
export function projectQueue(service: MediaService, output: unknown): { items: DownloadItem[]; total: number } {
  if (!isRecord(output) || output.ok !== true || output.action !== "queue" || output.service !== service || !Array.isArray(output.records)) throw new InvalidQueue();
  const totalRecords = nonNegativeInteger(output.totalRecords);
  if (totalRecords === undefined) throw new InvalidQueue();
  const records = output.records.map(parseRecord);
  const groups: QueueRecord[][] = [];
  const byDownload = new Map<string, QueueRecord[]>();
  for (const record of records) {
    // Sonarr reports one record per episode; a season pack shares one download.
    if (service === "sonarr" && record.downloadId) {
      const existing = byDownload.get(record.downloadId);
      if (existing) { existing.push(record); continue; }
      const group = [record];
      byDownload.set(record.downloadId, group);
      groups.push(group);
    } else {
      groups.push([record]);
    }
  }
  const used = new Set<string>();
  const items = groups.map((group, index) => {
    const first = group[0]!;
    const candidates = [
      first.downloadId && SAFE_DOWNLOAD_ID.test(first.downloadId) ? `${service}-${first.downloadId}` : undefined,
      first.id !== undefined ? `${service}-${first.id}` : undefined,
      `${service}-item-${index}`,
    ];
    const id = candidates.find((candidate): candidate is string => candidate !== undefined && !used.has(candidate)) ?? `${service}-item-${index}-${used.size}`;
    used.add(id);
    return itemFor(service, group, id);
  });
  items.sort((a, b) => {
    const rank = problemRank(a.status) - problemRank(b.status);
    if (rank !== 0) return rank;
    if (a.estimatedCompletion === b.estimatedCompletion) return 0;
    if (a.estimatedCompletion === null) return 1;
    if (b.estimatedCompletion === null) return -1;
    return Date.parse(a.estimatedCompletion) - Date.parse(b.estimatedCompletion);
  });
  // Records beyond the fetched page cannot be grouped, so they count individually.
  const total = groups.length + Math.max(0, totalRecords - records.length);
  return { items: items.slice(0, MAX_ITEMS), total };
}

function unavailable(reason: Unavailable): ServiceQueue {
  return { status: "unavailable", reason, observedAt: null };
}

function reasonFor(error: unknown): Unavailable {
  if (error instanceof InvalidQueue) return "invalid_response";
  if (error instanceof MediaToolError) {
    if (error.code === "configuration") return "not_configured";
    if (error.code === "timed_out") return "timed_out";
    if (error.code === "invalid_response") return "invalid_response";
  }
  return "service_unavailable";
}

/**
 * Each service is configured independently here so one missing or invalid
 * entry does not hide the other service's queue.
 */
async function serviceConfigs(): Promise<Partial<Record<MediaService, ServiceConfig>>> {
  let value: unknown;
  try { value = JSON.parse(await readConfigSource()) as unknown; } catch { return {}; }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "radarr" && key !== "sonarr")) return {};
  return { radarr: parseServiceConfig(value.radarr, "radarr"), sonarr: parseServiceConfig(value.sonarr, "sonarr") };
}

async function serviceQueue(service: MediaService, config: ServiceConfig | undefined): Promise<ServiceQueue> {
  if (!config) return unavailable("not_configured");
  try {
    const output = await runPython(service, config, ["restricted", "queue"], undefined, {
      maxOutputBytes: QUEUE_OUTPUT_BYTES,
      timeoutMs: QUEUE_PROCESS_TIMEOUT_MS,
      detailedFailures: true,
    });
    return { status: "available", ...projectQueue(service, output), observedAt: new Date().toISOString() };
  } catch (error) {
    return unavailable(reasonFor(error));
  }
}

async function collect(): Promise<DownloadQueue> {
  const configs = await serviceConfigs();
  const [radarr, sonarr] = await Promise.all([serviceQueue("radarr", configs.radarr), serviceQueue("sonarr", configs.sonarr)]);
  return { radarr, sonarr };
}

let cached: { value: DownloadQueue; at: number } | undefined;
let inflight: Promise<DownloadQueue> | undefined;

/** Read-only queue snapshot; independent of any model provider. */
export function downloadQueue(): Promise<DownloadQueue> {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.value);
  inflight ??= collect()
    .then((value) => { cached = { value, at: Date.now() }; return value; })
    .finally(() => { inflight = undefined; });
  return inflight;
}
