export type Measurement<T, U extends string> =
  | { status: "available"; value: T; unit: U; observedAt: string }
  | { status: "unavailable"; value: null; unit: U; observedAt: null };

export type RamUsage = { used: number; available: number; total: number };

export interface HostMetrics {
  uptime: Measurement<number, "seconds">;
  ram: Measurement<RamUsage, "bytes">;
}
