import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readApprovedSkill, SkillReadError, type MediaService } from "./skills.ts";
import type { MediaChoice, MediaResult, MediaStatus, MediaType } from "./media-contract.ts";
export type { MediaChoice, MediaResult, MediaStatus, MediaType } from "./media-contract.ts";

type MediaOperation = "read_skill" | "lookup" | "discovery" | "status";
type MediaErrorCode = "invalid_request" | "configuration" | "skill_unavailable" | "service_unavailable" | "timed_out" | "cancelled" | "invalid_response";

interface ServiceConfig {
  endpoint: string;
  keyFile: string;
  rootFolder: string;
  defaultQualityProfileId: number;
  qualityMappings: Record<string, number>;
}

type MediaConfig = Record<MediaService, ServiceConfig>;
type JsonRecord = Record<string, unknown>;

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024;
const PROCESS_TIMEOUT_MS = 12_000;
const MAX_LOOKUP_CHOICES = 20;
const PYTHON = "python3";
const SCRIPT_ROOT = process.env.VOIDSTATION_MEDIA_SCRIPT_DIR ?? "/app/media/upstream";
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

class MediaToolError extends Error {
  constructor(public readonly code: MediaErrorCode, message: string) {
    super(message);
  }
}

class ProcessError extends MediaToolError {
  constructor(code: Extract<MediaErrorCode, "service_unavailable" | "timed_out" | "cancelled" | "invalid_response">) {
    super(code, processErrorMessage(code));
  }
}

function processErrorMessage(code: ProcessError["code"]): string {
  switch (code) {
    case "timed_out": return "The media service did not respond before the deadline.";
    case "cancelled": return "The media request was cancelled.";
    case "invalid_response": return "The media service returned an unusable response.";
    default: return "The media service is unavailable.";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cleanText(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return cleaned || undefined;
}

function mediaService(type: MediaType): MediaService {
  return type === "movie" ? "radarr" : "sonarr";
}

function safeEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function parseServiceConfig(value: unknown): ServiceConfig | undefined {
  if (!isRecord(value) || !exactKeys(value, ["endpoint", "keyFile", "rootFolder", "defaultQualityProfileId", "qualityMappings"])) return undefined;
  const endpoint = safeEndpoint(value.endpoint);
  const keyFile = cleanText(value.keyFile, 1_000);
  const rootFolder = cleanText(value.rootFolder, 1_000);
  if (!endpoint || !keyFile || !isAbsolute(keyFile) || !rootFolder || !positiveInteger(value.defaultQualityProfileId) || !isRecord(value.qualityMappings)) return undefined;
  const qualityMappings: Record<string, number> = {};
  const seenNames = new Set<string>();
  for (const [name, id] of Object.entries(value.qualityMappings)) {
    const cleaned = cleanText(name, 120);
    const normalized = cleaned?.toLocaleLowerCase();
    if (!cleaned || !normalized || seenNames.has(normalized) || !positiveInteger(id)) return undefined;
    seenNames.add(normalized);
    qualityMappings[cleaned] = id;
  }
  return { endpoint, keyFile, rootFolder, defaultQualityProfileId: value.defaultQualityProfileId, qualityMappings };
}

async function loadConfig(): Promise<MediaConfig> {
  const file = process.env.VOIDSTATION_MEDIA_CONFIG_FILE;
  if (!file || !isAbsolute(file)) throw new MediaToolError("configuration", "Media configuration is unavailable.");
  let source: string;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) throw new Error("invalid config file");
    source = await readFile(file, "utf8");
  } catch {
    throw new MediaToolError("configuration", "Media configuration is unavailable.");
  }
  try {
    const value = JSON.parse(source) as unknown;
    if (!isRecord(value) || !exactKeys(value, ["radarr", "sonarr"])) throw new Error("invalid config");
    const radarr = parseServiceConfig(value.radarr);
    const sonarr = parseServiceConfig(value.sonarr);
    if (!radarr || !sonarr) throw new Error("invalid config");
    return { radarr, sonarr };
  } catch {
    throw new MediaToolError("configuration", "Media configuration is invalid.");
  }
}

async function readApiKey(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > 8_192) throw new Error("invalid key file");
    const key = (await readFile(path, "utf8")).trim();
    if (!key || /\s/.test(key)) throw new Error("invalid key");
    return key;
  } catch {
    throw new MediaToolError("configuration", "The media service credential is unavailable.");
  }
}

