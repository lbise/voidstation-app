import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { assistantServer, type AssistantServer } from "./helpers/assistant-server";
import { fakeMedia, queueRecord, QUEUE_CANARIES, type FakeMedia } from "./helpers/fake-media";
import type { DownloadQueue } from "@/lib/downloads-contract";

let server: AssistantServer;
let session: string;
const downloads = "/api/downloads";

beforeAll(async () => {
  server = await assistantServer();
  session = await server.session();
}, 40_000);
afterAll(async () => { await server?.close(); });

async function withMedia(run: (media: FakeMedia, config: string) => Promise<void>) {
  const media = await fakeMedia();
  try {
    const config = await media.config();
    await run(media, config);
  } finally {
    await server.stopWorker();
    await media.close();
  }
}

async function queue(): Promise<{ response: Response; body: DownloadQueue }> {
  const response = await server.request(downloads, {}, session);
  expect(response.status).toBe(200);
  return { response, body: await response.json() as DownloadQueue };
}

const movie = (id: number, title: string, year: number, overrides: Record<string, unknown> = {}) =>
  queueRecord({ id, downloadId: `RADARR${id}`, movie: { id: id + 100, title, year, tmdbId: 1, path: "/media/movies/secret-path" }, ...overrides });

const episode = (id: number, downloadId: string, season: number, number: number, overrides: Record<string, unknown> = {}) =>
  queueRecord({
    id, downloadId, seasonNumber: season, episodeId: id + 1000,
    series: { id: 22, title: "The Expanse", tvdbId: 281620, path: "/media/series/secret-path" },
    episode: { id: id + 1000, seasonNumber: season, episodeNumber: number, title: "Episode title canary", overview: "overview canary" },
    ...overrides,
  });

