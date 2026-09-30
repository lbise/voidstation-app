"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { useCpuHistory, type CpuHistory } from "@/components/cpu-history";
import type {
  DiskSpace, DriveHealth, HostMetrics, HostStatus, LoadAverage, Measurement, Pressure, RamUsage, SwapUsage,
} from "@/lib/metrics-contract";

const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type AvailableMeasurement<T, U extends string> = Extract<Measurement<T, U>, { status: "available" }>;
export type MetricState<T, U extends string> = {
  measurement: AvailableMeasurement<T, U> | null;
  stale: boolean;
};

export type DashboardState = {
  cpu: MetricState<number, "percent">;
  uptime: MetricState<number, "seconds">;
  ram: MetricState<RamUsage, "bytes">;
  swap: MetricState<SwapUsage, "bytes">;
  load: MetricState<LoadAverage, "tasks">;
  pressure: MetricState<Pressure, "percent">;
  rootFilesystem: MetricState<DiskSpace, "bytes">;
  dataFilesystem: MetricState<DiskSpace, "bytes">;
  hostStatus: MetricState<HostStatus, "status">;
};

const METRIC_KEYS = [
  "cpu", "uptime", "ram", "swap", "load", "pressure", "rootFilesystem", "dataFilesystem", "hostStatus",
] as const satisfies readonly (keyof DashboardState)[];

export type ReadingStatus = "loading" | "available" | "stale" | "unavailable";
export type ServerMetricsContextValue = {
  metrics: DashboardState;
  initialLoading: boolean;
  requestFailure: boolean;
  cpuHistory: CpuHistory;
  lastUpdated: string | null;
};

type ActiveRequest = {
  controller: AbortController;
  timeoutId: number;
  timedOut: boolean;
};

const emptyMetric = <T, U extends string>(): MetricState<T, U> => ({
  measurement: null,
  stale: false,
});

const initialState: DashboardState = {
  cpu: emptyMetric<number, "percent">(),
  uptime: emptyMetric<number, "seconds">(),
  ram: emptyMetric<RamUsage, "bytes">(),
  swap: emptyMetric<SwapUsage, "bytes">(),
  load: emptyMetric<LoadAverage, "tasks">(),
  pressure: emptyMetric<Pressure, "percent">(),
  rootFilesystem: emptyMetric<DiskSpace, "bytes">(),
  dataFilesystem: emptyMetric<DiskSpace, "bytes">(),
  hostStatus: emptyMetric<HostStatus, "status">(),
};

function reconcileMetric<T, U extends string>(
  previous: MetricState<T, U>,
  next: Measurement<T, U>,
): MetricState<T, U> {
  if (next.status === "available") return { measurement: next, stale: false };
  return previous.measurement ? { ...previous, stale: true } : emptyMetric<T, U>();
}

function retainAfterRequestFailure<T, U extends string>(previous: MetricState<T, U>): MetricState<T, U> {
  return previous.measurement ? { ...previous, stale: true } : previous;
}

/**
 * Readings sampled on every refresh. Host status is excluded: it comes from a periodic
 * check on the Server, so its absence or age does not make the live readings partial.
 */
export function liveReadings(metrics: DashboardState): MetricState<unknown, string>[] {
  const { hostStatus: _hostStatus, ...live } = metrics;
  return Object.values(live);
}

export function readingStatus(
  reading: MetricState<unknown, string>,
  initialLoading: boolean,
): ReadingStatus {
  if (reading.measurement) return reading.stale ? "stale" : "available";
  return initialLoading ? "loading" : "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isObservedAt(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUnavailableMeasurement(value: unknown, unit: string): boolean {
  return isRecord(value) && value.status === "unavailable" && value.value === null &&
    value.unit === unit && value.observedAt === null;
}

function isCpuMeasurement(value: unknown): value is HostMetrics["cpu"] {
  if (isUnavailableMeasurement(value, "percent")) return true;
  return isRecord(value) && value.status === "available" && typeof value.value === "number" &&
    Number.isFinite(value.value) && value.value >= 0 && value.value <= 100 &&
    value.unit === "percent" && isObservedAt(value.observedAt);
}

function isUptimeMeasurement(value: unknown): value is HostMetrics["uptime"] {
  if (isUnavailableMeasurement(value, "seconds")) return true;
  return isRecord(value) && value.status === "available" && typeof value.value === "number" &&
    Number.isFinite(value.value) && value.value >= 0 && value.unit === "seconds" &&
    isObservedAt(value.observedAt);
}

