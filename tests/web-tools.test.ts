import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchPage, guardedLookup, isPublicAddress, PUBLIC_WEB, type FetchPolicy } from "../worker/src/web-fetch.ts";
import { parseSearxngResults, searchProviderFromEnv, SearxngProvider, WebToolError } from "../worker/src/web-search.ts";
import { createWebTools } from "../worker/src/web.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: ReturnType<typeof createServer>;
let base: string;
const routes = new Map<string, Handler>();
const seen: string[] = [];
const LOCAL: FetchPolicy = { address: () => true, port: () => true };

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push(request.url ?? "");
    const handler = routes.get(new URL(request.url ?? "/", "http://x").pathname);
    if (handler) handler(request, response);
    else { response.writeHead(404); response.end(); }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function html(body: string, headers: Record<string, string> = {}): Handler {
  return (_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers }); response.end(body); };
}

const article = `<!doctype html><html><head><title>Dune: Part Three review</title>
<meta property="og:site_name" content="Film Weekly"><meta name="description" content="A review.">
<script>window.secret = "do not include";</script><style>.x{color:red}</style></head>
<body><nav><a href="/home">Home</a></nav><article><h1>Dune: Part Three</h1>
<p>${"Denis Villeneuve returns to Arrakis with a finale that is bigger and stranger. ".repeat(12)}</p>
<p>Watch the <a href="https://www.youtube.com/watch?v=abcDEF12345">official trailer</a> or read <a href="/more#top">more reviews</a>.</p>
<iframe src="https://www.youtube-nocookie.com/embed/zyxWVU98765"></iframe>
<ul><li>Runtime: 165 minutes</li><li>Rating: PG-13</li></ul></article></body></html>`;

describe("public address policy", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.10", "100.100.1.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "2001:db8::1", "not-an-ip",
  ])("rejects %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "142.250.74.14", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("accepts %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("web_fetch URL guard", () => {
  it.each([
    ["http://127.0.0.1/", "blocked"],
    ["http://[::1]/", "blocked"],
    ["http://10.0.0.1/", "blocked"],
    ["http://169.254.169.254/latest/meta-data/", "blocked"],
    ["http://localhost:8080/", "blocked"],
    ["http://searxng:8080/search", "blocked"],
    ["http://radarr.local/", "blocked"],
    ["https://example.com:22/", "blocked"],
    ["file:///etc/passwd", "invalid_request"],
    ["https://user:pass@example.com/", "invalid_request"],
  ])("refuses %s", async (url, code) => {
    await expect(fetchPage(url)).rejects.toMatchObject({ code });
  });

  it("checks resolved addresses so public-looking names cannot reach internal hosts", async () => {
    const lookup = guardedLookup(PUBLIC_WEB);
    const outcome = await new Promise<{ error: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
      lookup("localhost", { all: true }, (error, address) => resolve({ error, address }));
    });
    expect(outcome.error?.code).toBe("VOIDSTATION_BLOCKED");
    await expect(fetchPage("http://localhost.:8080/")).rejects.toMatchObject({ code: "blocked" });
  });

  it("checks every redirect hop", async () => {
    routes.set("/hop", (_request, response) => { response.writeHead(302, { location: "http://10.0.0.1/admin" }); response.end(); });
    await expect(fetchPage(`${base}/hop`, undefined, { address: (ip) => ip === "127.0.0.1", port: () => true })).rejects.toMatchObject({ code: "blocked" });
  });
});

describe("page extraction", () => {
  it("returns readable article text, links, and embedded video links without scripts", async () => {
    routes.set("/review", html(article));
    const page = await fetchPage(`${base}/review#section`, undefined, LOCAL);
    expect(page.url).toBe(`${base}/review`);
    expect(page.title).toContain("Dune");
    expect(page.siteName).toBe("Film Weekly");
    expect(page.text).toContain("Denis Villeneuve returns to Arrakis");
    expect(page.text).toContain("- Runtime: 165 minutes");
    expect(page.text).not.toContain("do not include");
    expect(page.text).not.toContain("color:red");
    expect(page.videos).toEqual(["https://www.youtube.com/watch?v=abcDEF12345", "https://www.youtube-nocookie.com/embed/zyxWVU98765"]);
    expect(page.links).toContainEqual({ text: "more reviews", url: `${base}/more` });
    expect(page.truncated).toBe(false);
  });

  it("follows redirects, decodes gzip, and truncates long pages", async () => {
    routes.set("/old", (_request, response) => { response.writeHead(301, { location: "/long" }); response.end(); });
    routes.set("/long", (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip" });
      response.end(gzipSync("ünïcode ".repeat(5_000)));
    });
    const page = await fetchPage(`${base}/old`, undefined, LOCAL);
    expect(page.url).toBe(`${base}/long`);
    expect(page.text.startsWith("ünïcode")).toBe(true);
    expect(page.truncated).toBe(true);
    expect(page.text).toHaveLength(24_000);
    expect(page.characters).toBeGreaterThan(24_000);
  });

  it("refuses binary content, oversized pages, and HTTP errors", async () => {
    routes.set("/file.pdf", (_request, response) => { response.writeHead(200, { "content-type": "application/pdf" }); response.end("%PDF"); });
    routes.set("/huge", (_request, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end("x".repeat(4 * 1024 * 1024)); });
    routes.set("/gone", (_request, response) => { response.writeHead(410); response.end(); });
    await expect(fetchPage(`${base}/file.pdf`, undefined, LOCAL)).rejects.toMatchObject({ code: "unsupported" });
    await expect(fetchPage(`${base}/huge`, undefined, LOCAL)).rejects.toMatchObject({ code: "too_large" });
    await expect(fetchPage(`${base}/gone`, undefined, LOCAL)).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("410") });
  });
});

