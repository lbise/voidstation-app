import type { HostMetrics, Measurement, RamUsage } from "./metrics-contract";

export interface HostSample {
  text: string;
  observedAt: string;
}

/** The sole substitution boundary: fixed host sources and their observation times. */
export interface HostInput {
  uptime(): Promise<HostSample>;
  memory(): Promise<HostSample>;
}

export async function collectHostMetrics(input: HostInput): Promise<HostMetrics> {
  const [uptime, ram] = await Promise.all([
    measure(input.uptime, "seconds", (text) => {
      const seconds = text.trim().split(/\s+/)[0];
      const value = Number(seconds);
      if (!/^\d+(?:\.\d+)?$/.test(seconds) || !Number.isFinite(value)
        || value > Number.MAX_SAFE_INTEGER) {
        throw new Error("Invalid Uptime measurement");
      }
      return value;
    }),
    measure(input.memory, "bytes", (text): RamUsage => {
      const total = Number(/^MemTotal:\s+(\d+) kB$/m.exec(text)?.[1]) * 1024;
      const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(text)?.[1]) * 1024;
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(available)
        || total <= 0 || available < 0 || available > total) {
        throw new Error("Invalid memory measurement");
      }
      return { total, available, used: total - available };
    }),
  ]);
  return { uptime, ram };
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
    return { status: "unavailable", value: null, unit, observedAt: null };
  }
}
