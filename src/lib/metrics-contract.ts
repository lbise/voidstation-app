export type Measurement<T, U extends string> =
  | { status: "available"; value: T; unit: U; observedAt: string }
  | { status: "unavailable"; value: null; unit: U; observedAt: null };

export type RamUsage = { used: number; available: number; total: number };
export type DiskSpace = { used: number; available: number; total: number };
/** A total of 0 means the Server has no swap configured. */
export type SwapUsage = { used: number; total: number };
/** Run-queue load averages from /proc/loadavg, with the Server's logical CPU count. */
export type LoadAverage = { one: number; five: number; fifteen: number; cores: number };
/** Pressure stall "some" percentages: share of time at least one task waited on the resource. */
export type PressureStall = { avg10: number; avg60: number };
export type Pressure = { cpu: PressureStall; memory: PressureStall; io: PressureStall };

export type DriveHealth = {
  /** Kernel device name, e.g. "sda" or "nvme0n1". */
  device: string;
  model: string | null;
  /** SMART overall assessment; null when the drive was asleep or did not report it. */
  passed: boolean | null;
  /** True when the drive was in standby and was deliberately not woken. */
  standby: boolean;
  temperatureCelsius: number | null;
  powerOnHours: number | null;
  /** ATA reallocated sectors; null for drives that do not report it. */
  reallocatedSectors: number | null;
  /** ATA current pending sectors; null for drives that do not report it. */
  pendingSectors: number | null;
  /** NVMe media and data integrity errors; null for drives that do not report it. */
  mediaErrors: number | null;
  /** NVMe percentage of rated endurance used; null for drives that do not report it. */
  percentageUsed: number | null;
};

/**
 * Written by the root host-status helper on a timer. `observedAt` on the measurement is
 * the helper's check time, not the request time.
 */
export type HostStatus = {
  rebootRequired: boolean;
  /** Packages that asked for the reboot, at most 20. */
  rebootPackages: string[];
  /** null when the helper could not count pending updates. */
  updates: { total: number; security: number } | null;
  /** null when SMART is unavailable on the Server (e.g. smartmontools not installed). */
  drives: DriveHealth[] | null;
};

export interface HostMetrics {
  cpu: Measurement<number, "percent">;
  uptime: Measurement<number, "seconds">;
  ram: Measurement<RamUsage, "bytes">;
  swap: Measurement<SwapUsage, "bytes">;
  load: Measurement<LoadAverage, "tasks">;
  pressure: Measurement<Pressure, "percent">;
  rootFilesystem: Measurement<DiskSpace, "bytes">;
  dataFilesystem: Measurement<DiskSpace, "bytes">;
  hostStatus: Measurement<HostStatus, "status">;
}
