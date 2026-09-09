"use client";

import { AlertTriangle, Clock3, Cpu, HardDrive, MemoryStick, Radio, Unplug } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { CpuHistoryChart, useCpuHistory } from "@/components/cpu-history";
import { ReadingInfo } from "@/components/reading-info";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { DiskSpace, HostMetrics, Measurement, RamUsage } from "@/lib/metrics-contract";

const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type AvailableMeasurement<T, U extends string> = Extract<Measurement<T, U>, { status: "available" }>;
type MetricState<T, U extends string> = {
  measurement: AvailableMeasurement<T, U> | null;
  stale: boolean;
};

type DashboardState = {
  cpu: MetricState<number, "percent">;
  uptime: MetricState<number, "seconds">;
  ram: MetricState<RamUsage, "bytes">;
  rootFilesystem: MetricState<DiskSpace, "bytes">;
  dataFilesystem: MetricState<DiskSpace, "bytes">;
};

type ReadingStatus = "loading" | "available" | "stale" | "unavailable";
type UnavailableCause = "metric" | "request";
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
  if (next.status === "available") {
    return { measurement: next, stale: false };
  }

  return previous.measurement ? { ...previous, stale: true } : emptyMetric<T, U>();
}

function retainAfterRequestFailure<T, U extends string>(
  previous: MetricState<T, U>,
): MetricState<T, U> {
  return previous.measurement ? { ...previous, stale: true } : previous;
}

function readingStatus<T, U extends string>(
  reading: MetricState<T, U>,
  initialLoading: boolean,
): ReadingStatus {
  if (reading.measurement) {
    return reading.stale ? "stale" : "available";
  }

  return initialLoading ? "loading" : "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isObservedAt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_DATE_TIME.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUnavailableMeasurement(value: unknown, unit: "seconds" | "bytes" | "percent"): boolean {
  return (
    isRecord(value) &&
    value.status === "unavailable" &&
    value.value === null &&
    value.unit === unit &&
    value.observedAt === null
  );
}

function isCpuMeasurement(value: unknown): value is HostMetrics["cpu"] {
  if (isUnavailableMeasurement(value, "percent")) {
    return true;
  }

  return (
    isRecord(value) &&
    value.status === "available" &&
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    value.value >= 0 &&
    value.value <= 100 &&
    value.unit === "percent" &&
    isObservedAt(value.observedAt)
  );
}

function isUptimeMeasurement(value: unknown): value is HostMetrics["uptime"] {
  if (isUnavailableMeasurement(value, "seconds")) {
    return true;
  }

  return (
    isRecord(value) &&
    value.status === "available" &&
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    value.value >= 0 &&
    value.unit === "seconds" &&
    isObservedAt(value.observedAt)
  );
}

function isRamMeasurement(value: unknown): value is HostMetrics["ram"] {
  return isByteMeasurement(value, true);
}

function isFilesystemMeasurement(value: unknown): value is HostMetrics["rootFilesystem"] {
  return isByteMeasurement(value, false);
}

function isByteMeasurement(
  value: unknown,
  requireExactArithmetic: boolean,
): value is HostMetrics["ram"] | HostMetrics["rootFilesystem"] {
  if (isUnavailableMeasurement(value, "bytes")) {
    return true;
  }

  if (
    !isRecord(value) ||
    value.status !== "available" ||
    value.unit !== "bytes" ||
    !isObservedAt(value.observedAt) ||
    !isRecord(value.value)
  ) {
    return false;
  }

  const { used, available, total } = value.value;
  return (
    isByteCount(used) &&
    isByteCount(available) &&
    isByteCount(total) &&
    total > 0 &&
    used <= total &&
    available <= total &&
    (requireExactArithmetic ? used === total - available : used + available <= total)
  );
}

function isHostMetrics(value: unknown): value is HostMetrics {
  return (
    isRecord(value) &&
    isCpuMeasurement(value.cpu) &&
    isUptimeMeasurement(value.uptime) &&
    isRamMeasurement(value.ram) &&
    isFilesystemMeasurement(value.rootFilesystem) &&
    isFilesystemMeasurement(value.dataFilesystem)
  );
}

function formatUptime(seconds: number): string {
  if (seconds === 0) {
    return "0 seconds";
  }

  const parts = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const;
  let remainder = Math.max(0, Math.floor(seconds));
  const formatted = parts.flatMap(([unit, duration]) => {
    const value = Math.floor(remainder / duration);
    remainder %= duration;
    return value > 0 ? [`${value} ${unit}${value === 1 ? "" : "s"}`] : [];
  });

  return formatted.length > 0 ? formatted.join(" ") : `${remainder} seconds`;
}

function formatGiB(bytes: number): string {
  const gibibytes = Math.max(0, bytes) / 1024 ** 3;
  return `${gibibytes.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} GiB`;
}

function formatPercentage(used: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, (used / total) * 100));
}

function formatCpu(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function formatObservedAt(observedAt: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(observedAt));
}

