"use client";

import { AlertTriangle, Clock3, MemoryStick, Radio, Unplug } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
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
import type { HostMetrics, Measurement, RamUsage } from "@/lib/metrics-contract";

const POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type AvailableMeasurement<T, U extends string> = Extract<Measurement<T, U>, { status: "available" }>;
type MetricState<T, U extends string> = {
  measurement: AvailableMeasurement<T, U> | null;
  stale: boolean;
};

type DashboardState = {
  uptime: MetricState<number, "seconds">;
  ram: MetricState<RamUsage, "bytes">;
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
  uptime: emptyMetric<number, "seconds">(),
  ram: emptyMetric<RamUsage, "bytes">(),
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

function isUnavailableMeasurement(value: unknown, unit: "seconds" | "bytes"): boolean {
  return (
    isRecord(value) &&
    value.status === "unavailable" &&
    value.value === null &&
    value.unit === unit &&
    value.observedAt === null
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
    used <= total &&
    available <= total &&
    used === total - available
  );
}

function isHostMetrics(value: unknown): value is HostMetrics {
  return (
    isRecord(value) &&
    isUptimeMeasurement(value.uptime) &&
    isRamMeasurement(value.ram)
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

  return (
    <Badge variant="secondary">
      <Radio data-icon="inline-start" aria-hidden="true" />
      Current
    </Badge>
  );
}

function MetricCard({
  title,
  description,
  icon,
  status,
  observedAt,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  status: ReadingStatus;
  observedAt: string | null;
  children: ReactNode;
}) {
  return (
    <Card className="metric-card" data-state={status}>
      <CardHeader>
        <div>
          <div className="metric-card__title-row">
            {icon}
            <CardTitle>{title}</CardTitle>
          </div>
          <CardDescription>{description}</CardDescription>
        </div>
        <CardAction>
          <StatusBadge status={status} />
        </CardAction>
      </CardHeader>
      <CardContent className="metric-card__content">{children}</CardContent>
      <CardFooter className="metric-footer">
        <Clock3 aria-hidden="true" />
        {observedAt ? (
          <time dateTime={observedAt}>Last updated {formatObservedAt(observedAt)}</time>
        ) : (
          "No observation received"
        )}
      </CardFooter>
    </Card>
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
            uptime: reconcileMetric(previous.uptime, payload.uptime),
            ram: reconcileMetric(previous.ram, payload.ram),
          }));
          setInitialLoading(false);
          setRequestFailure(false);
        }
      } catch {
        const abortedWithoutTimeout = controller.signal.aborted && !request.timedOut;
        if (!disposed && !abortedWithoutTimeout) {
          setMetrics((previous) => ({
            uptime: retainAfterRequestFailure(previous.uptime),
            ram: retainAfterRequestFailure(previous.ram),
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

  const uptimeStatus = readingStatus(metrics.uptime, initialLoading);
  const ramStatus = readingStatus(metrics.ram, initialLoading);
  const uptime = metrics.uptime.measurement;
  const ram = metrics.ram.measurement;
  const unavailableCause: UnavailableCause = requestFailure ? "request" : "metric";

  return (
    <section className="metrics-section" aria-label="Server measurements">
      {requestFailure && (
        <Alert variant="destructive" className="metrics-request-alert">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Metrics request failed</AlertTitle>
          <AlertDescription>
            The Dashboard could not refresh Server readings. Retained measurements are marked stale.
          </AlertDescription>
        </Alert>
      )}
      <div className="metrics-grid">
        <MetricCard
          title="Uptime"
          description="Server uptime since boot"
          icon={<Clock3 className="metric-card__icon" aria-hidden="true" />}
          status={uptimeStatus}
          observedAt={uptime?.observedAt ?? null}
        >
          {uptimeStatus === "loading" ? (
            <LoadingReading label="uptime" />
          ) : uptime ? (
            <p className="metric-value" aria-live="polite" aria-atomic="true">
              {formatUptime(uptime.value)}
            </p>
          ) : (
            <UnavailableReading cause={unavailableCause} />
          )}
        </MetricCard>

        <MetricCard
          title="RAM"
          description="Available memory accounts for reclaimable memory"
          icon={<MemoryStick className="metric-card__icon" aria-hidden="true" />}
          status={ramStatus}
          observedAt={ram?.observedAt ?? null}
        >
          {ramStatus === "loading" ? (
            <LoadingReading label="RAM" />
          ) : ram ? (
            <>
              <p className="metric-value" aria-live="polite" aria-atomic="true">
                {formatGiB(ram.value.used)}
                <span className="metric-value__unit"> used</span>
              </p>
              <Progress
                className="metric-progress"
                value={formatPercentage(ram.value.used, ram.value.total)}
                aria-label={`RAM used: ${formatGiB(ram.value.used)} of ${formatGiB(ram.value.total)}`}
              >
                <ProgressLabel>RAM used</ProgressLabel>
                <ProgressValue>{(_, value) => `${Math.round(value ?? 0)}%`}</ProgressValue>
              </Progress>
              <dl className="metric-detail-list">
                <div className="metric-detail">
                  <dt>Used</dt>
                  <dd>{formatGiB(ram.value.used)}</dd>
                </div>
                <div className="metric-detail">
                  <dt>Available</dt>
                  <dd>{formatGiB(ram.value.available)}</dd>
                </div>
                <div className="metric-detail">
                  <dt>Total</dt>
                  <dd>{formatGiB(ram.value.total)}</dd>
                </div>
              </dl>
            </>
          ) : (
            <UnavailableReading cause={unavailableCause} />
          )}
        </MetricCard>
      </div>
    </section>
  );
}