function isByteMeasurement(
  value: unknown,
  requireExactArithmetic: boolean,
): value is HostMetrics["ram"] | HostMetrics["rootFilesystem"] {
  if (isUnavailableMeasurement(value, "bytes")) return true;
  if (!isRecord(value) || value.status !== "available" || value.unit !== "bytes" ||
    !isObservedAt(value.observedAt) || !isRecord(value.value)) return false;
  const { used, available, total } = value.value;
  return isByteCount(used) && isByteCount(available) && isByteCount(total) && total > 0 &&
    used <= total && available <= total &&
    (requireExactArithmetic ? used === total - available : used + available <= total);
}

function isAvailable(value: unknown, unit: string): value is { value: Record<string, unknown> } {
  return isRecord(value) && value.status === "available" && value.unit === unit &&
    isObservedAt(value.observedAt) && isRecord(value.value);
}

function isNumberBetween(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSwapMeasurement(value: unknown): value is HostMetrics["swap"] {
  if (isUnavailableMeasurement(value, "bytes")) return true;
  if (!isAvailable(value, "bytes")) return false;
  const { used, total } = value.value;
  return isByteCount(used) && isByteCount(total) && used <= total;
}

function isLoadMeasurement(value: unknown): value is HostMetrics["load"] {
  if (isUnavailableMeasurement(value, "tasks")) return true;
  if (!isAvailable(value, "tasks")) return false;
  const { one, five, fifteen, cores } = value.value;
  return isNumberBetween(one, 0) && isNumberBetween(five, 0) && isNumberBetween(fifteen, 0) &&
    isCount(cores) && cores >= 1;
}

function isPressureMeasurement(value: unknown): value is HostMetrics["pressure"] {
  if (isUnavailableMeasurement(value, "percent")) return true;
  if (!isAvailable(value, "percent")) return false;
  return [value.value.cpu, value.value.memory, value.value.io].every((stall) =>
    isRecord(stall) && isNumberBetween(stall.avg10, 0, 100) && isNumberBetween(stall.avg60, 0, 100));
}

function isNullable<T>(value: unknown, check: (value: unknown) => value is T): value is T | null {
  return value === null || check(value);
}

function isDriveHealth(value: unknown): value is DriveHealth {
  return isRecord(value) && typeof value.device === "string" && value.device.length > 0 &&
    (value.model === null || typeof value.model === "string") &&
    (value.passed === null || typeof value.passed === "boolean") && typeof value.standby === "boolean" &&
    isNullable(value.temperatureCelsius, (item): item is number => isNumberBetween(item, -40, 200)) &&
    isNullable(value.powerOnHours, isCount) && isNullable(value.reallocatedSectors, isCount) &&
    isNullable(value.pendingSectors, isCount) && isNullable(value.mediaErrors, isCount) &&
    isNullable(value.percentageUsed, isCount);
}

function isHostStatusMeasurement(value: unknown): value is HostMetrics["hostStatus"] {
  if (isUnavailableMeasurement(value, "status")) return true;
  if (!isAvailable(value, "status")) return false;
  const { rebootRequired, rebootPackages, updates, drives } = value.value;
  return typeof rebootRequired === "boolean" &&
    Array.isArray(rebootPackages) && rebootPackages.length <= 20 &&
    rebootPackages.every((name) => typeof name === "string") &&
    (updates === null || (isRecord(updates) && isCount(updates.total) && isCount(updates.security) &&
      updates.security <= updates.total)) &&
    (drives === null || (Array.isArray(drives) && drives.length <= 32 && drives.every(isDriveHealth)));
}

function isHostMetrics(value: unknown): value is HostMetrics {
  return isRecord(value) && isCpuMeasurement(value.cpu) && isUptimeMeasurement(value.uptime) &&
    isByteMeasurement(value.ram, true) && isSwapMeasurement(value.swap) && isLoadMeasurement(value.load) &&
    isPressureMeasurement(value.pressure) && isByteMeasurement(value.rootFilesystem, false) &&
    isByteMeasurement(value.dataFilesystem, false) && isHostStatusMeasurement(value.hostStatus);
}

type AnyMetric = MetricState<unknown, string>;

function mapMetrics(map: (key: keyof DashboardState) => AnyMetric): DashboardState {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, map(key)])) as unknown as DashboardState;
}

export function uptimeParts(seconds: number): { value: number; unit: string }[] {
  const parts = [["day", 86_400], ["hour", 3_600], ["minute", 60]] as const;
  let remainder = Math.max(0, Math.floor(seconds));
  const formatted = parts.flatMap(([unit, duration]) => {
    const value = Math.floor(remainder / duration);
    remainder %= duration;
    return value > 0 ? [{ value, unit: `${unit}${value === 1 ? "" : "s"}` }] : [];
  });
  return formatted.length > 0 ? formatted : [{ value: remainder, unit: "seconds" }];
}