function StatusBadge({ status }: { status: ReadingStatus }) {
  if (status === "stale") {
    return (
      <Badge variant="warning">
        <AlertTriangle data-icon="inline-start" aria-hidden="true" />
        Stale reading
      </Badge>
    );
  }

  if (status === "unavailable") {
    return (
      <Badge variant="outline">
        <Unplug data-icon="inline-start" aria-hidden="true" />
        Unavailable
      </Badge>
    );
  }

  if (status === "loading") {
    return (
      <Badge variant="secondary">
        <Radio data-icon="inline-start" aria-hidden="true" />
        Loading
      </Badge>
    );
  }

  return null;
}

function MetricCard({
  title,
  icon,
  status,
  children,
  readingKind,
}: {
  title: string;
  icon: ReactNode;
  status: ReadingStatus;
  children: ReactNode;
  readingKind?: "cpu";
}) {
  return (
    <Card className="metric-card" data-reading={readingKind} data-state={status}>
      <CardHeader>
        <div className="metric-card__title-row">
          {icon}
          <CardTitle>{title}</CardTitle>
        </div>
        <CardAction>
          <StatusBadge status={status} />
        </CardAction>
      </CardHeader>
      <CardContent className="metric-card__content">{children}</CardContent>
    </Card>
  );
}

function UptimeInline({
  status,
  value,
  unavailableCause,
}: {
  status: ReadingStatus;
  value: number | null;
  unavailableCause: UnavailableCause;
}) {
  return (
    <article className="uptime-inline metric-card" data-slot="card" data-state={status}>
      <header className="uptime-inline__header">
        <div className="metric-card__title-row">
          <Clock3 className="metric-card__icon" aria-hidden="true" />
          <h2 data-slot="card-title">Uptime</h2>
        </div>
        <StatusBadge status={status} />
      </header>
      <div className="uptime-inline__reading">
        {status === "loading" ? (
          <LoadingReading label="uptime" />
        ) : value !== null ? (
          <p className="metric-value" aria-live="polite" aria-atomic="true">
            {formatUptime(value)}
          </p>
        ) : (
          <UnavailableReading cause={unavailableCause} />
        )}
      </div>
    </article>
  );
}

function LoadingReading({ label }: { label: string }) {
  return (
    <div className="metric-loading" role="status" aria-live="polite">
      <Skeleton className="metric-skeleton metric-skeleton--value" />
      <Skeleton className="metric-skeleton metric-skeleton--line" />
      <p>Loading {label} reading…</p>
    </div>
  );
}

