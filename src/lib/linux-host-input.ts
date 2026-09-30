import { constants } from "node:fs";
import { open, readFile, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import {
  HOST_STATUS_MAX_BYTES,
  type HostFilesystemSample,
  type HostInput,
  type HostSample,
  type PressureResource,
} from "./host-metrics";

/** Startup-only configuration. Never derive these paths from an HTTP request. */
const procDirectory = process.env.VOIDSTATION_HOST_PROC ?? "/proc";
const rootFilesystemPath = process.env.VOIDSTATION_HOST_ROOT_FS ?? "/";
const dataFilesystemPath = process.env.VOIDSTATION_HOST_DATA_FS ?? "/host/filesystems/data";
/** A file inside a read-only mount of the root helper's output directory. */
const hostStatusPath = process.env.VOIDSTATION_HOST_STATUS ?? "/host/status/status.json";

type ProcSource = "stat" | "uptime" | "meminfo" | "loadavg" | `pressure/${PressureResource}`;

async function readSource(filename: ProcSource): Promise<HostSample> {
  // Host files exist only at runtime; never trace deployment inputs into the image.
  const path = join(/* turbopackIgnore: true */ procDirectory, filename);
  const text = await readFile(/* turbopackIgnore: true */ path, "utf8");
  return { text, observedAt: new Date().toISOString() };
}

/**
 * Reads the helper's status file without following a final symbolic link, blocking
 * on a FIFO, or reading more than the size limit.
 */
async function readHostStatus(): Promise<HostSample> {
  const handle = await open(
    /* turbopackIgnore: true */ hostStatusPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const identity = await handle.stat();
    if (!identity.isFile() || identity.size > HOST_STATUS_MAX_BYTES) {
      throw new Error("Host status is not a small regular file");
    }
    const buffer = Buffer.alloc(HOST_STATUS_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > HOST_STATUS_MAX_BYTES) {
      throw new Error("Host status exceeds its size limit");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    return { text, observedAt: new Date().toISOString() };
  } finally {
    await handle.close();
  }
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
  cpu: () => readSource("stat"),
  uptime: () => readSource("uptime"),
  memory: () => readSource("meminfo"),
  load: () => readSource("loadavg"),
  pressure: (resource) => readSource(`pressure/${resource}`),
  hostStatus: readHostStatus,
  rootFilesystem: () => readFilesystem(rootFilesystemPath),
  dataFilesystem: () => readFilesystem(dataFilesystemPath),
};
