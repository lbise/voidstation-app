"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

import { LoadingReading, MetricCard, StaleNote, UnavailableReading } from "@/components/metric-card";
import { formatGiB, formatObservedAt, type MetricState, type ReadingStatus } from "@/components/server-metrics";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { DriveHealth, HostStatus, LoadAverage, Pressure, SwapUsage } from "@/lib/metrics-contract";

const PRESSURE_WARNING = 10;
const DRIVE_TEMPERATURE_WARNING = 60;

function formatLoad(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatStall(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 })}%`;
}

export function formatPowerOn(hours: number): string {
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = hours / 24;
  if (days < 365) return `${Math.round(days)} days`;
  return `${(days / 365).toLocaleString(undefined, { maximumFractionDigits: 1 })} years`;
}

/** Pending updates and reboot state under the Uptime figure. */
export function HostStatusLine({ reading, status }: { reading: MetricState<HostStatus, "status">; status: ReadingStatus }) {
  const measurement = reading.measurement;
  if (status === "loading") return null;
  if (!measurement) return <p className="host-status-line" data-state={status}>Update check unavailable</p>;
  const { rebootRequired, rebootPackages, updates } = measurement.value;
  return (
    <p className="host-status-line" data-state={status}>
      {rebootRequired && (
        <Badge variant="warning" title={rebootPackages.length ? `Requested by ${rebootPackages.join(", ")}` : undefined}>
          <RotateCcw data-icon="inline-start" aria-hidden="true" />Reboot required
        </Badge>
      )}
      <span>
        {updates === null ? "Update count unavailable"
          : updates.total === 0 ? "Up to date"
          : `${updates.total} update${updates.total === 1 ? "" : "s"}${updates.security ? `, ${updates.security} security` : ""}`}
      </span>
      <span className="host-status-line__checked">
        checked <time dateTime={measurement.observedAt}>{formatObservedAt(measurement.observedAt)}</time>
      </span>
    </p>
  );
}

/** Load averages beside CPU utilization: load above the core count means work is queuing. */
export function LoadSummary({ reading }: { reading: MetricState<LoadAverage, "tasks"> }) {
  const load = reading.measurement?.value;
  if (!load) return null;
  const busy = load.one > load.cores;
  return (
    <dl className="cpu-load" data-busy={busy} data-stale={reading.stale}
      aria-label={`Load average ${formatLoad(load.one)} over 1 minute, ${formatLoad(load.five)} over 5 minutes, ${formatLoad(load.fifteen)} over 15 minutes, on ${load.cores} cores`}>
      <div><dt>Load</dt><dd>{formatLoad(load.one)} <span>{formatLoad(load.five)} {formatLoad(load.fifteen)}</span></dd></div>
      <div><dt>Cores</dt><dd>{load.cores}</dd></div>
    </dl>
  );
}

export function SwapDetails({ reading }: { reading: MetricState<SwapUsage, "bytes"> }) {
  const swap = reading.measurement?.value;
  if (!swap) return null;
  return (
    <dl className="capacity-details capacity-swap" data-stale={reading.stale}>
      <div><dt>Swap</dt><dd>{swap.total === 0 ? "None" : `${formatGiB(swap.used)} of ${formatGiB(swap.total)}`}</dd></div>
    </dl>
  );
}

const pressureRows = [["cpu", "CPU"], ["memory", "Memory"], ["io", "Disk I/O"]] as const;

export function PressureCard({ reading, status, requestFailure }: {
  reading: MetricState<Pressure, "percent">;
  status: ReadingStatus;
  requestFailure: boolean;
}) {
  const pressure = reading.measurement?.value;
  return (
    <MetricCard title="Pressure" kind="pressure" status={status} footer={status === "stale" && (
      <StaleNote title="Pressure" observedAt={reading.measurement?.observedAt ?? null} status={status}
        detail="Share of time at least one task waited for CPU, memory or disk I/O. A retained reading is historical, not the current state." />
    )}>
      {status === "loading" ? <LoadingReading label="pressure" /> : pressure ? (
        <>
          <p className="metric-note">Time tasks spent waiting, last 10 seconds</p>
          <ul className="pressure-list">
            {pressureRows.map(([key, label]) => {
              const stall = pressure[key];
              return (
                <li key={key} data-high={stall.avg10 >= PRESSURE_WARNING} title={`1 minute average ${formatStall(stall.avg60)}`}>
                  <span className="pressure-list__label">{label}</span>
                  <Progress className="capacity-progress" value={stall.avg10}
                    aria-label={`${label} pressure${reading.stale ? ", stale reading" : ""}`}
                    aria-valuetext={`${formatStall(stall.avg10)} over 10 seconds, ${formatStall(stall.avg60)} over 1 minute`} />
                  <span className="pressure-list__value">{formatStall(stall.avg10)}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : <UnavailableReading requestFailure={requestFailure} />}
    </MetricCard>
  );
}

type Assessment = { label: string; tone: "ok" | "warning" | "danger" | "muted" };

export function assessDrive(drive: DriveHealth): Assessment {
  if (drive.standby) return { label: "Asleep", tone: "muted" };
  if (drive.passed === false) return { label: "Failing", tone: "danger" };
  if ((drive.reallocatedSectors ?? 0) > 0 || (drive.pendingSectors ?? 0) > 0 ||
    (drive.mediaErrors ?? 0) > 0 || (drive.percentageUsed ?? 0) >= 90) return { label: "Needs attention", tone: "warning" };
  if (drive.passed === true) return { label: "Healthy", tone: "ok" };
  return { label: "Unknown", tone: "muted" };
}

function DriveRow({ drive }: { drive: DriveHealth }) {
  const assessment = assessDrive(drive);
  const facts: [string, string, boolean?][] = [];
  if (drive.temperatureCelsius !== null) facts.push(["Temperature", `${drive.temperatureCelsius} °C`, drive.temperatureCelsius >= DRIVE_TEMPERATURE_WARNING]);
  if (drive.powerOnHours !== null) facts.push(["Powered on", formatPowerOn(drive.powerOnHours)]);
  if (drive.reallocatedSectors !== null) facts.push(["Reallocated sectors", String(drive.reallocatedSectors), drive.reallocatedSectors > 0]);
  if (drive.pendingSectors !== null) facts.push(["Pending sectors", String(drive.pendingSectors), drive.pendingSectors > 0]);
  if (drive.mediaErrors !== null) facts.push(["Media errors", String(drive.mediaErrors), drive.mediaErrors > 0]);
  if (drive.percentageUsed !== null) facts.push(["Endurance used", `${drive.percentageUsed}%`, drive.percentageUsed >= 90]);
  return (
    <li className="drive-item" data-tone={assessment.tone}>
      <div className="drive-item__head">
        <span className="drive-item__device">{drive.device}</span>
        <span className="drive-item__status">
          {(assessment.tone === "danger" || assessment.tone === "warning") && <AlertTriangle aria-hidden="true" />}
          {assessment.label}
        </span>
      </div>
      {drive.model && <p className="drive-item__model" title={drive.model}>{drive.model}</p>}
      {drive.standby ? (
        <p className="metric-note">Not woken to check. Figures appear when the drive is next awake during a check.</p>
      ) : facts.length > 0 && (
        <dl className="capacity-details">
          {facts.map(([label, value, flagged]) => (
            <div key={label} data-flagged={flagged || undefined}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function DriveHealthCard({ reading, status }: {
  reading: MetricState<HostStatus, "status">;
  status: ReadingStatus;
}) {
  const measurement = reading.measurement;
  const drives = measurement?.value.drives;
  const attention = drives?.filter((drive) => ["danger", "warning"].includes(assessDrive(drive).tone)).length ?? 0;
  return (
    <MetricCard
      title="Drive health"
      kind="drives"
      status={status}
      action={status === "available" && attention > 0
        ? <Badge variant="warning"><AlertTriangle data-icon="inline-start" aria-hidden="true" />{attention} need{attention === 1 ? "s" : ""} attention</Badge>
        : undefined}
      footer={measurement && (status === "stale" ? (
        <StaleNote title="Drive health" observedAt={measurement.observedAt} status={status}
          detail="SMART results from the host-status helper. A retained reading is historical, not the current state." />
      ) : (
        <p className="metric-note">SMART checked <time dateTime={measurement.observedAt}>{formatObservedAt(measurement.observedAt)}</time></p>
      ))}
    >
      {status === "loading" ? <LoadingReading label="drive health" /> : !measurement ? (
        <p className="metric-note">No report from the Server&apos;s host-status helper. It runs on the Server itself and checks SMART, updates and reboots every 15 minutes.</p>
      ) : drives === null || drives === undefined ? (
        <p className="metric-note">SMART is not available on the Server. Install smartmontools to see drive health.</p>
      ) : drives.length === 0 ? (
        <p className="metric-note">No drives reported SMART data.</p>
      ) : (
        <ul className="drive-list" aria-label="Drives">
          {drives.map((drive) => <DriveRow key={drive.device} drive={drive} />)}
        </ul>
      )}
    </MetricCard>
  );
}
