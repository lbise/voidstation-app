import type {
  DiskSpace,
  DriveHealth,
  HostMetrics,
  HostStatus,
  LoadAverage,
  Measurement,
  Pressure,
  PressureStall,
  RamUsage,
  SwapUsage,
} from "./metrics-contract";

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

export type PressureResource = "cpu" | "memory" | "io";

/** The sole substitution boundary: fixed host sources and their observation times. */
export interface HostInput {
  /** /proc/stat: aggregate CPU counters and one `cpuN` line per logical CPU. */
  cpu(): Promise<HostSample>;
  uptime(): Promise<HostSample>;
  /** /proc/meminfo: RAM and swap. */
  memory(): Promise<HostSample>;
  /** /proc/loadavg. */
  load(): Promise<HostSample>;
  /** /proc/pressure/{cpu,memory,io}. */
  pressure(resource: PressureResource): Promise<HostSample>;
  /**
   * The JSON file written by the root host-status helper. The sample's observedAt is
   * the read time, used only to judge the helper's own `checkedAt` freshness.
   */
  hostStatus(): Promise<HostSample>;
  rootFilesystem(): Promise<HostFilesystemSample>;
  dataFilesystem(): Promise<HostFilesystemSample>;
}

/** The helper runs every 15 minutes; allow for missed runs before calling it stale. */
export const HOST_STATUS_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** Tolerate small clock differences, never a status from the future. */
export const HOST_STATUS_MAX_FUTURE_MS = 5 * 60 * 1000;
/** Upper bound on the status file; the Linux input refuses anything larger. */
export const HOST_STATUS_MAX_BYTES = 64 * 1024;

type CpuCounters = { total: number; idle: number };
type FilesystemMeasurement = Measurement<DiskSpace, "bytes"> & { filesystemId?: string };

// CPU utilization is an interval measurement. Keep the previous aggregate sample per
// input so tests and deployments can substitute an input without sharing its state.
const previousCpuSamples = new WeakMap<HostInput, CpuCounters>();

type Settled<T> = { ok: true; sample: T } | { ok: false };

async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, sample: await read() };
  } catch {
    return { ok: false };
  }
}

export async function collectHostMetrics(input: HostInput): Promise<HostMetrics> {
  // Read each shared source once per collection. /proc/stat feeds both CPU
  // utilization and the load core count, and /proc/meminfo feeds RAM and swap;
  // a second read would advance the CPU interval baseline.
  const [stat, memory, loadSample, pressure, hostStatus, uptime, rootFilesystem, dataFilesystem] =
    await Promise.all([
      settle(() => input.cpu()),
      settle(() => input.memory()),
      settle(() => input.load()),
      measurePressure(input),
      measureHostStatus(input),
      measure(() => input.uptime(), "seconds", parseUptime),
      measureFilesystem(() => input.rootFilesystem()),
      measureFilesystem(() => input.dataFilesystem()),
    ]);
  const cpu = measureCpu(input, stat);
  const ram = derive(memory, "bytes", parseRam);
  const swap = derive(memory, "bytes", parseSwap);
  const load = measureLoad(loadSample, stat);

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
    swap,
    load,
    pressure,
    rootFilesystem: withoutFilesystemId(rootFilesystem),
    dataFilesystem: withoutFilesystemId(separatedDataFilesystem),
    hostStatus,
  };
}

