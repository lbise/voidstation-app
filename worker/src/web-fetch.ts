import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { WebLink } from "./web-contract.ts";
import { WebToolError, abortReason, cleanText, publicUrl } from "./web-search.ts";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
export const MAX_PAGE_CHARACTERS = 24_000;
const MAX_LINKS = 40;
const MAX_VIDEOS = 10;
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "application/ld+json", "text/xml", "application/xml", "application/rss+xml", "application/atom+xml"]);

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) NON_PUBLIC.addSubnet(network, prefix, "ipv6");

/** True only for globally routable unicast addresses. Private, loopback, link-local, CGNAT, and special ranges are rejected. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !NON_PUBLIC.check(address, "ipv4");
  if (version !== 6) return false;
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (/^(?:0*:)*:?ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(address)) return false;
  return !NON_PUBLIC.check(address, "ipv6");
}

export interface FetchPolicy {
  address(ip: string): boolean;
  port(port: number): boolean;
}

export const PUBLIC_WEB: FetchPolicy = { address: isPublicAddress, port: (port) => ALLOWED_PORTS.has(port) };

export interface FetchedPage {
  url: string;
  title?: string;
  siteName?: string;
  byline?: string;
  publishedAt?: string;
  excerpt?: string;
  text: string;
  characters: number;
  truncated: boolean;
  links: WebLink[];
  videos: string[];
}

interface RawResponse {
  status: number;
  location?: string;
  contentType: string;
  charset?: string;
  body: Buffer;
}

export function guardedLookup(policy: FetchPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error) return callback(error, "", 4);
      if (addresses.length === 0 || addresses.some((entry) => !policy.address(entry.address))) {
        return callback(Object.assign(new Error("blocked address"), { code: "VOIDSTATION_BLOCKED" }), "", 4);
      }
      if (options.all) return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
      const first = addresses.find((entry) => !options.family || entry.family === options.family) ?? addresses[0]!;
      callback(null, first.address, first.family);
    });
  };
}

function targetFor(raw: string, policy: FetchPolicy): URL {
  const checked = publicUrl(raw);
  if (!checked) throw new WebToolError("invalid_request", "Only absolute http and https URLs can be read.");
  const url = new URL(checked);
  url.hash = "";
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!policy.port(port)) throw new WebToolError("blocked", "That port is not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (isIP(host) && !policy.address(host)) throw new WebToolError("blocked", "Private and internal network addresses cannot be read.");
  if (!isIP(host) && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes("."))) {
    throw new WebToolError("blocked", "Private and internal network addresses cannot be read.");
  }
  return url;
}

function decoded(response: IncomingMessage): Readable {
  switch ((response.headers["content-encoding"] ?? "").toLowerCase().trim()) {
    case "gzip": case "x-gzip": return response.pipe(createGunzip());
    case "deflate": return response.pipe(createInflate());
    case "br": return response.pipe(createBrotliDecompress());
    case "": case "identity": return response;
    default: throw new WebToolError("unsupported", "The page uses an unsupported content encoding.");
  }
}

function requestOnce(url: URL, policy: FetchPolicy, signal: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      signal,
      lookup: guardedLookup(policy),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.8",
        "accept-encoding": "gzip, deflate, br",
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const [type = "", ...parameters] = (response.headers["content-type"] ?? "").split(";");
      const charset = parameters.map((part) => /^\s*charset\s*=\s*"?([^";\s]+)/i.exec(part)?.[1]).find(Boolean);
      const location = typeof response.headers.location === "string" ? response.headers.location : undefined;
      if (status >= 300 && status < 400) {
        response.resume();
        return resolve({ status, location, contentType: type.trim().toLowerCase(), body: Buffer.alloc(0) });
      }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES && !response.headers["content-encoding"]) {
        response.destroy();
        return reject(new WebToolError("too_large", "The page is too large to read."));
      }
      let stream: Readable;
      try { stream = decoded(response); } catch (error) { response.destroy(); return reject(error); }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PAGE_BYTES) {
          stream.destroy();
          response.destroy();
          reject(new WebToolError("too_large", "The page is too large to read."));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", () => reject(new WebToolError("invalid_response", "The page could not be decoded.")));
      stream.on("end", () => resolve({ status, contentType: type.trim().toLowerCase(), ...(charset ? { charset } : {}), body: Buffer.concat(chunks) }));
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "VOIDSTATION_BLOCKED") reject(new WebToolError("blocked", "Private and internal network addresses cannot be read."));
      else if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") reject(new WebToolError("unavailable", "The site's address could not be found."));
      else reject(error);
    });
    request.end();
  });
}

function decodeBody(body: Buffer, charset: string | undefined, html: boolean): string {
  let label = charset;
  if (!label && html) {
    const head = body.subarray(0, 4_096).toString("latin1");
    label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  try { return new TextDecoder(label ?? "utf-8").decode(body); } catch { return new TextDecoder("utf-8").decode(body); }
}

const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "BLOCKQUOTE", "PRE", "TABLE", "TR", "UL", "OL", "DL", "DT", "DD", "FIGURE", "FIGCAPTION", "BR", "HR"]);

/** Converts an element tree to readable plain text with paragraph, heading, and list breaks. */
function readableText(root: any): string {
  const parts: string[] = [];
  const walk = (node: any) => {
    if (node.nodeType === 3) { parts.push(String(node.textContent ?? "").replace(/\s+/g, " ")); return; }
    if (node.nodeType !== 1) return;
    const tag = String(node.tagName ?? "").toUpperCase();
    if (["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE", "IFRAME", "BUTTON", "FORM", "INPUT", "SELECT"].includes(tag)) return;
    const heading = /^H([1-6])$/.exec(tag);
    if (heading) parts.push(`\n\n${"#".repeat(Math.min(Number(heading[1]) + 1, 4))} `);
    else if (tag === "LI") parts.push("\n- ");
    else if (tag === "TD" || tag === "TH") parts.push(" | ");
    else if (BLOCK_TAGS.has(tag)) parts.push("\n\n");
    for (const child of node.childNodes ?? []) walk(child);
    if (heading || BLOCK_TAGS.has(tag)) parts.push("\n\n");
  };
  walk(root);
  return parts.join("")
    .split("\n").map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** True for a single YouTube or Vimeo video, not channels, home pages, or playlists. */
export function isVideoUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") return YOUTUBE_ID.test(segments[0] ?? "");
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") return YOUTUBE_ID.test(url.searchParams.get("v") ?? "");
    return ["embed", "shorts", "live", "v"].includes(segments[0] ?? "") && YOUTUBE_ID.test(segments[1] ?? "");
  }
  if (host === "vimeo.com") return segments.length === 1 && /^\d{6,12}$/.test(segments[0]!);
  if (host === "player.vimeo.com") return segments[0] === "video" && /^\d{6,12}$/.test(segments[1] ?? "");
  return false;
}

