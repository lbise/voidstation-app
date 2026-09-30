import { describe, expect, it } from "vitest";
import { collectHostMetrics, type HostInput, type PressureResource } from "../src/lib/host-metrics";

const observedAt = "2026-01-02T03:04:05.000Z";
const checkedAt = "2026-01-02T02:50:00.000Z";
const pressureText: Record<PressureResource, string> = {
  cpu: "some avg10=1.50 avg60=0.75 avg300=0.10 total=123456\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
  memory: "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
  io: "some avg10=12.34 avg60=100.00 avg300=5.00 total=987654\nfull avg10=10.00 avg60=4.00 avg300=1.00 total=654321\n",
};
const ataDrive = {
  device: "sda", model: "WDC WD40EFRX", passed: true, standby: false, temperatureCelsius: 34,
  powerOnHours: 21000, reallocatedSectors: 0, pendingSectors: 2, mediaErrors: null, percentageUsed: null,
};
const sleepingDrive = {
  device: "sdb", model: null, passed: null, standby: true, temperatureCelsius: null,
  powerOnHours: null, reallocatedSectors: null, pendingSectors: null, mediaErrors: null, percentageUsed: null,
};
const nvmeDrive = {
  device: "nvme0", model: "Samsung SSD 980", passed: false, standby: false, temperatureCelsius: 41,
  powerOnHours: 5000, reallocatedSectors: null, pendingSectors: null, mediaErrors: 3, percentageUsed: 7,
};
const status = {
  version: 1,
  checkedAt,
  rebootRequired: true,
  rebootPackages: ["linux-base", "libc6"],
  updates: { total: 12, security: 3 },
  drives: [ataDrive, sleepingDrive, nvmeDrive],
};
const filesystem = (filesystemId: string) => async () => ({
  filesystemId,
  totalBytes: 1000,
  freeBytes: 400,
  availableBytes: 300,
  observedAt,
});
const host: HostInput = {
  cpu: async () => ({ text: "cpu  100 20 30 40 10 0 0 0 0 0\ncpu0 50 10 15 20 5 0 0 0 0 0\ncpu1 50 10 15 20 5 0 0 0 0 0\nintr 1\n", observedAt }),
  uptime: async () => ({ text: "90061.25 181000.50\n", observedAt }),
  memory: async () => ({
    text: "MemTotal:       8388608 kB\nMemFree:         524288 kB\nMemAvailable:   3145728 kB\nCached:         2097152 kB\nSwapTotal:      2097152 kB\nSwapFree:       1572864 kB\n",
    observedAt,
  }),
  load: async () => ({ text: "0.58 1.25 2.00 1/1287 2548459\n", observedAt }),
  pressure: async (resource) => ({ text: pressureText[resource], observedAt }),
  hostStatus: async () => ({ text: JSON.stringify(status), observedAt }),
  rootFilesystem: filesystem("root"),
  dataFilesystem: filesystem("data"),
};