it("returns both queues grouped, sorted, and reduced to the projected fields", async () => {
  await withMedia(async (media, config) => {
    media.setQueue("radarr", [
      movie(1, "Dune", 2021, { size: 1_000, sizeleft: 250, estimatedCompletionTime: "2030-01-01T00:30:00Z" }),
      movie(2, "Arrival", 2016, { trackedDownloadState: "importPending", status: "completed", sizeleft: 0, estimatedCompletionTime: "2030-01-01T00:05:00Z" }),
      movie(3, "Tenet", 2020, {
        trackedDownloadStatus: "warning", estimatedCompletionTime: null,
        statusMessages: [{ title: "Tenet.2020.mkv", messages: ["  No files\nfound are\u0000 eligible \u202e  for import  "] }],
      }),
      movie(4, "Heat", 1995, { status: "failed", trackedDownloadState: "failedPending", errorMessage: `<b>${"x".repeat(300)}</b>` }),
      movie(5, "Alien", 1979, { status: "delay", size: 0, sizeleft: 0, estimatedCompletionTime: null }),
      movie(6, "Brazil", 1985, { status: "somethingNew", size: undefined, sizeleft: undefined, estimatedCompletionTime: "not a date" }),
    ]);
    media.setQueue("sonarr", [
      episode(11, "PACK1", 2, 1, { size: 3_000, sizeleft: 1_500, estimatedCompletionTime: "2030-01-01T01:00:00Z" }),
      episode(12, "PACK1", 2, 2, { size: 3_000, sizeleft: 1_500, estimatedCompletionTime: "2030-01-01T01:00:00Z" }),
      episode(13, "PACK1", 2, 3, { size: 3_000, sizeleft: 1_500, estimatedCompletionTime: "2030-01-01T01:00:00Z", trackedDownloadStatus: "warning", statusMessages: [{ title: "The.Expanse.S02E03.mkv", messages: [] }] }),
      episode(14, "EP1", 1, 5, { status: "paused", estimatedCompletionTime: "2030-01-01T00:01:00Z" }),
    ]);
    await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config });

    const { response, body } = await queue();
    // The proxy normalizes every response to "no-store"; the route also sets max-age=0.
    expect(response.headers.get("cache-control")).toContain("no-store");

    expect(body.radarr).toEqual({
      status: "available",
      total: 6,
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      items: [
        { id: "radarr-RADARR4", service: "radarr", title: "Heat (1995)", status: "failed", problem: `<b>${"x".repeat(196)}…`, size: 1_000, sizeLeft: 250, progress: 75, estimatedCompletion: "2030-01-01T00:10:00.000Z" },
        { id: "radarr-RADARR3", service: "radarr", title: "Tenet (2020)", status: "warning", problem: "No files found are eligible for import", size: 1_000, sizeLeft: 250, progress: 75, estimatedCompletion: null },
        { id: "radarr-RADARR2", service: "radarr", title: "Arrival (2016)", status: "importing", problem: null, size: 1_000, sizeLeft: 0, progress: 100, estimatedCompletion: "2030-01-01T00:05:00.000Z" },
        { id: "radarr-RADARR1", service: "radarr", title: "Dune (2021)", status: "downloading", problem: null, size: 1_000, sizeLeft: 250, progress: 75, estimatedCompletion: "2030-01-01T00:30:00.000Z" },
        { id: "radarr-RADARR5", service: "radarr", title: "Alien (1979)", status: "delayed", problem: null, size: 0, sizeLeft: 0, progress: null, estimatedCompletion: null },
        { id: "radarr-RADARR6", service: "radarr", title: "Brazil (1985)", status: "queued", problem: null, size: null, sizeLeft: null, progress: null, estimatedCompletion: null },
      ],
    });
    expect(body.sonarr).toEqual({
      status: "available",
      total: 2,
      observedAt: expect.any(String),
      items: [
        // The pack's worst record decides its status; sizes are not summed.
        { id: "sonarr-PACK1", service: "sonarr", title: "The Expanse · Season 2 (3 episodes)", status: "warning", problem: "The.Expanse.S02E03.mkv", size: 3_000, sizeLeft: 1_500, progress: 50, estimatedCompletion: "2030-01-01T01:00:00.000Z" },
        { id: "sonarr-EP1", service: "sonarr", title: "The Expanse · S01E05", status: "paused", problem: null, size: 1_000, sizeLeft: 250, progress: 75, estimatedCompletion: "2030-01-01T00:01:00.000Z" },
      ],
    });

    const serialized = JSON.stringify(body);
    for (const canary of [...Object.values(QUEUE_CANARIES), media.radarr.key, media.sonarr.key, "secret-path", "canary", "\u202e"]) {
      expect(serialized).not.toContain(canary);
    }
    expect(server.output).not.toContain(media.radarr.key);

    const queueRequests = media.requests.filter((request) => request.path === "/api/v3/queue");
    expect(queueRequests.map(({ service, method, query }) => ({ service, method, query }))).toEqual(expect.arrayContaining([
      { service: "radarr", method: "GET", query: { page: "1", pageSize: "200", includeMovie: "True" } },
      { service: "sonarr", method: "GET", query: { page: "1", pageSize: "200", includeSeries: "True", includeEpisode: "True" } },
    ]));
    expect(media.requests.every((request) => request.method === "GET")).toBe(true);

    // Polling within the cache window does not reach Radarr or Sonarr again.
    const before = media.requests.length;
    const repeated = await Promise.all([queue(), queue()]);
    expect(repeated.map(({ body: next }) => next)).toEqual([body, body]);
    expect(media.requests.length).toBe(before);
  });
}, 40_000);

it("caps each service at 50 items while reporting the whole queue size", async () => {
  await withMedia(async (media, config) => {
    media.setQueue("radarr", Array.from({ length: 250 }, (_, index) => movie(index + 1, `Movie ${index + 1}`, 2000, {
      estimatedCompletionTime: new Date(Date.UTC(2030, 0, 1, 0, 250 - index)).toISOString(),
    })));
    media.setQueue("sonarr", Array.from({ length: 120 }, (_, index) => episode(index + 1, `PACK${Math.floor(index / 2)}`, 1, (index % 2) + 1)));
    await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config });
    const { body } = await queue();
    if (body.radarr.status !== "available" || body.sonarr.status !== "available") throw new Error("Expected both queues.");
    // 200 fetched records plus 50 that were beyond the bounded page.
    expect(body.radarr.total).toBe(250);
    expect(body.radarr.items).toHaveLength(50);
    expect(body.radarr.items[0]?.title).toBe("Movie 200 (2000)");
    const times = body.radarr.items.map((item) => Date.parse(item.estimatedCompletion!));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(body.sonarr.total).toBe(60);
    expect(body.sonarr.items).toHaveLength(50);
    expect(body.sonarr.items[0]?.title).toBe("The Expanse · Season 1 (2 episodes)");
  });
}, 40_000);