function scriptFor(service: MediaService): string {
  return join(SCRIPT_ROOT, `${service}.py`);
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* The child may have exited. */ }
    setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* The child may have exited. */ }
    }, 500).unref();
  }
  try { child.kill("SIGTERM"); } catch { /* The child may have exited. */ }
}

async function runPython(service: MediaService, config: ServiceConfig, args: readonly string[], signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new ProcessError("cancelled");
  const key = await readApiKey(config.keyFile);
  const keyName = service === "radarr" ? "RADARR_API_KEY" : "SONARR_API_KEY";
  const urlName = service === "radarr" ? "RADARR_URL" : "SONARR_URL";
  const env: NodeJS.ProcessEnv = {
    PATH: CHILD_PATH,
    HOME: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONNOUSERSITE: "1",
    NO_PROXY: "*",
    no_proxy: "*",
    [keyName]: key,
    [urlName]: config.endpoint,
  };

  return new Promise<unknown>((resolveResult, rejectResult) => {
    let child: ChildProcess;
    try {
      child = spawn(PYTHON, [scriptFor(service), ...args], {
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch {
      rejectResult(new ProcessError("service_unavailable"));
      return;
    }
    let output = "";
    let finished = false;
    const finish = (error?: MediaToolError, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectResult(error);
      else resolveResult(value);
    };
    const onAbort = () => {
      killChild(child);
      finish(new ProcessError("cancelled"));
    };
    const timeout = setTimeout(() => {
      killChild(child);
      finish(new ProcessError("timed_out"));
    }, PROCESS_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish(new ProcessError("service_unavailable")));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (finished) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > MAX_PROCESS_OUTPUT_BYTES) {
        killChild(child);
        finish(new ProcessError("invalid_response"));
      }
    });
    child.on("close", (code) => {
      if (finished) return;
      if (code !== 0) return finish(new ProcessError("service_unavailable"));
      try {
        finish(undefined, JSON.parse(output) as unknown);
      } catch {
        finish(new ProcessError("invalid_response"));
      }
    });
  });
}

function requireArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new ProcessError("invalid_response");
  return value;
}

function choiceFrom(value: JsonRecord, type: MediaType): MediaChoice | undefined {
  const externalId = value.id;
  const title = cleanText(value.title);
  const year = typeof value.year === "number" && Number.isSafeInteger(value.year) && value.year >= 1800 && value.year <= 3000 ? value.year : null;
  return positiveInteger(externalId) && title ? { externalId, title, year, type } : undefined;
}

function restrictedPayload(value: unknown): JsonRecord {
  if (!isRecord(value) || value.ok !== true) throw new ProcessError("invalid_response");
  return value;
}

function hasActiveDownload(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => isRecord(item) && cleanText(item.status, 80)?.toLocaleLowerCase() === "downloading");
}

function findProfileAndFolder(value: unknown, config: ServiceConfig): void {
  if (!isRecord(value) || !Array.isArray(value.rootFolders) || !Array.isArray(value.qualityProfiles)) throw new ProcessError("invalid_response");
  const folderMatches = value.rootFolders.filter((item) => isRecord(item) && item.path === config.rootFolder);
  const profileMatches = value.qualityProfiles.filter((item) => isRecord(item) && item.id === config.defaultQualityProfileId);
  if (folderMatches.length !== 1 || profileMatches.length !== 1) {
    throw new MediaToolError("configuration", "The configured media folder or quality profile is unavailable.");
  }
}

function configuredQuality(config: ServiceConfig, quality: string | undefined): { id: number; name?: string } {
  if (quality === undefined) return { id: config.defaultQualityProfileId };
  const requested = cleanText(quality, 120);
  if (!requested) throw new MediaToolError("invalid_request", "The requested quality is invalid.");
  const match = Object.entries(config.qualityMappings).find(([name]) => name.toLocaleLowerCase() === requested.toLocaleLowerCase());
  if (!match) throw new MediaToolError("configuration", "The requested quality is not configured.");
  return { name: match[0], id: match[1] };
}

function resultText(result: MediaResult): string { return JSON.stringify(result); }

