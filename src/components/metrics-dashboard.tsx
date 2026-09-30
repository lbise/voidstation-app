"use client";

import { AlertTriangle, Server, Unplug } from "lucide-react";
import type { ReactNode } from "react";

import { CpuHistoryChart } from "@/components/cpu-history";
import { ReadingInfo } from "@/components/reading-info";
import {
  formatCpu,
  formatGiB,
  formatObservedAt,
  formatPercentage,
  formatUptime,
  readingStatus,
  useServerMetrics,
  type MetricState,
  type ReadingStatus,
} from "@/components/server-metrics";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { DiskSpace } from "@/lib/metrics-contract";

function StatusBadge({ status }: { status: ReadingStatus }) {
  if (status === "available") return null;
  return (
    <Badge variant={status === "stale" ? "warning" : status === "loading" ? "secondary" : "outline"}>
      {status === "stale" && <AlertTriangle data-icon="inline-start" aria-hidden="true" />}
      {status === "unavailable" && <Unplug data-icon="inline-start" aria-hidden="true" />}
      {status === "stale" ? "Stale reading" : status === "loading" ? "Loading" : "Unavailable"}
    </Badge>
  );
}

function Observation({
  title, status, observedAt, detail,
}: {
  title: string;
  status: ReadingStatus;
  observedAt: string | null;
  detail: string;
}) {
  return (
    <div className="metric-observation" data-state={status}>
      <span>
        {status === "stale" && observedAt ? (
          <>Retained from <time dateTime={observedAt}>{formatObservedAt(observedAt)}</time>. Retrying when visible.</>
        ) : status === "available" ? "Current reading" : status === "loading" ? "Waiting for a reading" : "Retrying when visible"}
      </span>
      <ReadingInfo title={title} observedAt={observedAt} status={status} detail={detail} />
    </div>
  );
}

function MetricCard({
  title, status, children, description, kind, action, footer,
}: {
  title: string;
  status: ReadingStatus;
  children: ReactNode;
  description?: string;
  kind: "cpu" | "ram" | "uptime" | "disk";
  action?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="metric-card" data-reading={kind} data-state={status}>
      <CardHeader>
        <CardTitle><h2>{title}</h2></CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        <CardAction>{action ?? <StatusBadge status={status} />}</CardAction>
      </CardHeader>
      <CardContent className="metric-card__content">{children}</CardContent>
      {footer && <CardFooter>{footer}</CardFooter>}
    </Card>
  );
}

function ScalarReading({ label, value }: { label: string; value: string }) {
  return (
    <dl className="scalar-reading">
      <dt>{label}</dt>
      <dd aria-live="polite" aria-atomic="true">{value}</dd>
    </dl>
  );
}

function LoadingReading({ label }: { label: string }) {
  return (
    <div className="metric-loading" role="status">
      <Skeleton className="metric-skeleton metric-skeleton--value" />
      <Skeleton className="metric-skeleton metric-skeleton--line" />
      <p>Loading {label} reading…</p>
    </div>
  );
}

