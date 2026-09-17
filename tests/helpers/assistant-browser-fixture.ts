// Local browser verification only. Uses temporary owner credentials and Pi model fixtures.
import { mkdir, writeFile } from "node:fs/promises";
import { assistantServer } from "./assistant-server.ts";
import { fakeMedia } from "./fake-media.ts";

const server = await assistantServer();
const media = await fakeMedia();
try {
  const config = await media.config();
  media.setTracked("radarr", [{ id: 12, tmdbId: 438631, hasFile: true }]);
  media.setQueue("radarr", [{ id: 1, movie: { id: 12 }, status: "downloading" }]);
  await server.fixture([
    { toolCalls: [{ name: "media_find", arguments: { type: "movie", query: "Dune" } }] },
    { toolCalls: [{ name: "media_details", arguments: { type: "movie", externalId: 438631 } }] },
    { text: "Dune is tracked, downloading, and available.", delayMs: 500 },
    { toolCalls: [{ name: "media_details", arguments: { type: "movie", externalId: 999999 } }] },
    { text: "I could not find that title in the managed library.", delayMs: 500 },
  ]);
  await server.startWorker({ VOIDSTATION_MEDIA_CONFIG_FILE: config });
} catch (error) {
  await media.close();
  await server.close();
  throw error;
}
await mkdir("artifacts/assistant", { recursive: true });
await writeFile("artifacts/assistant/browser-fixture.json", JSON.stringify({
  origin: server.origin, directory: server.directory, password: server.password,
}, null, 2));
console.log(`Browser fixture ready at ${server.origin}. Temporary fixture details are in artifacts/assistant/browser-fixture.json.`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.stopWorker();
  await media.close();
  await server.close();
  process.exit(0);
}
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
