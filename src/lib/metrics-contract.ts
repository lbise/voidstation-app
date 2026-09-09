export type Measurement<T, U extends string> =
  | { status: "available"; value: T; unit: U; observedAt: string }
  | { status: "unavailable"; value: null; unit: U; observedAt: null };

export type RamUsage = { used: number; available: number; total: number };
export type DiskSpace = { used: number; available: number; total: number };

export interface HostMetrics {
  cpu: Measurement<number, "percent">;
  uptime: Measurement<number, "seconds">;
  ram: Measurement<RamUsage, "bytes">;
  rootFilesystem: Measurement<DiskSpace, "bytes">;
  dataFilesystem: Measurement<DiskSpace, "bytes">;
}