function UnavailableReading({ requestFailure, mount = false }: { requestFailure: boolean; mount?: boolean }) {
  return (
    <Empty className="metric-empty">
      <EmptyHeader>
        <EmptyTitle>{mount ? "No measurement" : "Unavailable"}</EmptyTitle>
        <EmptyDescription>
          {requestFailure ? "The Dashboard could not request this measurement." : "The Server did not provide this measurement."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function CapacityReading({ label, value, stale }: { label: string; value: DiskSpace; stale: boolean }) {
  const percent = formatPercentage(value.used, value.total);
  const percentage = formatCpu(percent);
  return (
    <div className="capacity-reading" role="group" aria-label={`${label} capacity`} data-stale={stale}>
      <dl className="capacity-used">
        <dt>Used</dt>
        <dd><span>{formatGiB(value.used)}</span><span className="capacity-percentage">{percentage}</span></dd>
      </dl>
      <Progress
        className="capacity-progress"
        value={percent}
        aria-label={`${label} usage${stale ? ", stale reading" : ""}`}
        aria-valuetext={`${formatGiB(value.used)} of ${formatGiB(value.total)}, ${percentage}${stale ? ", historical measurement" : ""}`}
      />
      <dl className="capacity-details">
        <div><dt>Total capacity</dt><dd>{formatGiB(value.total)}</dd></div>
        <div><dt>Available</dt><dd>{formatGiB(value.available)}</dd></div>
      </dl>
    </div>
  );
}

function StorageItem({ mount, reading, initialLoading, requestFailure }: {
  mount: string;
  reading: MetricState<DiskSpace, "bytes">;
  initialLoading: boolean;
  requestFailure: boolean;
}) {
  const status = readingStatus(reading, initialLoading);
  return (
    <section className="storage-item" data-state={status} aria-label={`Disk space on ${mount}`}>
      <header className="storage-item__header">
        <h3>{mount}</h3>
        <StatusBadge status={status} />
      </header>
      {status === "loading" ? <LoadingReading label={mount} /> : reading.measurement ? (
        <CapacityReading label={mount} value={reading.measurement.value} stale={reading.stale} />
      ) : <UnavailableReading requestFailure={requestFailure} mount />}
      <Observation
        title={`Disk space on ${mount}`}
        observedAt={reading.measurement?.observedAt ?? null}
        status={status}
        detail="Capacity, used space and available space for this mounted filesystem. A retained reading is historical, not the current state."
      />
    </section>
  );
}

export function MetricsDashboard() {
  const { metrics, initialLoading, requestFailure, cpuHistory, lastUpdated } = useServerMetrics();
  const statuses = Object.values(metrics).map((reading) => readingStatus(reading, initialLoading));
  const allCurrent = statuses.every((status) => status === "available");
  const anyStale = statuses.includes("stale");
  const updateStatus: ReadingStatus = initialLoading ? "loading" : allCurrent ? "available" : anyStale ? "stale" : "unavailable";
  const cpuStatus = readingStatus(metrics.cpu, initialLoading);
  const ramStatus = readingStatus(metrics.ram, initialLoading);
  const uptimeStatus = readingStatus(metrics.uptime, initialLoading);
  const cpu = metrics.cpu.measurement;
  const ram = metrics.ram.measurement;
  const uptime = metrics.uptime.measurement;
  const diskStatuses = [metrics.rootFilesystem, metrics.dataFilesystem].map((reading) => readingStatus(reading, initialLoading));
  const diskStatus: ReadingStatus = diskStatuses.includes("stale") ? "stale"
    : diskStatuses.includes("loading") ? "loading"
    : diskStatuses.includes("unavailable") ? "unavailable" : "available";
  const samples = cpuHistory.samples.map((sample) => sample.percent);
  const summary = samples.length ? {
    min: Math.min(...samples),
    average: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    peak: Math.max(...samples),
  } : null;

  return (
    <section className="metrics-section" aria-label="Server measurements">
      <header className="metrics-heading">
        <div className="metrics-heading__identity">
          <span className="metrics-heading__icon"><Server aria-hidden="true" /></span>
          <div>
            <h1>Dashboard</h1>
            <div className="metrics-heading__subtitle">
              <span>Home Server</span>
              <Badge variant={allCurrent ? "secondary" : anyStale ? "warning" : "outline"} data-live={allCurrent}>
                {initialLoading ? "Loading" : allCurrent ? "Live" : anyStale ? "Stale readings" : statuses.includes("available") ? "Some readings unavailable" : "Readings unavailable"}
              </Badge>
            </div>
          </div>
        </div>
        <div className="metrics-toolbar">
          <div className="metrics-toolbar__text">
            {lastUpdated ? <time dateTime={lastUpdated}>Last update {formatObservedAt(lastUpdated)}</time> : <span>No update received</span>}
            <span>Refreshes every 5 s while visible</span>
          </div>
          <ReadingInfo
            title="Server readings"
            observedAt={lastUpdated}
            status={updateStatus}
            detail="The most recent observation among the displayed readings. Individual observation times and ages may differ; check each reading for its own time and status."
          />
        </div>
      </header>
      {requestFailure && (
        <Alert variant="destructive" className="metrics-request-alert">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Metrics request failed</AlertTitle>
          <AlertDescription>Retained measurements are stale. Refreshing will retry while this tab is visible.</AlertDescription>
        </Alert>
      )}
      <div className="metrics-grid">
        <MetricCard
          title="CPU"
          kind="cpu"
          status={cpuStatus}
          description="Utilization · samples from this visit"
          action={(
            <div className="cpu-current">
              {cpu && <ScalarReading label="Utilization" value={formatCpu(cpu.value)} />}
              <StatusBadge status={cpuStatus} />
            </div>
          )}
          footer={(
            <div className="cpu-summary">
              {summary && <dl>
                <div><dt>Min</dt><dd>{formatCpu(summary.min)}</dd></div>
                <div><dt>Average</dt><dd>{formatCpu(summary.average)}</dd></div>
                <div><dt>Peak</dt><dd>{formatCpu(summary.peak)}</dd></div>
              </dl>}
              <Observation
                title="CPU"
                observedAt={cpu?.observedAt ?? null}
                status={cpuStatus}
                detail="CPU utilization at this observation time. The chart contains only successful samples from this visit, up to five minutes. Gaps mark missing observations. Reloading clears history."
              />
            </div>
          )}
        >
          {cpuStatus === "loading" && <LoadingReading label="CPU" />}
          {!cpu && cpuStatus !== "loading" && <UnavailableReading requestFailure={requestFailure} />}
          {(cpu || cpuHistory.samples.length > 0) && <CpuHistoryChart history={cpuHistory} />}
        </MetricCard>
        <div className="metrics-side">
          <MetricCard title="RAM" kind="ram" status={ramStatus} footer={(
            <Observation title="RAM" observedAt={ram?.observedAt ?? null} status={ramStatus}
              detail="Used, available and total Server RAM at this observation time. A retained reading is historical, not the current state." />
          )}>
            {ramStatus === "loading" ? <LoadingReading label="RAM" /> : ram ? (
              <CapacityReading label="RAM" value={ram.value} stale={metrics.ram.stale} />
            ) : <UnavailableReading requestFailure={requestFailure} />}
          </MetricCard>
          <MetricCard title="Uptime" kind="uptime" status={uptimeStatus} footer={(
            <Observation title="Uptime" observedAt={uptime?.observedAt ?? null} status={uptimeStatus}
              detail="Time since the Server booted, not since Voidstation started. A retained reading does not continue counting after refreshing fails." />
          )}>
            {uptimeStatus === "loading" ? <LoadingReading label="uptime" /> : uptime ? (
              <ScalarReading label="Since boot" value={formatUptime(uptime.value)} />
            ) : <UnavailableReading requestFailure={requestFailure} />}
          </MetricCard>
        </div>
      </div>
      <MetricCard title="Disk space" kind="disk" status={diskStatus} description="Mounted filesystems" action={<span />}>
        <div className="storage-list">
          <StorageItem mount="/" reading={metrics.rootFilesystem} initialLoading={initialLoading} requestFailure={requestFailure} />
          <StorageItem mount="/data" reading={metrics.dataFilesystem} initialLoading={initialLoading} requestFailure={requestFailure} />
        </div>
      </MetricCard>
    </section>
  );
}