function measureCpu(input: HostInput, stat: Settled<HostSample>): Measurement<number, "percent"> {
  if (!stat.ok) {
    return unavailable("percent");
  }
  try {
    const sample = stat.sample;
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

function countCores(text: string): number {
  const cores = text.split(/\r?\n/).filter((line) => /^cpu\d+\s/.test(line)).length;
  if (cores < 1) {
    throw new Error("Invalid CPU count");
  }
  return cores;
}

function measureLoad(
  load: Settled<HostSample>,
  stat: Settled<HostSample>,
): Measurement<LoadAverage, "tasks"> {
  if (!load.ok || !stat.ok) {
    return unavailable("tasks");
  }
  try {
    const cores = countCores(stat.sample.text);
    const fields = load.sample.text.trim().split(/\s+/);
    if (fields.length < 3) {
      throw new Error("Invalid load measurement");
    }
    const [one, five, fifteen] = fields.slice(0, 3).map(parseDecimal);
    return {
      status: "available",
      value: { one, five, fifteen, cores },
      unit: "tasks",
      observedAt: load.sample.observedAt,
    };
  } catch {
    return unavailable("tasks");
  }
}

function parseDecimal(text: string): number {
  const value = Number(text);
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid decimal");
  }
  return value;
}

async function measurePressure(input: HostInput): Promise<Measurement<Pressure, "percent">> {
  try {
    // All three resources must parse; a partial pressure reading is unavailable.
    const [cpu, memory, io] = await Promise.all(
      (["cpu", "memory", "io"] as const).map((resource) => input.pressure(resource)),
    );
    const observedAt = [cpu, memory, io]
      .map((sample) => sample.observedAt)
      .reduce((latest, candidate) => (Date.parse(candidate) > Date.parse(latest) ? candidate : latest));
    return {
      status: "available",
      value: { cpu: parseStall(cpu.text), memory: parseStall(memory.text), io: parseStall(io.text) },
      unit: "percent",
      observedAt,
    };
  } catch {
    return unavailable("percent");
  }
}

function parseStall(text: string): PressureStall {
  const match = /^some avg10=(\S+) avg60=(\S+) avg300=\S+ total=\d+$/m.exec(text);
  if (!match) {
    throw new Error("Invalid pressure measurement");
  }
  const [avg10, avg60] = [parseDecimal(match[1]), parseDecimal(match[2])];
  if (avg10 > 100 || avg60 > 100) {
    throw new Error("Invalid pressure measurement");
  }
  return { avg10, avg60 };
}

async function measureHostStatus(input: HostInput): Promise<Measurement<HostStatus, "status">> {
  try {
    const sample = await input.hostStatus();
    const { status, checkedAt } = parseHostStatus(sample.text);
    const readAt = Date.parse(sample.observedAt);
    if (
      !Number.isFinite(readAt) ||
      readAt - checkedAt > HOST_STATUS_MAX_AGE_MS ||
      checkedAt - readAt > HOST_STATUS_MAX_FUTURE_MS
    ) {
      throw new Error("Stale host status");
    }
    return {
      status: "available",
      value: status,
      unit: "status",
      observedAt: new Date(checkedAt).toISOString(),
    };
  } catch {
    // Never expose raw status file contents or parse errors.
    return unavailable("status");
  }
}

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const packageName = /^[A-Za-z0-9][A-Za-z0-9+.:~_-]{0,127}$/;
const deviceName = /^[A-Za-z0-9][A-Za-z0-9_.:,/-]{0,63}$/;
const hostStatusKeys = ["version", "checkedAt", "rebootRequired", "rebootPackages", "updates", "drives"];
const driveKeys = [
  "device", "model", "passed", "standby", "temperatureCelsius", "powerOnHours",
  "reallocatedSectors", "pendingSectors", "mediaErrors", "percentageUsed",
];

function invalidStatus(): never {
  throw new Error("Invalid host status");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nullableCount(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    invalidStatus();
  }
  return value;
}

function parseDrive(value: unknown): DriveHealth {
  if (!isPlainObject(value) || !hasExactKeys(value, driveKeys)) invalidStatus();
  const { device, model, passed, standby, temperatureCelsius } = value;
  if (typeof device !== "string" || !deviceName.test(device)) invalidStatus();
  if (model !== null && (typeof model !== "string" || model.length === 0 || model.length > 128
    || /[\u0000-\u001f\u007f]/.test(model))) invalidStatus();
  if (passed !== null && typeof passed !== "boolean") invalidStatus();
  if (typeof standby !== "boolean") invalidStatus();
  if (temperatureCelsius !== null && (typeof temperatureCelsius !== "number"
    || !Number.isFinite(temperatureCelsius) || temperatureCelsius < -40 || temperatureCelsius > 200)) {
    invalidStatus();
  }
  return {
    device,
    model,
    passed,
    standby,
    temperatureCelsius,
    powerOnHours: nullableCount(value.powerOnHours),
    reallocatedSectors: nullableCount(value.reallocatedSectors),
    pendingSectors: nullableCount(value.pendingSectors),
    mediaErrors: nullableCount(value.mediaErrors),
    // NVMe allows values above 100 up to 255 when rated endurance is exceeded.
    percentageUsed: nullableCount(value.percentageUsed, 255),
  };
}

/** Strictly validates the helper file and rebuilds a fresh value; nothing raw passes through. */
function parseHostStatus(text: string): { status: HostStatus; checkedAt: number } {
  if (text.length > HOST_STATUS_MAX_BYTES) invalidStatus();
  const data: unknown = JSON.parse(text);
  if (!isPlainObject(data) || !hasExactKeys(data, hostStatusKeys) || data.version !== 1) invalidStatus();
  const { checkedAt, rebootRequired, rebootPackages, updates, drives } = data;
  if (typeof checkedAt !== "string" || !isoTimestamp.test(checkedAt)) invalidStatus();
  const checkedAtTime = Date.parse(checkedAt);
  if (!Number.isFinite(checkedAtTime)) invalidStatus();
  if (typeof rebootRequired !== "boolean") invalidStatus();
  if (!Array.isArray(rebootPackages) || rebootPackages.length > 20
    || !rebootPackages.every((name) => typeof name === "string" && packageName.test(name))
    || new Set(rebootPackages).size !== rebootPackages.length) invalidStatus();
  let parsedUpdates: HostStatus["updates"] = null;
  if (updates !== null) {
    if (!isPlainObject(updates) || !hasExactKeys(updates, ["total", "security"])) invalidStatus();
    const total = nullableCount(updates.total, 1_000_000);
    const security = nullableCount(updates.security, 1_000_000);
    if (total === null || security === null || security > total) invalidStatus();
    parsedUpdates = { total, security };
  }
  let parsedDrives: HostStatus["drives"] = null;
  if (drives !== null) {
    if (!Array.isArray(drives) || drives.length > 32) invalidStatus();
    parsedDrives = drives.map(parseDrive);
  }
  return {
    status: {
      rebootRequired,
      rebootPackages: [...rebootPackages] as string[],
      updates: parsedUpdates,
      drives: parsedDrives,
    },
    checkedAt: checkedAtTime,
  };
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

function parseSwap(text: string): SwapUsage {
  const total = Number(/^SwapTotal:\s+(\d+) kB$/m.exec(text)?.[1]) * 1024;
  const free = Number(/^SwapFree:\s+(\d+) kB$/m.exec(text)?.[1]) * 1024;
  // A total of 0 is valid: the Server has no swap configured.
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(free)
    || total < 0 || free < 0 || free > total) {
    throw new Error("Invalid swap measurement");
  }
  return { total, used: total - free };
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

function derive<T, U extends string>(
  settled: Settled<HostSample>,
  unit: U,
  parse: (text: string) => T,
): Measurement<T, U> {
  if (!settled.ok) {
    return unavailable(unit);
  }
  try {
    return { status: "available", value: parse(settled.sample.text), unit, observedAt: settled.sample.observedAt };
  } catch {
    return unavailable(unit);
  }
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
