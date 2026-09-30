import type { HostMetrics } from "../../src/lib/metrics-contract";

export type ExtendedObservations = Pick<HostMetrics, "swap" | "load" | "pressure" | "hostStatus">;

/** Current readings for the measurements added after CPU, Uptime, RAM and Disk space. */
export function extendedObservations(observedAt: string): ExtendedObservations {
  const stall = { avg10: 0.5, avg60: 0.25 };
  return {
    swap: { status: "available", value: { used: 0, total: 2147483648 }, unit: "bytes", observedAt },
    load: { status: "available", value: { one: 0.52, five: 0.61, fifteen: 0.7, cores: 8 }, unit: "tasks", observedAt },
    pressure: { status: "available", value: { cpu: stall, memory: stall, io: stall }, unit: "percent", observedAt },
    hostStatus: {
      status: "available",
      unit: "status",
      observedAt,
      value: {
        rebootRequired: false,
        rebootPackages: [],
        updates: { total: 0, security: 0 },
        drives: [{
          device: "sda", model: "Fixture Disk", passed: true, standby: false, temperatureCelsius: 34,
          powerOnHours: 1000, reallocatedSectors: 0, pendingSectors: 0, mediaErrors: null, percentageUsed: null,
        }],
      },
    },
  };
}

export const unavailableExtended: ExtendedObservations = {
  swap: { status: "unavailable", value: null, unit: "bytes", observedAt: null },
  load: { status: "unavailable", value: null, unit: "tasks", observedAt: null },
  pressure: { status: "unavailable", value: null, unit: "percent", observedAt: null },
  hostStatus: { status: "unavailable", value: null, unit: "status", observedAt: null },
};
