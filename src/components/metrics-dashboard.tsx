"use client";

import { AlertTriangle, Server } from "lucide-react";
import { useId } from "react";

import { CpuHistoryChart } from "@/components/cpu-history";
import {
  CapacityReading, LoadingReading, MetricCard, ScalarReading, StaleNote, StatusBadge, UnavailableReading,
} from "@/components/metric-card";
import { DownloadQueueCard, useDownloadQueue } from "@/components/download-queue";
import { ReadingInfo } from "@/components/reading-info";
import { DriveHealthCard, HostStatusLine, LoadSummary, PressureCard, SwapDetails } from "@/components/server-health";
import {
  formatCpu,
  formatObservedAt,
  liveReadings,
  readingStatus,
  uptimeParts,
  useServerMetrics,
  type MetricState,
  type ReadingStatus,
} from "@/components/server-metrics";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { DiskSpace, HostStatus } from "@/lib/metrics-contract";

function DiskCard({ mount, reading, initialLoading, requestFailure }: {
  mount: string;
  reading: MetricState<DiskSpace, "bytes">;
  initialLoading: boolean;
  requestFailure: boolean;
}) {
  const status = readingStatus(reading, initialLoading);
  return (
    <MetricCard
      title={<>Disk space <span className="visually-hidden">on</span>{" "}<span className="metric-card__mount">{mount}</span></>}
      kind="disk"
      status={status}
      footer={status === "stale" && (
        <StaleNote title={`Disk space on ${mount}`} observedAt={reading.measurement?.observedAt ?? null} status={status}
          detail="Capacity, used space and available space for this mounted filesystem. A retained reading is historical, not the current state." />
      )}
    >
      {status === "loading" ? <LoadingReading label={mount} /> : reading.measurement ? (
        <CapacityReading label={mount} value={reading.measurement.value} stale={reading.stale} />
      ) : <UnavailableReading requestFailure={requestFailure} mount />}
    </MetricCard>
  );
}

function UptimeReading({ reading, status, requestFailure, hostStatus, hostStatusStatus }: {
  reading: MetricState<number, "seconds">;
  status: ReadingStatus;
  requestFailure: boolean;
  hostStatus: MetricState<HostStatus, "status">;
  hostStatusStatus: ReadingStatus;
}) {
  const uptime = reading.measurement;
  const headingId = useId();
  return (
    <section className="uptime-reading" data-state={status} aria-labelledby={headingId}>
      <div className="uptime-reading__label">
        <h2 id={headingId}>Uptime</h2>
        <StatusBadge status={status} />
      </div>
      {status === "loading" ? (
        <Skeleton className="metric-skeleton metric-skeleton--value" />
      ) : uptime ? (
        <p className="uptime-reading__value" aria-live="polite" aria-atomic="true">
          {uptimeParts(uptime.value).map(({ value, unit }, index) => (
            <span key={unit}>{index > 0 && " "}<span className="uptime-reading__number">{value}</span> <span className="uptime-reading__unit">{unit}</span></span>
          ))}
        </p>
      ) : (
        <p className="uptime-reading__empty">
          {requestFailure ? "The Dashboard could not request this measurement." : "The Server did not provide this measurement."}
        </p>
      )}
      <HostStatusLine reading={hostStatus} status={hostStatusStatus} />
      <StaleNote title="Uptime" observedAt={uptime?.observedAt ?? null} status={status}
        detail="Time since the Server booted, not since Voidstation started. A retained reading does not continue counting after refreshing fails." />
    </section>
  );
}

export function MetricsDashboard() {
  const { metrics, initialLoading, requestFailure, cpuHistory, lastUpdated } = useServerMetrics();
  const downloads = useDownloadQueue();
  const statuses = liveReadings(metrics).map((reading) => readingStatus(reading, initialLoading));
  const allCurrent = statuses.every((status) => status === "available");
  const anyStale = statuses.includes("stale");
  const updateStatus: ReadingStatus = initialLoading ? "loading" : allCurrent ? "available" : anyStale ? "stale" : "unavailable";
  const cpuStatus = readingStatus(metrics.cpu, initialLoading);
  const ramStatus = readingStatus(metrics.ram, initialLoading);
  const uptimeStatus = readingStatus(metrics.uptime, initialLoading);
  const hostStatusStatus = readingStatus(metrics.hostStatus, initialLoading);
  const cpu = metrics.cpu.measurement;
  const ram = metrics.ram.measurement;
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
              {lastUpdated
                ? <time dateTime={lastUpdated}>Updated {formatObservedAt(lastUpdated)}</time>
                : !initialLoading && <span>No update received</span>}
              <ReadingInfo
                title="Server readings"
                observedAt={lastUpdated}
                status={updateStatus}
                detail="The most recent observation among the displayed readings. Readings refresh every 5 seconds while this tab is visible. Individual observation times and ages may differ; a stale reading shows its own time."
              />
            </div>
          </div>
        </div>
        <UptimeReading reading={metrics.uptime} status={uptimeStatus} requestFailure={requestFailure}
          hostStatus={metrics.hostStatus} hostStatusStatus={hostStatusStatus} />
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
          action={(
            <div className="cpu-current">
              {cpu && <ScalarReading label="Utilization" value={formatCpu(cpu.value)} />}
              <StatusBadge status={cpuStatus} />
            </div>
          )}
          footer={(summary || metrics.load.measurement || cpuStatus === "stale") && (
            <div className="cpu-summary">
              <div className="cpu-summary__row">
                {summary && <dl>
                  <div><dt>Min</dt><dd>{formatCpu(summary.min)}</dd></div>
                  <div><dt>Average</dt><dd>{formatCpu(summary.average)}</dd></div>
                  <div><dt>Peak</dt><dd>{formatCpu(summary.peak)}</dd></div>
                </dl>}
                <LoadSummary reading={metrics.load} />
              </div>
              <StaleNote
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
        <div className="metrics-capacity">
          <MetricCard title="RAM" kind="ram" status={ramStatus} footer={ramStatus === "stale" && (
            <StaleNote title="RAM" observedAt={ram?.observedAt ?? null} status={ramStatus}
              detail="Used, available and total Server RAM at this observation time. A retained reading is historical, not the current state." />
          )}>
            {ramStatus === "loading" ? <LoadingReading label="RAM" /> : ram ? (
              <>
                <CapacityReading label="RAM" value={ram.value} stale={metrics.ram.stale} />
                <SwapDetails reading={metrics.swap} />
              </>
            ) : <UnavailableReading requestFailure={requestFailure} />}
          </MetricCard>
          <DiskCard mount="/" reading={metrics.rootFilesystem} initialLoading={initialLoading} requestFailure={requestFailure} />
          <DiskCard mount="/data" reading={metrics.dataFilesystem} initialLoading={initialLoading} requestFailure={requestFailure} />
        </div>
        <div className="metrics-activity">
          <DownloadQueueCard {...downloads} />
          <PressureCard reading={metrics.pressure} status={readingStatus(metrics.pressure, initialLoading)} requestFailure={requestFailure} />
        </div>
        <DriveHealthCard reading={metrics.hostStatus} status={hostStatusStatus} />
      </div>
    </section>
  );
}