function mediaFailure(operation: MediaOperation, error: unknown, status?: MediaStatus): MediaResult {
  const failure = error instanceof SkillReadError || error instanceof MediaToolError
    ? { code: error.code, message: error.message }
    : { code: "service_unavailable", message: "The media service is unavailable." };
  return { kind: "error", operation, ...failure, ...(status ? { data: status } : {}) };
}

/** Creates the only media tools available to the assistant. None can mutate a service. */
export function createMediaTools(onResult: (result: MediaResult) => void): ToolDefinition[] {
  const report = (result: MediaResult) => {
    try { onResult(result); } catch { /* Result persistence must not expose or replace a safe tool result. */ }
    return { content: [{ type: "text" as const, text: resultText(result) }], details: { result } };
  };

  const readSkill = defineTool({
    name: "read_skill",
    label: "Read media skill",
    description: "Read the packaged Radarr or Sonarr SKILL.md, or an approved supporting resource.",
    parameters: Type.Object({
      service: StringEnum(["radarr", "sonarr"] as const),
      resource: Type.String({ minLength: 1, maxLength: 240 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params) {
      try {
        return report({ kind: "skill", ...await readApprovedSkill(params.service, params.resource) });
      } catch (error) {
        return report(mediaFailure("read_skill", error));
      }
    },
  });

  const lookup = defineTool({
    name: "media_lookup",
    label: "Look up media titles",
    description: "Look up movie or series title choices. This does not choose a title or change a media service.",
    parameters: Type.Object({
      type: StringEnum(["movie", "series"] as const),
      query: Type.String({ minLength: 1, maxLength: 200, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      try {
        const query = cleanText(params.query, 200);
        if (!query) throw new MediaToolError("invalid_request", "The lookup query is invalid.");
        const config = await loadConfig();
        const service = mediaService(params.type);
        const output = restrictedPayload(await runPython(service, config[service], ["restricted", "lookup", "--term", query], signal));
        const choices = requireArray(output.results).map((item) => choiceFrom(item, params.type)).filter((item): item is MediaChoice => item !== undefined).slice(0, MAX_LOOKUP_CHOICES);
        return report({ kind: "lookup", choices });
      } catch (error) {
        return report(mediaFailure("lookup", error));
      }
    },
  });

  const discover = defineTool({
    name: "media_discover",
    label: "Validate media defaults",
    description: "Validate the configured root folder and requested or default quality profile for movies or series.",
    parameters: Type.Object({
      type: StringEnum(["movie", "series"] as const),
      quality: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: "^[^\\u0000-\\u001f\\u007f]+$" })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      try {
        const config = await loadConfig();
        const service = mediaService(params.type);
        const serviceConfig = config[service];
        const quality = configuredQuality(serviceConfig, params.quality);
        // The packaged restricted CLI exposes this one fixed read-only discovery operation.
        const output = restrictedPayload(await runPython(service, serviceConfig, ["restricted", "configuration"], signal));
        findProfileAndFolder(output, { ...serviceConfig, defaultQualityProfileId: quality.id });
        return report({ kind: "discovery", type: params.type, rootFolder: serviceConfig.rootFolder, qualityProfileId: quality.id, ...(quality.name ? { quality: quality.name } : {}) });
      } catch (error) {
        return report(mediaFailure("discovery", error));
      }
    },
  });

  const status = defineTool({
    name: "media_status",
    label: "Check media status",
    description: "Check whether one resolved movie or series is tracked, downloading, or available. It does not change the service.",
    parameters: Type.Object({
      type: StringEnum(["movie", "series"] as const),
      externalId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const unknown: MediaStatus = { type: params.type, externalId: params.externalId, tracked: null, activeDownload: null, available: null };
      try {
        const config = await loadConfig();
        const service = mediaService(params.type);
        const output = restrictedPayload(await runPython(service, config[service], ["restricted", "status", "--id", String(params.externalId)], signal));
        if (typeof output.tracked !== "boolean" || !Array.isArray(output.activeDownloads) || (output.hasFile !== undefined && typeof output.hasFile !== "boolean")) {
          throw new ProcessError("invalid_response");
        }
        return report({ kind: "status", ...unknown, tracked: output.tracked, activeDownload: output.tracked ? hasActiveDownload(output.activeDownloads) : false, available: output.hasFile === undefined ? null : output.hasFile });
      } catch (error) {
        return report(mediaFailure("status", error, unknown));
      }
    },
  });

  return [readSkill, lookup, discover, status];
}
