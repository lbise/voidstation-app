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
  toolCalls: { id: string; turnId: string; name: string; parameters: Record<string, unknown>; result: unknown; status: string }[];
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
      { toolCalls: [{ name: "media_find", arguments: { type: "movie", query: "Dune" } }] },
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
      result: { kind: "find", choices: [{ externalId: 438631, title: "Dune", year: 2021, type: "movie" }], library: [] },
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
      { toolCalls: [{ name: "media_find", arguments: { type: "series", query: "The Expanse" } }] },
      { text: "Please choose one of the two series." },
    ], "Find The Expanse");
    expect(result.conversation.mediaResults[0]?.result).toEqual({ kind: "find", choices: [
      { externalId: 281620, title: "The Expanse", year: 2015, type: "series" },
      { externalId: 999999, title: "The Expanse: Origins", year: 2017, type: "series" },
    ], library: [] });
    expect(media.requests).toContainEqual(expect.objectContaining({ service: "sonarr", path: "/api/v3/series/lookup", query: { term: "The Expanse" } }));
    expect(media.requests.some((request) => request.service === "radarr")).toBe(false);
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);

it("lists a large compressed Sonarr library while keeping the tool result to 20 entries", async () => {
  const media = await fakeMedia();
  try {
    const library = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      tvdbId: index + 10_000,
      title: `Series ${index + 1}`,
      monitored: true,
      hasFile: false,
      overview: "x".repeat(5_500),
    }));
    expect(Buffer.byteLength(JSON.stringify(library))).toBeGreaterThan(200_000);
    media.setTracked("sonarr", library);
    const result = await runToolTurn(media, [
      { toolCalls: [{ name: "media_find", arguments: { type: "series" } }] },
      { text: "The library is available." },
    ], "Browse the series library");

    expect(result.conversation.mediaResults[0]?.result).toEqual({
      kind: "find",
      choices: [],
      library: expect.arrayContaining([
        expect.objectContaining({ externalId: 10_000, title: "Series 1", type: "series", libraryId: 1, missing: true }),
        expect.objectContaining({ externalId: 10_019, title: "Series 20", type: "series", libraryId: 20, missing: true }),
      ]),
    });
    const output = result.conversation.mediaResults[0]?.result as { library: unknown[] };
    expect(output.library).toHaveLength(20);
    expect(media.requests).toContainEqual(expect.objectContaining({ service: "sonarr", method: "GET", path: "/api/v3/series" }));
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
        { name: "media_details", arguments: { type: "movie", externalId: 438631 } },
        { name: "media_details", arguments: { type: "series", externalId: 281620 } },
      ] },
      { text: "The movie and series have status evidence." },
    ], "What is Dune's status?");
    expect(result.conversation.mediaResults[0]?.result).toMatchObject({ kind: "details", type: "movie", externalId: 438631, tracked: true, activeDownload: true, available: true });
    expect(result.conversation.mediaResults[1]?.result).toMatchObject({ kind: "details", type: "series", externalId: 281620, tracked: true, activeDownload: false, available: true });
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
      { toolCalls: [{ name: "media_details", arguments: { type: "movie", externalId: 438631 } }] },
      { text: "Dune is tracked but is not downloading." },
    ], "Is Dune downloading?");
    expect(result.conversation.mediaResults[0]?.result).toMatchObject({ kind: "details", tracked: true, activeDownload: false, available: false });
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);

