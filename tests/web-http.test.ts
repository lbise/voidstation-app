import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assistantServer, type AssistantServer } from "./helpers/assistant-server";

let server: AssistantServer;
let session: string;
let searxng: ReturnType<typeof createServer>;
let searxngUrl: string;
const searches: URLSearchParams[] = [];
const conversations = "/api/assistant/conversations";

type Detail = {
  messages: { role: string; text: string }[];
  toolCalls: { name: string; parameters: Record<string, unknown>; result: unknown; status: string }[];
  turn: null | { status: string; error: string | null };
};

async function settled(id: string): Promise<Detail> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await server.request(`${conversations}/${id}`, {}, session);
    const current = await response.json() as Detail;
    if (current.turn?.status !== "running") return current;
    await delay(30);
  }
  throw new Error("Web turn did not finish.");
}

beforeAll(async () => {
  searxng = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://searxng");
    searches.push(url.searchParams);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ query: url.searchParams.get("q"), results: [
      { url: "https://www.youtube.com/watch?v=abcDEF12345", title: "Dune: Part Three | Official Trailer", content: "The official trailer.", engine: "youtube" },
    ] }));
  }).listen(0, "127.0.0.1");
  await once(searxng, "listening");
  searxngUrl = `http://127.0.0.1:${(searxng.address() as AddressInfo).port}`;
  server = await assistantServer();
  session = await server.session();
}, 40_000);

afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve) => searxng.close(() => resolve()));
});

it("searches through SearXNG, refuses internal fetches, and records both tool calls", async () => {
  const assertions = join(server.directory, "web-model-assertions.jsonl");
  await server.fixture([
    { toolCalls: [
      { name: "web_search", arguments: { query: "Dune Part Three trailer", category: "videos" } },
      { name: "web_fetch", arguments: { url: "http://127.0.0.1/admin" } },
    ] },
    { text: "Here is the trailer:\n\n[Dune: Part Three | Official Trailer](https://www.youtube.com/watch?v=abcDEF12345)" },
  ]);
  await server.startWorker({ VOIDSTATION_SEARXNG_URL: searxngUrl, VOIDSTATION_TEST_ASSERTIONS_FILE: assertions });
  try {
    const created = await server.mutate(conversations, "POST", {}, session);
    const conversation = await created.json() as { id: string };
    const accepted = await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Find the Dune Part Three trailer" }, session);
    expect(accepted.status).toBe(202);

    const complete = await settled(conversation.id);
    expect(complete.turn).toMatchObject({ status: "complete", error: null });
    expect(searches).toHaveLength(1);
    expect(Object.fromEntries(searches[0]!)).toEqual({ q: "Dune Part Three trailer", format: "json", categories: "videos" });
    // Both tools run in parallel, so completion order is not fixed.
    expect([...complete.toolCalls].sort((a, b) => b.name.localeCompare(a.name))).toEqual([
      {
        id: expect.any(String), turnId: expect.any(String), name: "web_search", status: "complete",
        parameters: { query: "Dune Part Three trailer", category: "videos" },
        result: { kind: "webSearch", query: "Dune Part Three trailer", category: "videos", results: [
          { url: "https://www.youtube.com/watch?v=abcDEF12345", title: "Dune: Part Three | Official Trailer", snippet: "The official trailer.", source: "youtube" },
        ] },
      },
      {
        id: expect.any(String), turnId: expect.any(String), name: "web_fetch", status: "error",
        parameters: { url: "http://127.0.0.1/admin" },
        result: { kind: "error", operation: "fetch", code: "blocked", message: expect.any(String) },
      },
    ]);
    expect(complete.messages.at(-1)?.text).toContain("https://www.youtube.com/watch?v=abcDEF12345");

    const contexts = (await readFile(assertions, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tools: string[]; systemPrompt: string; messages: string[] });
    expect(contexts[0]!.tools).toEqual(["media_find", "media_details", "media_configure", "media_search", "web_search", "web_fetch"]);
    expect(contexts[0]!.systemPrompt).toContain("untrusted");
    expect(contexts[1]!.messages.join("\n")).toContain("untrusted content from the public web");
  } finally {
    await server.stopWorker();
  }
}, 30_000);
