import { afterAll, beforeAll, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { assistantServer, type AssistantServer } from "./helpers/assistant-server";
import { fakeMedia } from "./helpers/fake-media";

let server: AssistantServer;
let session: string;
const conversations = "/api/assistant/conversations";

type Detail = {
  id: string;
  messages: { id: string; role: string; text: string }[];
  mediaResults: { id: string; turnId: string; result: unknown }[];
  turn: null | { id: string; status: string; error: string | null };
};

async function create(): Promise<Detail> {
  const response = await server.mutate(conversations, "POST", {}, session);
  expect(response.status).toBe(201);
  return await response.json() as Detail;
}

async function detail(id: string): Promise<Detail> {
  const response = await server.request(`${conversations}/${id}`, {}, session);
  expect(response.status).toBe(200);
  return await response.json() as Detail;
}

async function settled(id: string): Promise<Detail> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await detail(id);
    if (current.turn?.status !== "running") return current;
    await delay(30);
  }
  throw new Error("Media turn did not finish.");
}

beforeAll(async () => {
  server = await assistantServer();
  session = await server.session();
}, 40_000);
afterAll(async () => { await server?.close(); });

it("routes an authenticated movie lookup through the approved Radarr tool", async () => {
  const media = await fakeMedia();
  try {
    const config = await media.config();
    await server.fixture([
      { toolCalls: [{ name: "read_skill", arguments: { service: "radarr", resource: "SKILL.md" } }] },
      { toolCalls: [{ name: "media_lookup", arguments: { type: "movie", query: "Dune" } }] },
      { text: "Dune (2021) is a movie result." },
    ]);
    await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config });
    const conversation = await create();
    const accepted = await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Find Dune" }, session);
    expect(accepted.status).toBe(202);
    const turn = await accepted.json() as { id: string };

    const complete = await settled(conversation.id);
    expect(complete.turn).toMatchObject({ status: "complete", error: null });
    expect(complete.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Find Dune" },
      { role: "assistant", text: "Dune (2021) is a movie result." },
    ]);
    expect(complete.mediaResults).toEqual([{
      id: expect.any(String),
      turnId: turn.id,
      result: { kind: "lookup", choices: [{ externalId: 438631, title: "Dune", year: 2021, type: "movie" }] },
    }]);
    expect(media.requests).toContainEqual(expect.objectContaining({
      service: "radarr",
      method: "GET",
      path: "/api/v3/movie/lookup",
      query: { term: "Dune" },
    }));
    expect(media.requests.some((request) => request.service === "sonarr")).toBe(false);
  } finally {
    await server.stopWorker();
    await media.close();
  }
}, 30_000);

async function runToolTurn(media: Awaited<ReturnType<typeof fakeMedia>>, steps: { toolCalls?: { name: string; arguments: Record<string, unknown> }[]; text?: string }[], request: string, configPath?: string) {
  const config = configPath ?? await media.config();
  await server.fixture(steps);
  await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config });
  const conversation = await create();
  const accepted = await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: request }, session);
  expect(accepted.status).toBe(202);
  return { conversation: await settled(conversation.id), id: conversation.id };
}