export function formatUptime(seconds: number): string {
  return uptimeParts(seconds).map(({ value, unit }) => `${value} ${unit}`).join(" ");
}

export function formatGiB(bytes: number): string {
  return `${(Math.max(0, bytes) / 1024 ** 3).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} GiB`;
}

export function formatPercentage(used: number, total: number): number {
  return total <= 0 ? 0 : Math.min(100, Math.max(0, (used / total) * 100));
}

export function formatCpu(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

export function formatObservedAt(observedAt: string): string {
  const date = new Date(observedAt);
  const today = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, today ? { timeStyle: "medium" } : { dateStyle: "medium", timeStyle: "medium" })
    .format(date);
}

const ServerMetricsContext = createContext<ServerMetricsContextValue | null>(null);

// Mount once in the authenticated AppShell, never around the login route.
export function ServerMetricsProvider({ children }: { children: ReactNode }) {
  const [metrics, setMetrics] = useState<DashboardState>(initialState);
  const [initialLoading, setInitialLoading] = useState(true);
  const [requestFailure, setRequestFailure] = useState(false);

  useEffect(() => {
    let disposed = false;
    let intervalId: number | null = null;
    let inFlight = false;
    let activeRequest: ActiveRequest | null = null;
    let refreshPending = false;

    const refresh = async () => {
      if (inFlight || disposed || document.visibilityState !== "visible") return;
      inFlight = true;
      const controller = new AbortController();
      const request: ActiveRequest = {
        controller,
        timeoutId: window.setTimeout(() => {
          request.timedOut = true;
          controller.abort();
        }, REQUEST_TIMEOUT_MS),
        timedOut: false,
      };
      activeRequest = request;

      try {
        const response = await fetch("/api/metrics", {
          cache: "no-store",
          headers: { "Cache-Control": "no-store" },
          signal: controller.signal,
        });
        if (response.status === 401 && !disposed && !controller.signal.aborted) {
          setMetrics(initialState);
          window.location.replace("/login");
          return;
        }
        if (!response.ok) throw new Error(`Metrics request failed with ${response.status}`);
        const payload: unknown = await response.json();
        if (!isHostMetrics(payload)) throw new Error("Metrics response did not match the expected contract");

        if (!disposed && !controller.signal.aborted) {
          setMetrics((previous) => mapMetrics((key) =>
            reconcileMetric(previous[key] as AnyMetric, payload[key] as Measurement<unknown, string>)));
          setInitialLoading(false);
          setRequestFailure(false);
        }
      } catch {
        const abortedWithoutTimeout = controller.signal.aborted && !request.timedOut;
        if (!disposed && !abortedWithoutTimeout) {
          setMetrics((previous) => mapMetrics((key) => retainAfterRequestFailure(previous[key] as AnyMetric)));
          setInitialLoading(false);
          setRequestFailure(true);
        }
      } finally {
        window.clearTimeout(request.timeoutId);
        if (activeRequest === request) {
          activeRequest = null;
          inFlight = false;
          if (refreshPending && !disposed && document.visibilityState === "visible") {
            refreshPending = false;
            void refresh();
          }
        }
      }
    };

    const requestImmediateRefresh = () => {
      if (inFlight) {
        refreshPending = true;
        return;
      }
      void refresh();
    };

    const stopPolling = () => {
      refreshPending = false;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
      activeRequest?.controller.abort();
    };

    const startPolling = () => {
      if (document.visibilityState !== "visible") return;
      requestImmediateRefresh();
      if (intervalId === null) intervalId = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") startPolling();
      else stopPolling();
    };

    startPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopPolling();
    };
  }, []);

  const cpu = metrics.cpu.measurement;
  const cpuHistory = useCpuHistory({
    status: readingStatus(metrics.cpu, initialLoading),
    value: cpu?.value ?? null,
    observedAt: cpu?.observedAt ?? null,
  });
  const lastUpdated = Object.values(metrics).reduce<string | null>((latest, { measurement }) => {
    if (!measurement || !latest) return measurement?.observedAt ?? latest;
    return Date.parse(measurement.observedAt) > Date.parse(latest) ? measurement.observedAt : latest;
  }, null);

  return (
    <ServerMetricsContext.Provider value={{ metrics, initialLoading, requestFailure, cpuHistory, lastUpdated }}>
      {children}
    </ServerMetricsContext.Provider>
  );
}

export function useServerMetrics(): ServerMetricsContextValue {
  const context = useContext(ServerMetricsContext);
  if (!context) throw new Error("useServerMetrics must be used within ServerMetricsProvider");
  return context;
}