it("rejects skill traversal and keeps shell metacharacters as one lookup value", async () => {
  const media = await fakeMedia();
  try {
    const result = await runToolTurn(media, [
      { toolCalls: [{ name: "media_find", arguments: { type: "movie", query: "Dune; touch /tmp/voidstation-escape" } }] },
      { text: "No unsafe operation was performed." },
    ], "Try an unsafe lookup");
    expect(result.conversation.mediaResults[0]?.result).toMatchObject({ kind: "find" });
    expect(media.requests).toContainEqual(expect.objectContaining({ query: { term: "Dune; touch /tmp/voidstation-escape" } }));
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);

it("configures a resolved title and starts an explicit search through the shared media tools", async () => {
  const media = await fakeMedia();
  try {
    media.setTracked("radarr", [{ id: 12, tmdbId: 438631, title: "Dune", path: "/media/movies/dune", monitored: false, hasFile: false }]);
    const result = await runToolTurn(media, [
      { toolCalls: [{ name: "media_configure", arguments: { type: "movie", externalId: 438631, quality: "4K", monitoring: "all" } }] },
      { toolCalls: [{ name: "media_search", arguments: { type: "movie", externalId: 438631 } }] },
      { text: "Configured the movie and accepted a search." },
    ], "Configure and search for Dune");
    expect(result.conversation.mediaResults[0]?.result).toMatchObject({ kind: "configure", externalId: 438631, created: false, monitored: true, qualityProfileId: 7 });
    expect(result.conversation.mediaResults[1]?.result).toMatchObject({ kind: "search", externalId: 438631, command: "MoviesSearch", commandId: 42 });
    expect(result.conversation.toolCalls.map(({ name, parameters, status }) => ({ name, parameters, status }))).toEqual([
      { name: "media_configure", parameters: { type: "movie", externalId: 438631, quality: "4K", monitoring: "all" }, status: "complete" },
      { name: "media_search", parameters: { type: "movie", externalId: 438631 }, status: "complete" },
    ]);
    expect(media.requests).toContainEqual(expect.objectContaining({ method: "PUT", path: "/api/v3/movie/12" }));
    expect(media.requests).toContainEqual(expect.objectContaining({ method: "POST", path: "/api/v3/command", body: { name: "MoviesSearch", movieIds: [12] } }));
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);

it("keeps series searches inside explicit season and future scopes", async () => {
  const media = await fakeMedia();
  try {
    media.setTracked("sonarr", [{ id: 22, tvdbId: 281620, title: "The Expanse" }]);
    media.setEpisodes("sonarr", [
      { id: 101, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: false, airDateUtc: "2020-01-01T00:00:00Z" },
      { id: 102, seasonNumber: 2, episodeNumber: 1, monitored: true, hasFile: false, airDateUtc: "2999-01-01T00:00:00Z" },
      { id: 103, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: true, airDateUtc: "2999-01-01T00:00:00Z" },
      { id: 104, seasonNumber: 3, episodeNumber: 1, monitored: false, hasFile: false, airDateUtc: "2999-01-01T00:00:00Z" },
    ]);
    const result = await runToolTurn(media, [
      { toolCalls: [
        { name: "media_search", arguments: { type: "series", externalId: 281620 } },
        { name: "media_search", arguments: { type: "series", externalId: 281620, monitoring: "seasons", seasons: [1] } },
        { name: "media_search", arguments: { type: "series", externalId: 281620, monitoring: "future" } },
      ] },
      { text: "Searches stayed within their declared scopes." },
    ], "Search the series safely");
    expect(result.conversation.mediaResults.map(({ result: value }) => value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "error", operation: "search", code: "invalid_request" }),
      expect.objectContaining({ kind: "search", monitoring: "seasons", seasons: [1], command: "EpisodeSearch", episodeCount: 1 }),
      expect.objectContaining({ kind: "search", monitoring: "future", command: "EpisodeSearch", episodeCount: 1 }),
    ]));
    expect(media.requests).toContainEqual(expect.objectContaining({ method: "POST", path: "/api/v3/command", body: { name: "EpisodeSearch", episodeIds: [101] } }));
    expect(media.requests).toContainEqual(expect.objectContaining({ method: "POST", path: "/api/v3/command", body: { name: "EpisodeSearch", episodeIds: [102] } }));
    expect(media.requests.some(({ method, path, body }) => method === "POST" && path === "/api/v3/command" && (body as { name?: string }).name === "SeriesSearch")).toBe(false);
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);

it("rejects season-only inputs for movies", async () => {
  const media = await fakeMedia();
  try {
    const result = await runToolTurn(media, [
      { toolCalls: [
        { name: "media_details", arguments: { type: "movie", externalId: 438631, season: 1 } },
        { name: "media_configure", arguments: { type: "movie", externalId: 438631, monitoring: "seasons", seasons: [1] } },
      ] },
      { text: "Movies do not support season operations." },
    ], "Use seasons for a movie");
    expect(result.conversation.mediaResults.map(({ result: value }) => value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "error", operation: "details", code: "invalid_request", message: "Movies do not have seasons." }),
      expect.objectContaining({ kind: "error", operation: "configure", code: "invalid_request", message: "Movies do not have seasons." }),
    ]));
    expect(media.requests).toEqual([]);
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);

it("reports invalid deployment configuration without contacting either service", async () => {
  const media = await fakeMedia();
  try {
    const config = await media.config();
    await writeFile(config, JSON.stringify({ radarr: {}, sonarr: {} }));
    const result = await runToolTurn(media, [
      { toolCalls: [{ name: "media_details", arguments: { type: "movie", externalId: 438631 } }] },
      { text: "The media configuration is invalid." },
    ], "Check media defaults", config);
    expect(result.conversation.mediaResults[0]?.result).toMatchObject({ kind: "error", operation: "details", code: "configuration" });
    expect(result.conversation.toolCalls[0]).toMatchObject({ name: "media_details", status: "error" });
    expect(media.requests).toEqual([]);
  } finally { await server.stopWorker(); await media.close(); }
}, 30_000);
