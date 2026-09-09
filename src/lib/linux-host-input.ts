import { readFile, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { HostFilesystemSample, HostInput, HostSample } from "./host-metrics";

/** Startup-only configuration. Never derive these paths from an HTTP request. */
const procDirectory = process.env.VOIDSTATION_HOST_PROC ?? "/proc";
const rootFilesystemPath = process.env.VOIDSTATION_HOST_ROOT_FS ?? "/";
const dataFilesystemPath = process.env.VOIDSTATION_HOST_DATA_FS ?? "/host/filesystems/data";

async function readSource(name: "cpu" | "uptime" | "meminfo"): Promise<HostSample> {
  // Host files exist only at runtime; never trace deployment inputs into the image.
  const filename = name === "cpu" ? "stat" : name;
  const path = join(/* turbopackIgnore: true */ procDirectory, filename);
  const text = await readFile(/* turbopackIgnore: true */ path, "utf8");
  return { text, observedAt: new Date().toISOString() };
}

async function readFilesystem(path: string): Promise<HostFilesystemSample> {
  const [filesystem, identity] = await Promise.all([
    statfs(/* turbopackIgnore: true */ path, { bigint: true }),
    stat(/* turbopackIgnore: true */ path, { bigint: true }),
  ]);
  const blockSize = filesystem.bsize;
  return {
    filesystemId: identity.dev.toString(),
    totalBytes: toSafeNumber(filesystem.blocks * blockSize),
    freeBytes: toSafeNumber(filesystem.bfree * blockSize),
    availableBytes: toSafeNumber(filesystem.bavail * blockSize),
    observedAt: new Date().toISOString(),
  };
}

function toSafeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("Filesystem capacity is outside the supported range");
  }
  return number;
}

export const linuxHostInput: HostInput = {
  cpu: () => readSource("cpu"),
  uptime: () => readSource("uptime"),
  memory: () => readSource("meminfo"),
  rootFilesystem: () => readFilesystem(rootFilesystemPath),
  dataFilesystem: () => readFilesystem(dataFilesystemPath),
};