it("keeps ambiguous lookup results explicit and routes series lookups to Sonarr", async () => {
  const media = await fakeMedia();
  try {
    media.setLookup("sonarr", [
      { title: "The Expanse", year: 2015, tvdbId: 281620 },
      { title: "The Expanse: Origins", year: 2017, tvdbId: 999999 },
    ]);
    const result = await runToolTurn(media, [
      { toolCalls: [{ name: "media_lookup", arguments: { type: "series", query: "The Expanse" } }] },
      { text: "Please choose one of the two series." },
    ], "Find The Expanse");
    expect(result.conversation.mediaResults[0]?.result).toEqual({ kind: "lookup", choices: [
      { externalId: 281620, title: "The Expanse", year: 2015, type: "series" },
      { externalId: 999999, title: "The Expanse: Origins", year: 2017, type: "series" },
    ] });
    expect(media.requests).toContainEqual(expect.objectContaining({ service: "sonarr", path: "/api/v3/series/lookup", query: { term: "The Expanse" } }));
    expect(media.requests.some((request) => request.service === "radarr")).toBe(false);
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);

it("reports service-backed status evidence without exposing credentials", async () => {
  const media = await fakeMedia();
  try {
    media.setTracked("radarr", [{ id: 12, tmdbId: 438631, hasFile: true }]);
    media.setQueue("radarr", [{ id: 1, movie: { id: 12 }, status: "downloading" }]);
    media.setTracked("sonarr", [{ id: 22, tvdbId: 281620, statistics: { episodeFileCount: 3 } }]);
    const result = await runToolTurn(media, [
      { toolCalls: [
        { name: "media_status", arguments: { type: "movie", externalId: 438631 } },
        { name: "media_status", arguments: { type: "series", externalId: 281620 } },
      ] },
      { text: "The movie and series have status evidence." },
    ], "What is Dune's status?");
    expect(result.conversation.mediaResults[0]?.result).toEqual({ kind: "status", type: "movie", externalId: 438631, tracked: true, activeDownload: true, available: true });
    expect(result.conversation.mediaResults[1]?.result).toEqual({ kind: "status", type: "series", externalId: 281620, tracked: true, activeDownload: false, available: true });
    expect(JSON.stringify(result.conversation)).not.toContain(media.radarr.key);
    expect(server.output).not.toContain(media.radarr.key);
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);

it("does not attribute another title's queue item to the requested title", async () => {
  const media = await fakeMedia();
  try {
    media.setTracked("radarr", [{ id: 12, tmdbId: 438631, hasFile: false }]);
    media.setQueue("radarr", [
      { id: 2, movie: { id: 999 }, status: "downloading" },
      { id: 3, movie: { id: 12 }, status: "warning" },
    ]);
    const result = await runToolTurn(media, [
      { toolCalls: [{ name: "media_status", arguments: { type: "movie", externalId: 438631 } }] },
      { text: "Dune is tracked but is not downloading." },
    ], "Is Dune downloading?");
    expect(result.conversation.mediaResults[0]?.result).toMatchObject({ kind: "status", tracked: true, activeDownload: false, available: false });
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);

it("rejects skill traversal and keeps shell metacharacters as one lookup value", async () => {
  const media = await fakeMedia();
  try {
    const result = await runToolTurn(media, [
      { toolCalls: [{ name: "read_skill", arguments: { service: "radarr", resource: "../SKILL.md" } }] },
      { toolCalls: [{ name: "media_lookup", arguments: { type: "movie", query: "Dune; touch /tmp/voidstation-escape" } }] },
      { text: "No unsafe operation was performed." },
    ], "Try an unsafe lookup");
    expect(result.conversation.mediaResults[0]?.result).toMatchObject({ kind: "error", operation: "read_skill", code: "invalid_request" });
    expect(result.conversation.mediaResults[1]?.result).toMatchObject({ kind: "lookup" });
    expect(media.requests).toContainEqual(expect.objectContaining({ query: { term: "Dune; touch /tmp/voidstation-escape" } }));
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);

it("reports invalid deployment configuration without contacting either service", async () => {
  const media = await fakeMedia();
  try {
    const config = await media.config();
    await writeFile(config, JSON.stringify({ radarr: {}, sonarr: {} }));
    const result = await runToolTurn(media, [
      { toolCalls: [{ name: "media_discover", arguments: { type: "movie" } }] },
      { text: "The media configuration is invalid." },
    ], "Check media defaults", config);
    expect(result.conversation.mediaResults[0]?.result).toMatchObject({ kind: "error", operation: "discovery", code: "configuration" });
    expect(media.requests).toEqual([]);
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);
