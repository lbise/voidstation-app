import { describe, expect, it } from "vitest";
import { collectHostMetrics, type HostInput } from "../src/lib/host-metrics";

const observedAt = "2026-01-02T03:04:05.000Z";
const host: HostInput = {
  uptime: async () => ({ text: "90061.25 181000.50\n", observedAt }),
  memory: async () => ({
    text: "MemTotal:       8388608 kB\nMemFree:         524288 kB\nMemAvailable:   3145728 kB\nCached:         2097152 kB\n",
    observedAt,
  }),
};

describe("host measurements", () => {
  it("preserves valid zero values and each source's own observation time", async () => {
    const memoryTime = "2026-01-02T03:04:06.000Z";
    expect(await collectHostMetrics({
      uptime: async () => ({ text: "0.00 0.00", observedAt }),
      memory: async () => ({ text: "MemTotal: 1024 kB\nMemAvailable: 1024 kB\n", observedAt: memoryTime }),
    })).toEqual({
      uptime: { status: "available", value: 0, unit: "seconds", observedAt },
      ram: {
        status: "available", value: { total: 1048576, available: 1048576, used: 0 },
        unit: "bytes", observedAt: memoryTime,
      },
    });
  });

  it("reports both inaccessible sources without leaking failure details", async () => {
    const inaccessible = async (): Promise<never> => { throw new Error("secret host input"); };
    expect(await collectHostMetrics({ uptime: inaccessible, memory: inaccessible })).toEqual({
      uptime: { status: "unavailable", value: null, unit: "seconds", observedAt: null },
      ram: { status: "unavailable", value: null, unit: "bytes", observedAt: null },
    });
  });

  it.each(["", "-1.00 10.00", "Infinity 0", "garbage", "0x10 0", "1e99 0"])(
    "keeps RAM available when Uptime input is invalid: %s", async (text) => {
      const metrics = await collectHostMetrics({ ...host, uptime: async () => ({ text, observedAt }) });
      expect(metrics.uptime).toEqual({ status: "unavailable", value: null, unit: "seconds", observedAt: null });
      expect(metrics.ram.status).toBe("available");
    },
  );

  it.each([
    "MemTotal: 1024 kB\n",
    "MemTotal: 1024 kB\nMemAvailable: 2048 kB\n",
    "MemTotal: 0 kB\nMemAvailable: 0 kB\n",
    "MemTotal: -1024 kB\nMemAvailable: 0 kB\n",
    "MemTotal: 1024 MB\nMemAvailable: 0 MB\n",
    "MemTotal: 99999999999999999999 kB\nMemAvailable: 0 kB\n",
  ])("reports invalid RAM input as unavailable: %s", async (text) => {
    const metrics = await collectHostMetrics({
      ...host,
      memory: async () => ({ text, observedAt }),
    });
    expect(metrics.ram).toEqual({ status: "unavailable", value: null, unit: "bytes", observedAt: null });
    expect(metrics.uptime.status).toBe("available");
  });

  it("keeps Uptime available when RAM access fails, without a fabricated zero", async () => {
    const metrics = await collectHostMetrics({
      ...host,
      memory: async () => { throw new Error("EACCES /private/host/source"); },
    });

    expect(metrics).toEqual({
      uptime: { status: "available", value: 90061.25, unit: "seconds", observedAt },
      ram: { status: "unavailable", value: null, unit: "bytes", observedAt: null },
    });
  });

  it("reports host Uptime and RAM used as total minus available, in bytes", async () => {
    expect(await collectHostMetrics(host)).toEqual({
      uptime: { status: "available", value: 90061.25, unit: "seconds", observedAt },
      ram: {
        status: "available",
        value: { total: 8589934592, available: 3221225472, used: 5368709120 },
        unit: "bytes",
        observedAt,
      },
    });
  });
});
