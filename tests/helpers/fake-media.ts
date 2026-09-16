import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type MediaService = "radarr" | "sonarr";

export interface MediaRequest {
  service: MediaService;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface ServiceFixture {
  lookup: unknown[];
  tracked: unknown[];
  rootFolders: unknown[];
  qualityProfiles: unknown[];
  queue: unknown[];
}

export interface FakeMedia {
  readonly directory: string;
  readonly requests: MediaRequest[];
  readonly radarr: { endpoint: string; key: string };
  readonly sonarr: { endpoint: string; key: string };
  config(): Promise<string>;
  setLookup(service: MediaService, values: unknown[]): void;
  setTracked(service: MediaService, values: unknown[]): void;
  setQueue(service: MediaService, values: unknown[]): void;
  close(): Promise<void>;
}

const fixtures: Record<MediaService, ServiceFixture> = {
  radarr: {
    lookup: [{ title: "Dune", year: 2021, tmdbId: 438631, titleSlug: "dune-2021" }],
    tracked: [],
    rootFolders: [{ id: 1, path: "/media/movies" }],
    qualityProfiles: [{ id: 4, name: "HD-1080p" }, { id: 7, name: "Ultra-HD" }],
    queue: [],
  },
  sonarr: {
    lookup: [{ title: "The Expanse", year: 2015, tvdbId: 281620, titleSlug: "the-expanse" }],
    tracked: [],
    rootFolders: [{ id: 2, path: "/media/series" }],
    qualityProfiles: [{ id: 5, name: "HD-1080p" }, { id: 9, name: "Ultra-HD" }],
    queue: [],
  },
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function startService(service: MediaService, requests: MediaRequest[]) {
  const fixture = structuredClone(fixtures[service]);
  const key = `${service}-test-key-canary`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://media.test");
    requests.push({
      service,
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body: await readBody(request),
    });
    if (request.headers["x-api-key"] !== key) return send(response, 401, { message: "Unauthorized" });
    const prefix = "/api/v3";
    const resource = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    if (request.method === "GET" && resource.endsWith("/lookup")) return send(response, 200, fixture.lookup);
    if (request.method === "GET" && (resource === "/movie" || resource === "/series")) return send(response, 200, fixture.tracked);
    if (request.method === "GET" && resource === "/rootfolder") return send(response, 200, fixture.rootFolders);
    if (request.method === "GET" && resource === "/qualityprofile") return send(response, 200, fixture.qualityProfiles);
    if (request.method === "GET" && resource === "/queue") return send(response, 200, { records: fixture.queue });
    return send(response, 404, { message: "Not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake media service did not bind a TCP port.");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    key,
    setLookup(values: unknown[]) { fixture.lookup = values; },
    setTracked(values: unknown[]) { fixture.tracked = values; },
    setQueue(values: unknown[]) { fixture.queue = values; },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function fakeMedia(): Promise<FakeMedia> {
  const directory = await mkdtemp(join(tmpdir(), "voidstation-fake-media-"));
  const requests: MediaRequest[] = [];
  const [radarr, sonarr] = await Promise.all([startService("radarr", requests), startService("sonarr", requests)]);
  return {
    directory,
    requests,
    radarr,
    sonarr,
    async config() {
      const radarrKey = join(directory, "radarr-key");
      const sonarrKey = join(directory, "sonarr-key");
      const path = join(directory, "media.json");
      await Promise.all([
        writeFile(radarrKey, `${radarr.key}\n`, { mode: 0o600 }),
        writeFile(sonarrKey, `${sonarr.key}\n`, { mode: 0o600 }),
      ]);
      await writeFile(path, JSON.stringify({
        radarr: {
          endpoint: radarr.endpoint,
          keyFile: radarrKey,
          rootFolder: "/media/movies",
          defaultQualityProfileId: 4,
          qualityMappings: { "4K": 7 },
        },
        sonarr: {
          endpoint: sonarr.endpoint,
          keyFile: sonarrKey,
          rootFolder: "/media/series",
          defaultQualityProfileId: 5,
          qualityMappings: { "4K": 9 },
        },
      }), { mode: 0o600 });
      return path;
    },
    setLookup(service, values) { (service === "radarr" ? radarr : sonarr).setLookup(values); },
    setTracked(service, values) { (service === "radarr" ? radarr : sonarr).setTracked(values); },
    setQueue(service, values) { (service === "radarr" ? radarr : sonarr).setQueue(values); },
    async close() {
      await Promise.all([radarr.close(), sonarr.close()]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