function UnavailableReading({ cause }: { cause: UnavailableCause }) {
  const message =
    cause === "request"
      ? "The Dashboard could not request this measurement."
      : "The Server did not provide this measurement.";

  return (
    <Empty className="metric-empty">
      <EmptyMedia variant="icon">
        <Unplug aria-hidden="true" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>Unavailable</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function CapacityReading({ label, value }: { label: string; value: DiskSpace }) {
  return (
    <>
      <p className="metric-value" aria-live="polite" aria-atomic="true">
        {formatGiB(value.used)}
        <span className="metric-value__unit"> used</span>
      </p>
      <Progress
        className="metric-progress"
        value={formatPercentage(value.used, value.total)}
        aria-label={`${label} used: ${formatGiB(value.used)} of ${formatGiB(value.total)}`}
      >
        <ProgressLabel>{label} used</ProgressLabel>
        <ProgressValue>{(_, progressValue) => `${Math.round(progressValue ?? 0)}%`}</ProgressValue>
      </Progress>
      <dl className="metric-detail-list">
        <div className="metric-detail">
          <dt>Used</dt>
          <dd>{formatGiB(value.used)}</dd>
        </div>
        <div className="metric-detail">
          <dt>Available</dt>
          <dd>{formatGiB(value.available)}</dd>
        </div>
        <div className="metric-detail">
          <dt>Total</dt>
          <dd>{formatGiB(value.total)}</dd>
        </div>
      </dl>
    </>
  );
}

function storageStatus(
  root: MetricState<DiskSpace, "bytes">,
  data: MetricState<DiskSpace, "bytes">,
  initialLoading: boolean,
): ReadingStatus {
  if (!root.measurement && !data.measurement) return initialLoading ? "loading" : "unavailable";
  if (root.stale || data.stale) return "stale";
  return "available";
}

function StorageItem({
  mount,
  status,
  measurement,
}: {
  mount: string;
  status: ReadingStatus;
  measurement: AvailableMeasurement<DiskSpace, "bytes"> | null;
}) {
  return (
    <div className="storage-item" data-state={status}>
      <header className="storage-item__header">
        <h3>{mount}</h3>
        <StatusBadge status={status} />
      </header>
      {status === "loading" ? (
        <Skeleton className="storage-item__skeleton" />
      ) : measurement ? (
        <>
          <p className="storage-item__value">
            {formatGiB(measurement.value.used)} / {formatGiB(measurement.value.total)}
          </p>
          <Progress
            className="storage-item__progress"
            value={formatPercentage(measurement.value.used, measurement.value.total)}
            aria-label={`${mount}: ${formatGiB(measurement.value.used)} used of ${formatGiB(measurement.value.total)}`}
          />
        </>
      ) : (
        <p className="storage-item__empty">No measurement</p>
      )}
    </div>
  );
}

function StorageReading({
  root,
  data,
  initialLoading,
}: {
  root: MetricState<DiskSpace, "bytes">;
  data: MetricState<DiskSpace, "bytes">;
  initialLoading: boolean;
}) {
  return (
    <MetricCard
      title="Storage"
      icon={<HardDrive className="metric-card__icon" aria-hidden="true" />}
      status={storageStatus(root, data, initialLoading)}
    >
      <div className="storage-list">
        <StorageItem
          mount="/"
          status={readingStatus(root, initialLoading)}
          measurement={root.measurement}
        />
        <StorageItem
          mount="/data"
          status={readingStatus(data, initialLoading)}
          measurement={data.measurement}
        />
      </div>
    </MetricCard>
  );
}

export function MetricsDashboard() {
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
      if (inFlight || disposed || document.visibilityState !== "visible") {
        return;
      }

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
        if (!response.ok) {
          throw new Error(`Metrics request failed with ${response.status}`);
        }

        const payload: unknown = await response.json();
        if (!isHostMetrics(payload)) {
          throw new Error("Metrics response did not match the expected contract");
        }

        if (!disposed) {
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
      if (document.visibilityState !== "visible") {
        return;
      }

      requestImmediateRefresh();
      if (intervalId === null) {
        intervalId = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        startPolling();
      } else {
        stopPolling();
      }
    };

    startPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopPolling();
    };
  }, []);

  const cpuStatus = readingStatus(metrics.cpu, initialLoading);
  const uptimeStatus = readingStatus(metrics.uptime, initialLoading);
  const ramStatus = readingStatus(metrics.ram, initialLoading);
  const cpu = metrics.cpu.measurement;
  const uptime = metrics.uptime.measurement;
  const ram = metrics.ram.measurement;
  const unavailableCause: UnavailableCause = requestFailure ? "request" : "metric";
  const cpuHistory = useCpuHistory({
    status: cpuStatus,
    value: cpu?.value ?? null,
    observedAt: cpu?.observedAt ?? null,
  });
  const lastUpdated = [
    metrics.cpu.measurement,
    metrics.uptime.measurement,
    metrics.ram.measurement,
    metrics.rootFilesystem.measurement,
    metrics.dataFilesystem.measurement,
  ].reduce<string | null>((latest, measurement) => {
    if (!measurement || !latest) return measurement?.observedAt ?? latest;
    return Date.parse(measurement.observedAt) > Date.parse(latest)
      ? measurement.observedAt
      : latest;
  }, null);
  const updateStatus: ReadingStatus = initialLoading
    ? "loading"
    : lastUpdated
      ? requestFailure
        ? "stale"
        : "available"
      : "unavailable";

  return (
    <section className="metrics-section" aria-label="Server measurements">
      <div className="metrics-toolbar">
        <span className="metrics-toolbar__label">
          {lastUpdated ? (
            <time dateTime={lastUpdated}>Last update {formatObservedAt(lastUpdated)}</time>
          ) : (
            "No update received"
          )}
        </span>
        <ReadingInfo
          title="Server readings"
          observedAt={lastUpdated}
          status={updateStatus}
          detail="The displayed readings share the latest successful observation time."
        />
      </div>
      {requestFailure && (
        <Alert variant="destructive" className="metrics-request-alert">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Metrics request failed</AlertTitle>
          <AlertDescription>
            The Dashboard could not refresh Server readings. Retained measurements are marked stale.
          </AlertDescription>
        </Alert>
      )}
      <UptimeInline
        status={uptimeStatus}
        value={uptime?.value ?? null}
        unavailableCause={unavailableCause}
      />
      <div className="metrics-grid">
        <MetricCard
          title="CPU"
          icon={<Cpu className="metric-card__icon" aria-hidden="true" />}
          status={cpuStatus}
          readingKind="cpu"
        >
          {cpuStatus === "loading" && <LoadingReading label="CPU" />}
          {cpu && (
            <p className="metric-value" aria-live="polite" aria-atomic="true">
              {formatCpu(cpu.value)}
            </p>
          )}
          {!cpu && cpuStatus !== "loading" && (
            <UnavailableReading cause={unavailableCause} />
          )}
          <CpuHistoryChart
            history={cpuHistory}
            emptyMessage={cpuStatus === "unavailable" ? "History unavailable" : undefined}
            emptyDescription={
              cpuStatus === "unavailable"
                ? "A graph will appear after a successful CPU observation."
                : undefined
            }
          />
        </MetricCard>

        <MetricCard
          title="RAM"
          icon={<MemoryStick className="metric-card__icon" aria-hidden="true" />}
          status={ramStatus}
        >
          {ramStatus === "loading" ? (
            <LoadingReading label="RAM" />
          ) : ram ? (
            <CapacityReading label="RAM" value={ram.value} />
          ) : (
            <UnavailableReading cause={unavailableCause} />
          )}
        </MetricCard>

        <StorageReading
          root={metrics.rootFilesystem}
          data={metrics.dataFilesystem}
          initialLoading={initialLoading}
        />
      </div>
    </section>
  );
}
