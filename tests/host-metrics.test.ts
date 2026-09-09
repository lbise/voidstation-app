import { describe, expect, it } from "vitest";
import { collectHostMetrics, type HostInput } from "../src/lib/host-metrics";

const observedAt = "2026-01-02T03:04:05.000Z";
const filesystem = (filesystemId: string) => async () => ({
  filesystemId,
  totalBytes: 1000,
  freeBytes: 400,
  availableBytes: 300,
  observedAt,
});
const host: HostInput = {
  cpu: async () => ({ text: "cpu  100 20 30 40 10 0 0 0 0 0\n", observedAt }),
  uptime: async () => ({ text: "90061.25 181000.50\n", observedAt }),
  memory: async () => ({
    text: "MemTotal:       8388608 kB\nMemFree:         524288 kB\nMemAvailable:   3145728 kB\nCached:         2097152 kB\n",
    observedAt,
  }),
  rootFilesystem: filesystem("root"),
  dataFilesystem: filesystem("data"),
};

const unavailable = (unit: "percent" | "bytes" | "seconds") => ({
  status: "unavailable" as const, value: null, unit, observedAt: null,
});

describe("host measurements", () => {
  it("keeps the initial CPU sample unavailable and calculates utilization from successive samples", async () => {
    let sample = "cpu  100 20 30 40 10 0 0 0 0 0\n";
    const input: HostInput = {
      ...host,
      cpu: async () => ({ text: sample, observedAt }),
    };

    expect((await collectHostMetrics(input)).cpu).toEqual(unavailable("percent"));
    sample = "cpu  110 25 35 50 15 0 0 0 0 0\n";
    expect((await collectHostMetrics(input)).cpu).toEqual({
      status: "available", value: (20 / 35) * 100, unit: "percent", observedAt,
    });
  });

  it("does not double-count guest CPU time that Linux includes in user and nice", async () => {
    const samples = [
      "cpu  100 20 30 40 10 0 0 0 100 50\n",
      "cpu  110 25 35 50 15 0 0 0 110 55\n",
    ];
    const input: HostInput = {
      ...host,
      cpu: async () => ({ text: samples.shift()!, observedAt }),
    };
    expect((await collectHostMetrics(input)).cpu).toEqual(unavailable("percent"));
    expect((await collectHostMetrics(input)).cpu).toEqual({
      status: "available", value: (20 / 35) * 100, unit: "percent", observedAt,
    });
  });

  it("preserves valid zero values and each source's own observation time", async () => {
    const memoryTime = "2026-01-02T03:04:06.000Z";
    const metrics = await collectHostMetrics({
      ...host,
      cpu: async () => ({ text: "cpu 1 0 0 0\n", observedAt }),
      uptime: async () => ({ text: "0.00 0.00", observedAt }),
      memory: async () => ({ text: "MemTotal: 1024 kB\nMemAvailable: 1024 kB\n", observedAt: memoryTime }),
    });
    expect(metrics).toMatchObject({
      cpu: unavailable("percent"),
      uptime: { status: "available", value: 0, unit: "seconds", observedAt },
      ram: {
        status: "available", value: { total: 1048576, available: 1048576, used: 0 },
        unit: "bytes", observedAt: memoryTime,
      },
    });
  });

  it.each([
    "",
    "cpu 100 20 30 40\n",
    "cpu 100 -20 30 40\n",
    "cpu 100 20 30 40 99999999999999999999\n",
  ])("reports invalid CPU input as unavailable: %s", async (text) => {
    const input: HostInput = { ...host, cpu: async () => ({ text, observedAt }) };
    expect((await collectHostMetrics(input)).cpu).toEqual(unavailable("percent"));
  });

  it("reports a reset or unusable CPU delta as unavailable and uses the reset sample as a new baseline", async () => {
    const samples = ["cpu 100 0 0 100\n", "cpu 90 0 0 100\n", "cpu 100 0 0 100\n"];
    const input: HostInput = {
      ...host,
      cpu: async () => ({ text: samples.shift()!, observedAt }),
    };
    await collectHostMetrics(input);
    expect((await collectHostMetrics(input)).cpu).toEqual(unavailable("percent"));
    expect((await collectHostMetrics(input)).cpu).toEqual({
      status: "available", value: 100, unit: "percent", observedAt,
    });
  });

  it("reports both inaccessible sources without leaking failure details", async () => {
    const inaccessible = async (): Promise<never> => { throw new Error("secret host input"); };
    expect(await collectHostMetrics({
      cpu: inaccessible,
      uptime: inaccessible,
      memory: inaccessible,
      rootFilesystem: inaccessible,
      dataFilesystem: inaccessible,
    })).toEqual({
      cpu: unavailable("percent"),
      uptime: unavailable("seconds"),
      ram: unavailable("bytes"),
      rootFilesystem: unavailable("bytes"),
      dataFilesystem: unavailable("bytes"),
    });
  });

  it.each(["", "-1.00 10.00", "Infinity 0", "garbage", "0x10 0", "1e99 0"])(
    "keeps RAM available when Uptime input is invalid: %s", async (text) => {
      const metrics = await collectHostMetrics({ ...host, uptime: async () => ({ text, observedAt }) });
      expect(metrics.uptime).toEqual(unavailable("seconds"));
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
    const metrics = await collectHostMetrics({ ...host, memory: async () => ({ text, observedAt }) });
    expect(metrics.ram).toEqual(unavailable("bytes"));
    expect(metrics.uptime.status).toBe("available");
  });

  it("calculates disk space without consuming filesystem reserved space", async () => {
    const metrics = await collectHostMetrics(host);
    expect(metrics.rootFilesystem).toEqual({
      status: "available", value: { total: 1000, available: 300, used: 600 },
      unit: "bytes", observedAt,
    });
    expect(metrics.dataFilesystem).toEqual(metrics.rootFilesystem);
  });

  it("rejects a data source that resolves to the root filesystem", async () => {
    const metrics = await collectHostMetrics({ ...host, dataFilesystem: filesystem("root") });
    expect(metrics.rootFilesystem.status).toBe("available");
    expect(metrics.dataFilesystem).toEqual(unavailable("bytes"));
  });

  it("keeps other measurements available when filesystem sources fail", async () => {
    const metrics = await collectHostMetrics({
      ...host,
      dataFilesystem: async () => { throw new Error("missing data mount"); },
    });
    expect(metrics.dataFilesystem).toEqual(unavailable("bytes"));
    expect(metrics.cpu.status).toBe("unavailable");
    expect(metrics.uptime.status).toBe("available");
    expect(metrics.ram.status).toBe("available");
  });

  it("keeps Uptime available when RAM access fails, without a fabricated zero", async () => {
    const metrics = await collectHostMetrics({
      ...host,
      memory: async () => { throw new Error("EACCES /private/host/source"); },
    });
    expect(metrics.uptime).toEqual({ status: "available", value: 90061.25, unit: "seconds", observedAt });
    expect(metrics.ram).toEqual(unavailable("bytes"));
  });

  it("reports host Uptime and RAM used as total minus available, in bytes", async () => {
    const metrics = await collectHostMetrics(host);
    expect(metrics.uptime).toEqual({ status: "available", value: 90061.25, unit: "seconds", observedAt });
    expect(metrics.ram).toEqual({
      status: "available",
      value: { total: 8589934592, available: 3221225472, used: 5368709120 },
      unit: "bytes", observedAt,
    });
  });
});
