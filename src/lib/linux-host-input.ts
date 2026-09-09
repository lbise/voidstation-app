import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostInput, HostSample } from "./host-metrics";

/** Startup-only configuration. Never derive this directory from an HTTP request. */
const directory = process.env.VOIDSTATION_HOST_PROC ?? "/proc";

async function readSource(name: "uptime" | "meminfo"): Promise<HostSample> {
  // Host files exist only at runtime; never trace deployment inputs into the image.
  const path = join(/* turbopackIgnore: true */ directory, name);
  const text = await readFile(/* turbopackIgnore: true */ path, "utf8");
  return { text, observedAt: new Date().toISOString() };
}

export const linuxHostInput: HostInput = {
  uptime: () => readSource("uptime"),
  memory: () => readSource("meminfo"),
};
