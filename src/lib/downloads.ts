import type { DownloadItem, DownloadQueue, DownloadStatus, ServiceQueue } from "@/lib/downloads-contract";
import type { MediaService } from "@/lib/media-contract";
import { workerConfiguration } from "@/lib/assistant-worker";

const MAX_RESPONSE_BYTES = 512 * 1024;
const STATUSES: readonly DownloadStatus[] = ["downloading", "queued", "paused", "delayed", "importing", "completed", "warning", "failed"];
const REASONS = ["not_configured", "service_unavailable", "timed_out", "invalid_response"] as const;
const ITEM_KEYS = ["id", "service", "title", "status", "problem", "size", "sizeLeft", "progress", "estimatedCompletion"];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactly(value: Json, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function isPlainText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isBytes(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isItem(value: unknown, service: MediaService): value is DownloadItem {
  if (!isRecord(value) || !hasExactly(value, ITEM_KEYS)) return false;
  return typeof value.id === "string" && value.id.length <= 160 && value.id.startsWith(`${service}-`) && /^[a-z]+-[A-Za-z0-9._:-]+$/.test(value.id)
    && value.service === service
    && isPlainText(value.title, 300)
    && STATUSES.includes(value.status as DownloadStatus)
    && (value.problem === null || isPlainText(value.problem, 200))
    && isBytes(value.size) && isBytes(value.sizeLeft)
    && (value.progress === null || (typeof value.progress === "number" && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100))
    && (value.estimatedCompletion === null || isIsoTime(value.estimatedCompletion));
}

function isServiceQueue(value: unknown, service: MediaService): value is ServiceQueue {
  if (!isRecord(value)) return false;
  if (value.status === "unavailable") {
    return hasExactly(value, ["status", "reason", "observedAt"]) && value.observedAt === null && REASONS.includes(value.reason as typeof REASONS[number]);
  }
  if (value.status !== "available" || !hasExactly(value, ["status", "items", "total", "observedAt"]) || !isIsoTime(value.observedAt)) return false;
  if (!Array.isArray(value.items) || value.items.length > 50 || !value.items.every((item) => isItem(item, service))) return false;
  const ids = new Set(value.items.map((item: DownloadItem) => item.id));
  return ids.size === value.items.length && typeof value.total === "number" && Number.isSafeInteger(value.total) && value.total >= value.items.length;
}

/** Strict contract check; anything unexpected from the worker is discarded. */
export function isDownloadQueue(value: unknown): value is DownloadQueue {
  return isRecord(value) && hasExactly(value, ["radarr", "sonarr"]) && isServiceQueue(value.radarr, "radarr") && isServiceQueue(value.sonarr, "sonarr");
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Download queue unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Download queue too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads the model-independent download queue from the assistant worker. Throws on any failure. */
export async function fetchDownloadQueue(signal?: AbortSignal): Promise<DownloadQueue> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  try {
    const { url, token } = workerConfiguration();
    const response = await fetch(new URL("/media/queue", url), {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal, cache: "no-store", redirect: "error",
    });
    if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("application/json")) {
      await response.body?.cancel();
      throw new Error("Download queue unavailable");
    }
    const value: unknown = JSON.parse(await boundedText(response));
    if (!isDownloadQueue(value)) throw new Error("Invalid download queue");
    return value;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
