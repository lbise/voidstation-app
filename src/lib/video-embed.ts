import type { ToolCallRecord, WebResult } from "@/lib/assistant-contract";

export type VideoEmbed = {
  provider: "youtube" | "vimeo";
  id: string;
  /** Stable identity for comparing different URL forms of the same video. */
  key: string;
  embedUrl: string;
  watchUrl: string;
  start?: number;
};

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{6,12}$/;

function startSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || !value) return undefined;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds > 0 ? seconds : undefined;
}

/** Recognizes YouTube and Vimeo video URLs. Everything else stays a plain link. */
export function videoEmbed(raw: string): VideoEmbed | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const segments = url.pathname.split("/").filter(Boolean);
  let youtube: string | undefined;
  if (host === "youtu.be") youtube = segments[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") youtube = url.searchParams.get("v") ?? undefined;
    else if (["embed", "shorts", "live", "v"].includes(segments[0] ?? "")) youtube = segments[1];
  }
  if (youtube !== undefined) {
    if (!YOUTUBE_ID.test(youtube)) return undefined;
    const start = startSeconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
    const embed = new URL(`https://www.youtube-nocookie.com/embed/${youtube}`);
    embed.searchParams.set("rel", "0");
    if (start) embed.searchParams.set("start", String(start));
    return { provider: "youtube", id: youtube, key: `youtube:${youtube}`, embedUrl: embed.toString(), watchUrl: `https://www.youtube.com/watch?v=${youtube}`, ...(start ? { start } : {}) };
  }
  let vimeo: string | undefined;
  if (host === "vimeo.com") vimeo = segments.find((segment) => VIMEO_ID.test(segment));
  else if (host === "player.vimeo.com" && segments[0] === "video") vimeo = segments[1];
  if (vimeo !== undefined && VIMEO_ID.test(vimeo)) {
    return { provider: "vimeo", id: vimeo, key: `vimeo:${vimeo}`, embedUrl: `https://player.vimeo.com/video/${vimeo}?dnt=1`, watchUrl: `https://vimeo.com/${vimeo}` };
  }
  return undefined;
}

function isWebResult(value: unknown): value is WebResult {
  return Boolean(value) && typeof value === "object" && ((value as { kind?: unknown }).kind === "webSearch" || (value as { kind?: unknown }).kind === "webPage");
}

/** Video keys the Assistant actually saw in web tool results. Only these are embedded, so an invented link never becomes a player. */
export function verifiedVideoKeys(toolCalls: readonly ToolCallRecord[]): Set<string> {
  const keys = new Set<string>();
  const add = (url: unknown) => {
    if (typeof url !== "string") return;
    const embed = videoEmbed(url);
    if (embed) keys.add(embed.key);
  };
  for (const call of toolCalls) {
    if (call.status !== "complete" || !isWebResult(call.result)) continue;
    const result = call.result;
    if (result.kind === "webSearch" && Array.isArray(result.results)) for (const hit of result.results) add(hit?.url);
    if (result.kind === "webPage") {
      add(result.url);
      if (Array.isArray(result.videos)) for (const url of result.videos) add(url);
    }
  }
  return keys;
}

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/g;

/** Verified videos linked from one message, in order, without duplicates. */
export function messageVideos(text: string, verified: ReadonlySet<string>, limit = 4): VideoEmbed[] {
  const videos: VideoEmbed[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const embed = videoEmbed(match[0].replace(/[.,;:!?]+$/, ""));
    if (!embed || !verified.has(embed.key) || videos.some((video) => video.key === embed.key)) continue;
    videos.push(embed);
    if (videos.length === limit) break;
  }
  return videos;
}
