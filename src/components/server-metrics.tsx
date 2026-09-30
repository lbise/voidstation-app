"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { useCpuHistory, type CpuHistory } from "@/components/cpu-history";
import type { DiskSpace, HostMetrics, Measurement, RamUsage } from "@/lib/metrics-contract";

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
  rootFilesystem: MetricState<DiskSpace, "bytes">;
  dataFilesystem: MetricState<DiskSpace, "bytes">;
};

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
  rootFilesystem: emptyMetric<DiskSpace, "bytes">(),
  dataFilesystem: emptyMetric<DiskSpace, "bytes">(),
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

function isUnavailableMeasurement(value: unknown, unit: "seconds" | "bytes" | "percent"): boolean {
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

function isHostMetrics(value: unknown): value is HostMetrics {
  return isRecord(value) && isCpuMeasurement(value.cpu) && isUptimeMeasurement(value.uptime) &&
    isByteMeasurement(value.ram, true) && isByteMeasurement(value.rootFilesystem, false) &&
    isByteMeasurement(value.dataFilesystem, false);
}

export function formatUptime(seconds: number): string {
  if (seconds === 0) return "0 seconds";
  const parts = [["day", 86_400], ["hour", 3_600], ["minute", 60]] as const;
  let remainder = Math.max(0, Math.floor(seconds));
  const formatted = parts.flatMap(([unit, duration]) => {
    const value = Math.floor(remainder / duration);
    remainder %= duration;
    return value > 0 ? [`${value} ${unit}${value === 1 ? "" : "s"}`] : [];
  });
  return formatted.length > 0 ? formatted.join(" ") : `${remainder} seconds`;
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
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" })
    .format(new Date(observedAt));
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
          setMetrics((previous) => ({
            cpu: reconcileMetric(previous.cpu, payload.cpu),
            uptime: reconcileMetric(previous.uptime, payload.uptime),
            ram: reconcileMetric(previous.ram, payload.ram),
            rootFilesystem: reconcileMetric(previous.rootFilesystem, payload.rootFilesystem),
            dataFilesystem: reconcileMetric(previous.dataFilesystem, payload.dataFilesystem),
          }));
          setInitialLoading(false);
          setRequestFailure(false);
        }
      } catch {
        const abortedWithoutTimeout = controller.signal.aborted && !request.timedOut;
        if (!disposed && !abortedWithoutTimeout) {
          setMetrics((previous) => ({
            cpu: retainAfterRequestFailure(previous.cpu),
            uptime: retainAfterRequestFailure(previous.uptime),
            ram: retainAfterRequestFailure(previous.ram),
            rootFilesystem: retainAfterRequestFailure(previous.rootFilesystem),
            dataFilesystem: retainAfterRequestFailure(previous.dataFilesystem),
          }));
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
