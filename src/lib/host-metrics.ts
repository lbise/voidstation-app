import type { DiskSpace, HostMetrics, Measurement, RamUsage } from "./metrics-contract";

export interface HostSample {
  text: string;
  observedAt: string;
}

export interface HostFilesystemSample {
  filesystemId: string;
  totalBytes: number;
  freeBytes: number;
  availableBytes: number;
  observedAt: string;
}

/** The sole substitution boundary: fixed host sources and their observation times. */
export interface HostInput {
  cpu(): Promise<HostSample>;
  uptime(): Promise<HostSample>;
  memory(): Promise<HostSample>;
  rootFilesystem(): Promise<HostFilesystemSample>;
  dataFilesystem(): Promise<HostFilesystemSample>;
}

type CpuCounters = { total: number; idle: number };
type FilesystemMeasurement = Measurement<DiskSpace, "bytes"> & { filesystemId?: string };

// CPU utilization is an interval measurement. Keep the previous aggregate sample per
// input so tests and deployments can substitute an input without sharing its state.
const previousCpuSamples = new WeakMap<HostInput, CpuCounters>();

export async function collectHostMetrics(input: HostInput): Promise<HostMetrics> {
  const [cpu, uptime, ram, rootFilesystem, dataFilesystem] = await Promise.all([
    measureCpu(input),
    measure(input.uptime, "seconds", parseUptime),
    measure(input.memory, "bytes", parseRam),
    measureFilesystem(input.rootFilesystem),
    measureFilesystem(input.dataFilesystem),
  ]);

  const separatedDataFilesystem =
    rootFilesystem.status === "available" &&
    dataFilesystem.status === "available" &&
    rootFilesystem.filesystemId === dataFilesystem.filesystemId
      ? unavailable("bytes")
      : dataFilesystem;

  return {
    cpu,
    uptime,
    ram,
    rootFilesystem: withoutFilesystemId(rootFilesystem),
    dataFilesystem: withoutFilesystemId(separatedDataFilesystem),
  };
}

async function measureCpu(input: HostInput): Promise<Measurement<number, "percent">> {
  try {
    const sample = await input.cpu();
    const current = parseCpu(sample.text);
    const previous = previousCpuSamples.get(input);
    previousCpuSamples.set(input, current);

    if (!previous) {
      return unavailable("percent");
    }

    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    if (
      !Number.isSafeInteger(totalDelta) ||
      !Number.isSafeInteger(idleDelta) ||
      totalDelta <= 0 ||
      idleDelta < 0 ||
      idleDelta > totalDelta
    ) {
      return unavailable("percent");
    }

    const value = ((totalDelta - idleDelta) / totalDelta) * 100;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return unavailable("percent");
    }

    return { status: "available", value, unit: "percent", observedAt: sample.observedAt };
  } catch {
    return unavailable("percent");
  }
}

function parseCpu(text: string): CpuCounters {
  const line = text.split(/\r?\n/).find((candidate) => /^cpu(?:\s|$)/.test(candidate));
  const fields = line?.trim().split(/\s+/).slice(1) ?? [];
  if (fields.length < 4) {
    throw new Error("Invalid CPU measurement");
  }

  const counters = fields.map((field) => {
    if (!/^\d+$/.test(field)) {
      throw new Error("Invalid CPU measurement");
    }
    const value = Number(field);
    if (!Number.isSafeInteger(value)) {
      throw new Error("Invalid CPU measurement");
    }
    return value;
  });
  // guest and guest_nice (columns 9 and 10) are already included in user and
  // nice by Linux, so exclude them from total time to avoid double counting.
  const total = counters.slice(0, 8).reduce((sum, value) => sum + value, 0);
  const idle = counters[3] + (counters[4] ?? 0);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(idle) || idle > total) {
    throw new Error("Invalid CPU measurement");
  }
  return { total, idle };
}

function parseUptime(text: string): number {
  const seconds = text.trim().split(/\s+/)[0];
  const value = Number(seconds);
  if (!/^\d+(?:\.\d+)?$/.test(seconds) || !Number.isFinite(value)
    || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid Uptime measurement");
  }
  return value;
}

function parseRam(text: string): RamUsage {
  const total = Number(/^MemTotal:\s+(\d+) kB$/m.exec(text)?.[1]) * 1024;
  const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(text)?.[1]) * 1024;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(available)
    || total <= 0 || available < 0 || available > total) {
    throw new Error("Invalid memory measurement");
  }
  return { total, available, used: total - available };
}

async function measureFilesystem(
  read: () => Promise<HostFilesystemSample>,
): Promise<FilesystemMeasurement> {
  try {
    const sample = await read();
    const { filesystemId, totalBytes, freeBytes, availableBytes } = sample;
    if (
      typeof filesystemId !== "string" ||
      filesystemId.length === 0 ||
      !isByteCount(totalBytes) ||
      !isByteCount(freeBytes) ||
      !isByteCount(availableBytes) ||
      totalBytes <= 0 ||
      freeBytes > totalBytes ||
      availableBytes > freeBytes
    ) {
      throw new Error("Invalid filesystem measurement");
    }
    return {
      status: "available",
      value: { total: totalBytes, available: availableBytes, used: totalBytes - freeBytes },
      unit: "bytes",
      observedAt: sample.observedAt,
      filesystemId,
    };
  } catch {
    return unavailable("bytes");
  }
}

function isByteCount(value: number): value is number {
  return Number.isSafeInteger(value) && value >= 0;
}

function unavailable<U extends string>(unit: U): Measurement<never, U> {
  return { status: "unavailable", value: null, unit, observedAt: null };
}

function withoutFilesystemId(
  measurement: FilesystemMeasurement,
): Measurement<DiskSpace, "bytes"> {
  if (measurement.status === "unavailable") {
    return measurement;
  }
  const { filesystemId: _filesystemId, ...publicMeasurement } = measurement;
  return publicMeasurement;
}

async function measure<T, U extends string>(
  read: () => Promise<HostSample>,
  unit: U,
  parse: (text: string) => T,
): Promise<Measurement<T, U>> {
  try {
    const sample = await read();
    return { status: "available", value: parse(sample.text), unit, observedAt: sample.observedAt };
  } catch {
    // Failure details and raw host inputs never cross the public boundary.
    return unavailable(unit);
  }
}
