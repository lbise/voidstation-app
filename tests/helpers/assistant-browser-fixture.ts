// Local browser verification only. Uses temporary owner credentials and Pi model fixtures.
import { mkdir, writeFile } from "node:fs/promises";
import { assistantServer } from "./assistant-server.ts";

const server = await assistantServer();
try {
  await server.fixture([{ text: "This conversation is saved. You can resume it on another device.", delayMs: 1500 }]);
  await server.startWorker();
} catch (error) {
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
  await server.close();
  process.exit(0);
}
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