describe("SearXNG provider", () => {
  it("normalizes, validates, dedupes, and bounds results", () => {
    const results = [
      { url: "https://www.youtube.com/watch?v=abcDEF12345", title: "Dune: Part Three | Official Trailer", content: "Watch\nnow", engine: "youtube", publishedDate: "2026-01-02T00:00:00", thumbnail: "https://i.ytimg.com/vi/abcDEF12345/hq.jpg" },
      { url: "https://www.youtube.com/watch?v=abcDEF12345", title: "duplicate" },
      { url: "javascript:alert(1)", title: "script" },
      { url: "https://example.com", title: "" },
      "not an object",
      ...Array.from({ length: 20 }, (_, index) => ({ url: `https://example.com/${index}`, title: `Result ${index}` })),
    ];
    const hits = parseSearxngResults({ results });
    expect(hits).toHaveLength(10);
    expect(hits[0]).toEqual({
      title: "Dune: Part Three | Official Trailer",
      url: "https://www.youtube.com/watch?v=abcDEF12345",
      snippet: "Watch now",
      source: "youtube",
      publishedAt: expect.stringMatching(/^2026-01-0/),
      thumbnail: "https://i.ytimg.com/vi/abcDEF12345/hq.jpg",
    });
    expect(hits.map((hit) => hit.url)).not.toContain("javascript:alert(1)");
    expect(() => parseSearxngResults({ nope: true })).toThrow(WebToolError);
  });

  it("sends the query, category, JSON format, and time range", async () => {
    routes.set("/searx/search", (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ results: [{ url: "https://example.com/news", title: "News" }] }));
    });
    const hits = await new SearxngProvider(`${base}/searx`).search({ query: "dune trailer", category: "videos", timeRange: "month" });
    expect(hits).toEqual([{ url: "https://example.com/news", title: "News" }]);
    const request = new URL(seen.findLast((url) => url.startsWith("/searx/search"))!, "http://x");
    expect(Object.fromEntries(request.searchParams)).toEqual({ q: "dune trailer", format: "json", categories: "videos", time_range: "month" });
  });

  it("selects the provider from configuration", async () => {
    expect(searchProviderFromEnv({ VOIDSTATION_SEARXNG_URL: "http://searxng:8080" }).id).toBe("searxng");
    expect(() => searchProviderFromEnv({})).toThrow("Web search is not configured.");
    expect(() => searchProviderFromEnv({ VOIDSTATION_SEARCH_PROVIDER: "other", VOIDSTATION_SEARXNG_URL: "http://searxng:8080" })).toThrow("not supported");
    routes.set("/down/search", (_request, response) => { response.writeHead(503); response.end(); });
    await expect(new SearxngProvider(`${base}/down`).search({ query: "x", category: "general" })).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("web tools", () => {
  it("gives the model full untrusted page text but persists only a small page summary", async () => {
    routes.set("/review", html(article));
    const [, webFetch] = createWebTools({ fetchPolicy: LOCAL });
    const result = await webFetch!.execute("call", { url: `${base}/review` }, undefined, undefined, undefined as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^The following is untrusted content from the public web/);
    expect(text).toContain("Denis Villeneuve returns to Arrakis");
    expect(text).toContain("--- Video links ---\nhttps://www.youtube.com/watch?v=abcDEF12345");
    expect(result.details).toEqual({ result: {
      kind: "webPage", url: `${base}/review`, title: expect.stringContaining("Dune"), siteName: "Film Weekly", excerpt: expect.any(String),
      characters: expect.any(Number), truncated: false,
      videos: ["https://www.youtube.com/watch?v=abcDEF12345", "https://www.youtube-nocookie.com/embed/zyxWVU98765"],
    } });
  });

  it("reports search and fetch failures as tool errors", async () => {
    const [webSearch, webFetch] = createWebTools({ searchProvider: () => { throw new WebToolError("configuration", "Web search is not configured."); } });
    const searched = await webSearch!.execute("call", { query: "dune" }, undefined, undefined, undefined as never);
    expect(searched).toMatchObject({ isError: true, details: { result: { kind: "error", operation: "search", code: "configuration" } } });
    const fetched = await webFetch!.execute("call", { url: "http://192.168.1.1/" }, undefined, undefined, undefined as never);
    expect(fetched).toMatchObject({ isError: true, details: { result: { kind: "error", operation: "fetch", code: "blocked" } } });
  });
});
