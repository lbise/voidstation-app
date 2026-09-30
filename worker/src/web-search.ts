import type { WebSearchCategory, WebSearchHit, WebTimeRange } from "./web-contract.ts";

export type WebErrorCode = "invalid_request" | "configuration" | "blocked" | "unavailable" | "timed_out" | "cancelled" | "too_large" | "unsupported" | "invalid_response";

export class WebToolError extends Error {
  constructor(public readonly code: WebErrorCode, message: string) {
    super(message);
  }
}

export interface SearchRequest {
  query: string;
  category: WebSearchCategory;
  timeRange?: WebTimeRange;
}

/** A web search backend. Add an implementation and a `VOIDSTATION_SEARCH_PROVIDER` value to switch. */
export interface SearchProvider {
  readonly id: string;
  search(request: SearchRequest, signal?: AbortSignal): Promise<WebSearchHit[]>;
}

export const MAX_SEARCH_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return cleaned || undefined;
}

/** Accepts only absolute http(s) URLs without credentials. */
export function publicUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) return undefined;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new WebToolError("too_large", "The response is too large.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new WebToolError("too_large", "The response is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function abortReason(error: unknown, signal?: AbortSignal): WebToolError {
  if (error instanceof WebToolError) return error;
  if (signal?.aborted) return new WebToolError("cancelled", "The web request was cancelled.");
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new WebToolError("timed_out", "The web request did not finish before the deadline.");
  }
  return new WebToolError("unavailable", "The web request failed.");
}

/** Parses a SearXNG JSON response into bounded, validated search hits. */
export function parseSearxngResults(payload: unknown): WebSearchHit[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new WebToolError("invalid_response", "The search service returned an unusable response.");
  const seen = new Set<string>();
  const hits: WebSearchHit[] = [];
  for (const item of payload.results) {
    if (!isRecord(item)) continue;
    const url = publicUrl(item.url);
    const title = cleanText(item.title, 300);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const snippet = cleanText(item.content, 500);
    const engines = Array.isArray(item.engines) ? item.engines.filter((engine) => typeof engine === "string") : [];
    const source = cleanText(item.engine, 80) ?? cleanText(engines[0], 80);
    const publishedAt = isoDate(item.publishedDate);
    const thumbnail = publicUrl(item.thumbnail) ?? publicUrl(item.img_src);
    hits.push({
      title,
      url,
      ...(snippet ? { snippet } : {}),
      ...(source ? { source } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(thumbnail ? { thumbnail } : {}),
    });
    if (hits.length === MAX_SEARCH_RESULTS) break;
  }
  return hits;
}

export class SearxngProvider implements SearchProvider {
  readonly id = "searxng";

  constructor(private readonly endpoint: string) {}

  async search(request: SearchRequest, signal?: AbortSignal): Promise<WebSearchHit[]> {
    const url = new URL("search", `${this.endpoint.replace(/\/+$/, "")}/`);
    url.searchParams.set("q", request.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("categories", request.category);
    if (request.timeRange) url.searchParams.set("time_range", request.timeRange);
    const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await fetch(url, { signal: combined, redirect: "error", headers: { accept: "application/json" } });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new WebToolError("unavailable", "The search service is unavailable.");
      }
      const body = await readBounded(response, MAX_SEARCH_RESPONSE_BYTES);
      let payload: unknown;
      try { payload = JSON.parse(body.toString("utf8")); } catch { throw new WebToolError("invalid_response", "The search service returned an unusable response."); }
      return parseSearxngResults(payload);
    } catch (error) {
      if (error instanceof WebToolError) throw error;
      const failure = abortReason(error, signal);
      throw failure.code === "unavailable" ? new WebToolError("unavailable", "The search service is unavailable.") : failure;
    }
  }
}

/** Resolves the configured search backend. Called per request so configuration errors surface as tool errors. */
export function searchProviderFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): SearchProvider {
  const provider = env.VOIDSTATION_SEARCH_PROVIDER ?? "searxng";
  switch (provider) {
    case "searxng": {
      const endpoint = env.VOIDSTATION_SEARXNG_URL;
      const parsed = endpoint ? publicUrl(endpoint) : undefined;
      if (!parsed || new URL(parsed).search || new URL(parsed).hash) throw new WebToolError("configuration", "Web search is not configured.");
      return new SearxngProvider(parsed);
    }
    default:
      throw new WebToolError("configuration", "The configured web search provider is not supported.");
  }
}