it("keeps one service visible when the other fails", async () => {
  await withMedia(async (media, config) => {
    media.setQueue("radarr", [movie(1, "Dune", 2021)]);
    media.setQueueFailure("sonarr", { status: 500, body: { message: "sonarr internal failure canary" } });
    await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config });
    const { body } = await queue();
    expect(body.radarr).toMatchObject({ status: "available", total: 1 });
    expect(body.sonarr).toEqual({ status: "unavailable", reason: "service_unavailable", observedAt: null });
    expect(JSON.stringify(body)).not.toContain("canary");
  });
  await withMedia(async (media, config) => {
    media.setQueueFailure("radarr", { status: 200, body: { records: "not a list" } });
    await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config });
    const { body } = await queue();
    expect(body.radarr).toEqual({ status: "unavailable", reason: "invalid_response", observedAt: null });
    expect(body.sonarr).toMatchObject({ status: "available", items: [], total: 0 });
  });
}, 40_000);

it("reports unconfigured services without hiding a configured one", async () => {
  await withMedia(async (media, config) => {
    media.setQueue("radarr", [movie(1, "Dune", 2021)]);
    const { radarr } = JSON.parse(await readFile(config, "utf8")) as { radarr: unknown };
    await writeFile(config, JSON.stringify({ radarr }));
    await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config });
    const { body } = await queue();
    expect(body.radarr).toMatchObject({ status: "available", total: 1 });
    expect(body.sonarr).toEqual({ status: "unavailable", reason: "not_configured", observedAt: null });
    expect(media.requests.some((request) => request.service === "sonarr")).toBe(false);
  });
  await withMedia(async (media, config) => {
    await rm(config);
    await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config });
    const { body } = await queue();
    expect(body).toEqual({
      radarr: { status: "unavailable", reason: "not_configured", observedAt: null },
      sonarr: { status: "unavailable", reason: "not_configured", observedAt: null },
    });
    expect(media.requests).toEqual([]);
  });
}, 40_000);

it("works without any model provider configured", async () => {
  await withMedia(async (media, config) => {
    media.setQueue("sonarr", [episode(1, "EP1", 3, 7)]);
    await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config, VOIDSTATION_TEST_MODEL_FILE: "" });
    const { body } = await queue();
    expect(body.sonarr).toMatchObject({ status: "available", items: [{ id: "sonarr-EP1", title: "The Expanse · S03E07" }] });
  });
}, 40_000);

it("requires a Dashboard session and fails closed when the worker is unavailable", async () => {
  const anonymous = await server.request(downloads);
  expect(anonymous.status).toBe(401);
  expect(await anonymous.json()).toEqual({ error: "Sign in required." });

  const unavailable = await server.request(downloads, {}, session);
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get("cache-control")).toContain("no-store");
  expect(await unavailable.json()).toEqual({ error: "Download queue unavailable." });

  await withMedia(async (_media, config) => {
    await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config });
    const withoutToken = await server.internal("/media/queue");
    expect(withoutToken.status).toBe(401);
    await withoutToken.body?.cancel();
    const fromBrowser = await server.internal("/media/queue", { authorization: `Bearer ${server.token}`, origin: server.origin });
    expect(fromBrowser.status).toBe(401);
    await fromBrowser.body?.cancel();
    const post = await server.request(downloads, { method: "POST", headers: { origin: server.origin } }, session);
    expect(post.status).toBe(405);
  });
}, 40_000);