interface LinkCollector { links: WebLink[]; videos: string[]; seen: Set<string> }

function collectLinks(root: any, base: URL, into: LinkCollector): void {
  const add = (href: string | null | undefined, text: string | undefined, isMedia: boolean) => {
    if (!href) return;
    let url: URL;
    try { url = new URL(href, base); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    url.hash = "";
    const value = url.toString();
    if (isVideoUrl(url) && !into.videos.includes(value) && into.videos.length < MAX_VIDEOS) into.videos.push(value);
    if (isMedia || into.seen.has(value) || value === base.toString() || into.links.length >= MAX_LINKS) return;
    const label = cleanText(text, 120);
    if (!label) return;
    into.seen.add(value);
    into.links.push({ text: label, url: value });
  };
  for (const anchor of root.querySelectorAll("a[href]")) add(anchor.getAttribute("href"), anchor.textContent, false);
  for (const frame of root.querySelectorAll("iframe[src]")) add(frame.getAttribute("src"), undefined, true);
}

function meta(document: any, ...names: string[]): string | undefined {
  for (const name of names) {
    const element = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    const value = cleanText(element?.getAttribute("content"), 300);
    if (value) return value;
  }
  return undefined;
}

function extractHtml(html: string, url: URL): Omit<FetchedPage, "url" | "characters" | "truncated"> {
  const { document } = parseHTML(html);
  const collector: LinkCollector = { links: [], videos: [], seen: new Set() };
  if (isVideoUrl(url)) collector.videos.push(url.toString());
  const canonicalVideo = publicUrl(meta(document, "og:video:url", "og:video:secure_url", "og:video"));
  if (canonicalVideo && isVideoUrl(new URL(canonicalVideo)) && !collector.videos.includes(canonicalVideo)) collector.videos.push(canonicalVideo);
  // Readability mutates the document, so the full page is parsed again for the fallback links below.
  const title = cleanText(document.querySelector("title")?.textContent, 300) ?? meta(document, "og:title");
  const siteName = meta(document, "og:site_name");
  const publishedAt = meta(document, "article:published_time", "og:published_time", "date");
  const description = meta(document, "og:description", "description");
  let article: { title?: string | null; byline?: string | null; excerpt?: string | null; content?: string | null } | null = null;
  try { article = new Readability(document as never, { charThreshold: 200 }).parse(); } catch { article = null; }
  let text = "";
  if (article?.content) {
    const body = parseHTML(`<html><body>${article.content}</body></html>`).document.body;
    // Links in the main content come first; page navigation only fills the remaining slots.
    collectLinks(body, url, collector);
    text = readableText(body);
  }
  const page = parseHTML(html).document;
  collectLinks(page, url, collector);
  if (text.length < 200) {
    for (const element of page.querySelectorAll("script, style, noscript, svg, nav, header, footer, form")) element.remove();
    const body = readableText(page.body ?? page.documentElement);
    if (body.length > text.length) text = body;
  }
  // Pages rendered by JavaScript, such as YouTube, often only describe themselves in metadata.
  if (description && text.length < 500 && !text.includes(description)) text = text ? `${description}\n\n${text}` : description;
  const byline = cleanText(article?.byline, 200);
  const excerpt = cleanText(article?.excerpt, 400) ?? description;
  return {
    ...(cleanText(article?.title, 300) ?? title ? { title: cleanText(article?.title, 300) ?? title } : {}),
    ...(siteName ? { siteName } : {}),
    ...(byline ? { byline } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(excerpt ? { excerpt } : {}),
    text,
    links: collector.links,
    videos: collector.videos,
  };
}

/** Fetches one public web page and extracts readable text. Every hop is checked against the policy, including redirects and DNS answers. */
export async function fetchPage(raw: string, signal?: AbortSignal, policy: FetchPolicy = PUBLIC_WEB): Promise<FetchedPage> {
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let url = targetFor(raw, policy);
  try {
    for (let hop = 0; ; hop += 1) {
      const response = await requestOnce(url, policy, combined);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location) throw new WebToolError("invalid_response", "The site sent a redirect without a destination.");
        if (hop >= MAX_REDIRECTS) throw new WebToolError("invalid_response", "The site redirected too many times.");
        let next: string;
        try { next = new URL(response.location, url).toString(); } catch { throw new WebToolError("invalid_response", "The site sent an invalid redirect."); }
        url = targetFor(next, policy);
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new WebToolError("unavailable", `The site answered with HTTP ${response.status}.`);
      const html = HTML_TYPES.has(response.contentType);
      if (!html && !TEXT_TYPES.has(response.contentType) && response.contentType !== "") {
        throw new WebToolError("unsupported", `The page type ${cleanText(response.contentType, 80) ?? "unknown"} cannot be read as text.`);
      }
      const source = decodeBody(response.body, response.charset, html || response.contentType === "");
      const looksHtml = html || (response.contentType === "" && /<html[\s>]/i.test(source.slice(0, 2_048)));
      const extracted = looksHtml
        ? extractHtml(source, url)
        : { text: source.replace(/\r\n/g, "\n").trim(), links: [], videos: isVideoUrl(url) ? [url.toString()] : [] };
      const characters = extracted.text.length;
      const truncated = characters > MAX_PAGE_CHARACTERS;
      return { url: url.toString(), ...extracted, text: truncated ? extracted.text.slice(0, MAX_PAGE_CHARACTERS) : extracted.text, characters, truncated };
    }
  } catch (error) {
    throw abortReason(error, signal);
  }
}