const unavailable = (unit: "percent" | "bytes" | "seconds" | "tasks" | "status") => ({
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
      load: inaccessible,
      pressure: inaccessible,
      hostStatus: inaccessible,
      rootFilesystem: inaccessible,
      dataFilesystem: inaccessible,
    })).toEqual({
      cpu: unavailable("percent"),
      uptime: unavailable("seconds"),
      ram: unavailable("bytes"),
      swap: unavailable("bytes"),
      load: unavailable("tasks"),
      pressure: unavailable("percent"),
      rootFilesystem: unavailable("bytes"),
      dataFilesystem: unavailable("bytes"),
      hostStatus: unavailable("status"),
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

describe("swap", () => {
  it("reports swap used as total minus free, in bytes", async () => {
    expect((await collectHostMetrics(host)).swap).toEqual({
      status: "available", value: { total: 2147483648, used: 536870912 }, unit: "bytes", observedAt,
    });
  });

  it("treats a Server without swap as a valid zero total", async () => {
    const metrics = await collectHostMetrics({
      ...host,
      memory: async () => ({ text: "MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n", observedAt }),
    });
    expect(metrics.swap).toEqual({ status: "available", value: { total: 0, used: 0 }, unit: "bytes", observedAt });
  });

  it.each([
    "MemTotal: 1024 kB\nMemAvailable: 512 kB\n",
    "MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 1024 kB\n",
    "MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 1024 kB\nSwapFree: 2048 kB\n",
    "MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: -1 kB\nSwapFree: 0 kB\n",
    "MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 1 MB\nSwapFree: 0 MB\n",
    "MemTotal: 1024 kB\nMemAvailable: 512 kB\nSwapTotal: 99999999999999999999 kB\nSwapFree: 0 kB\n",
  ])("reports invalid swap input as unavailable while RAM stays available: %s", async (text) => {
    const metrics = await collectHostMetrics({ ...host, memory: async () => ({ text, observedAt }) });
    expect(metrics.swap).toEqual(unavailable("bytes"));
    expect(metrics.ram.status).toBe("available");
  });

  it("reads meminfo once per collection for RAM and swap", async () => {
    let reads = 0;
    await collectHostMetrics({ ...host, memory: async () => { reads += 1; return host.memory(); } });
    expect(reads).toBe(1);
  });
});

describe("load average", () => {
  it("reports the three load averages with the logical CPU count from /proc/stat", async () => {
    expect((await collectHostMetrics(host)).load).toEqual({
      status: "available", value: { one: 0.58, five: 1.25, fifteen: 2, cores: 2 }, unit: "tasks", observedAt,
    });
  });

  it("reads /proc/stat once per collection without disturbing the CPU interval", async () => {
    const samples = [
      "cpu  100 20 30 40 10 0 0 0 0 0\ncpu0 100 20 30 40 10 0 0 0 0 0\n",
      "cpu  110 25 35 50 15 0 0 0 0 0\ncpu0 110 25 35 50 15 0 0 0 0 0\n",
    ];
    let reads = 0;
    const input: HostInput = {
      ...host,
      cpu: async () => { reads += 1; return { text: samples.shift()!, observedAt }; },
    };
    expect((await collectHostMetrics(input)).load.status).toBe("available");
    const second = await collectHostMetrics(input);
    expect(reads).toBe(2);
    expect(second.cpu).toEqual({ status: "available", value: (20 / 35) * 100, unit: "percent", observedAt });
    expect(second.load).toMatchObject({ status: "available", value: { cores: 1 } });
  });

  it.each(["", "0.58 1.25", "-0.5 1.00 2.00 1/2 3", "0.58 NaN 2.00", "1e3 1.00 2.00", "Infinity 0 0"])(
    "reports invalid loadavg input as unavailable: %s", async (text) => {
      const metrics = await collectHostMetrics({ ...host, load: async () => ({ text, observedAt }) });
      expect(metrics.load).toEqual(unavailable("tasks"));
      expect(metrics.uptime.status).toBe("available");
    },
  );

  it("is unavailable without a CPU count or when /proc/stat cannot be read", async () => {
    const noCores = await collectHostMetrics({ ...host, cpu: async () => ({ text: "cpu 1 2 3 4\n", observedAt }) });
    expect(noCores.load).toEqual(unavailable("tasks"));
    const noStat = await collectHostMetrics({ ...host, cpu: async () => { throw new Error("EACCES"); } });
    expect(noStat.load).toEqual(unavailable("tasks"));
    expect(noStat.cpu).toEqual(unavailable("percent"));
  });
});

describe("pressure stall information", () => {
  it("reports the some-line avg10 and avg60 percentages for CPU, memory, and IO", async () => {
    expect((await collectHostMetrics(host)).pressure).toEqual({
      status: "available",
      value: {
        cpu: { avg10: 1.5, avg60: 0.75 },
        memory: { avg10: 0, avg60: 0 },
        io: { avg10: 12.34, avg60: 100 },
      },
      unit: "percent",
      observedAt,
    });
  });

  it("is unavailable as a whole when any resource is missing", async () => {
    const metrics = await collectHostMetrics({
      ...host,
      pressure: async (resource) => {
        if (resource === "io") throw new Error("ENOENT /proc/pressure/io");
        return { text: pressureText[resource], observedAt };
      },
    });
    expect(metrics.pressure).toEqual(unavailable("percent"));
    expect(metrics.load.status).toBe("available");
  });

  it.each([
    "",
    "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    "some avg10=100.01 avg60=0.00 avg300=0.00 total=0\n",
    "some avg10=-1.00 avg60=0.00 avg300=0.00 total=0\n",
    "some avg10=abc avg60=0.00 avg300=0.00 total=0\n",
    "some avg60=0.00 avg10=0.00 avg300=0.00 total=0\n",
  ])("is unavailable when one resource is malformed: %s", async (text) => {
    const metrics = await collectHostMetrics({
      ...host,
      pressure: async (resource) => ({ text: resource === "memory" ? text : pressureText[resource], observedAt }),
    });
    expect(metrics.pressure).toEqual(unavailable("percent"));
  });
});

describe("host status", () => {
  const withStatus = (value: unknown, readAt = observedAt): HostInput => ({
    ...host,
    hostStatus: async () => ({ text: typeof value === "string" ? value : JSON.stringify(value), observedAt: readAt }),
  });

  it("reports the helper's status with its own check time as observedAt", async () => {
    expect((await collectHostMetrics(host)).hostStatus).toEqual({
      status: "available",
      value: {
        rebootRequired: true,
        rebootPackages: ["linux-base", "libc6"],
        updates: { total: 12, security: 3 },
        drives: [ataDrive, sleepingDrive, nvmeDrive],
      },
      unit: "status",
      observedAt: checkedAt,
    });
  });

  it("accepts unknown update counts, no SMART support, and an offset check time", async () => {
    const metrics = await collectHostMetrics(withStatus({
      ...status, checkedAt: "2026-01-02T04:50:00+02:00", rebootRequired: false, rebootPackages: [], updates: null, drives: null,
    }));
    expect(metrics.hostStatus).toEqual({
      status: "available",
      value: { rebootRequired: false, rebootPackages: [], updates: null, drives: null },
      unit: "status",
      observedAt: "2026-01-02T02:50:00.000Z",
    });
  });

  it.each([
    ["older than three hours", { ...status, checkedAt: "2026-01-02T00:04:04.000Z" }],
    ["more than five minutes in the future", { ...status, checkedAt: "2026-01-02T03:09:06.000Z" }],
  ])("is unavailable when the check is %s", async (_label, value) => {
    expect((await collectHostMetrics(withStatus(value))).hostStatus).toEqual(unavailable("status"));
  });

  it("accepts a check exactly at the freshness limits", async () => {
    for (const time of ["2026-01-02T00:04:05.000Z", "2026-01-02T03:09:05.000Z"]) {
      expect((await collectHostMetrics(withStatus({ ...status, checkedAt: time }))).hostStatus.status).toBe("available");
    }
  });

  it.each<[string, unknown]>([
    ["not JSON", "{not json"],
    ["an array", [status]],
    ["another version", { ...status, version: 2 }],
    ["an unknown key", { ...status, extra: "raw" }],
    ["a missing key", { ...status, drives: undefined }],
    ["a non-ISO check time", { ...status, checkedAt: "Fri, 02 Jan 2026 02:50:00 GMT" }],
    ["an impossible check time", { ...status, checkedAt: "2026-13-45T99:00:00Z" }],
    ["a string reboot flag", { ...status, rebootRequired: "yes" }],
    ["too many reboot packages", { ...status, rebootPackages: Array.from({ length: 21 }, (_, i) => `pkg${i}`) }],
    ["a malformed package name", { ...status, rebootPackages: ["linux base; rm -rf /"] }],
    ["duplicate package names", { ...status, rebootPackages: ["dbus", "dbus"] }],
    ["more security than total updates", { ...status, updates: { total: 1, security: 2 } }],
    ["fractional updates", { ...status, updates: { total: 1.5, security: 0 } }],
    ["too many drives", { ...status, drives: Array.from({ length: 33 }, (_, i) => ({ ...ataDrive, device: `sd${i}` })) }],
    ["a drive with an extra key", { ...status, drives: [{ ...ataDrive, serial: "WD-123" }] }],
    ["a drive path device name", { ...status, drives: [{ ...ataDrive, device: "../../etc" }] }],
    ["an overlong model", { ...status, drives: [{ ...ataDrive, model: "x".repeat(129) }] }],
    ["a control character in the model", { ...status, drives: [{ ...ataDrive, model: "WDC\u0007" }] }],
    ["an implausible temperature", { ...status, drives: [{ ...ataDrive, temperatureCelsius: 250 }] }],
    ["negative sectors", { ...status, drives: [{ ...ataDrive, reallocatedSectors: -1 }] }],
    ["an out-of-range endurance", { ...status, drives: [{ ...nvmeDrive, percentageUsed: 256 }] }],
    ["a string standby flag", { ...status, drives: [{ ...ataDrive, standby: "no" }] }],
    ["an oversized file", JSON.stringify(status) + " ".repeat(64 * 1024)],
  ])("is unavailable for %s without leaking its contents", async (_label, value) => {
    const metrics = await collectHostMetrics(withStatus(value));
    expect(metrics.hostStatus).toEqual(unavailable("status"));
    expect(metrics.swap.status).toBe("available");
    expect(JSON.stringify(metrics)).not.toMatch(/raw|WD-123|rm -rf|not json/);
  });

  it("is unavailable when the status file is missing, while other measurements continue", async () => {
    const metrics = await collectHostMetrics({
      ...host,
      hostStatus: async () => { throw new Error("ENOENT /host/status/status.json"); },
    });
    expect(metrics.hostStatus).toEqual(unavailable("status"));
    expect(JSON.stringify(metrics)).not.toContain("ENOENT");
    expect(metrics.pressure.status).toBe("available");
  });
});

