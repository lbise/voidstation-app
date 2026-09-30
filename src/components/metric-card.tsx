"use client";

import { AlertTriangle, Unplug } from "lucide-react";
import type { ReactNode } from "react";

import { ReadingInfo } from "@/components/reading-info";
import {
  formatCpu,
  formatGiB,
  formatObservedAt,
  formatPercentage,
  type ReadingStatus,
} from "@/components/server-metrics";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { DiskSpace } from "@/lib/metrics-contract";

export function StatusBadge({ status }: { status: ReadingStatus }) {
  if (status === "available") return null;
  return (
    <Badge variant={status === "stale" ? "warning" : status === "loading" ? "secondary" : "outline"}>
      {status === "stale" && <AlertTriangle data-icon="inline-start" aria-hidden="true" />}
      {status === "unavailable" && <Unplug data-icon="inline-start" aria-hidden="true" />}
      {status === "stale" ? "Stale reading" : status === "loading" ? "Loading" : "Unavailable"}
    </Badge>
  );
}

/** Only a retained reading needs its own time; current readings share the header's update time. */
export function StaleNote({
  title, status, observedAt, detail,
}: {
  title: string;
  status: ReadingStatus;
  observedAt: string | null;
  detail: string;
}) {
  if (status !== "stale" || !observedAt) return null;
  return (
    <div className="metric-observation" data-state={status}>
      <span>Retained from <time dateTime={observedAt}>{formatObservedAt(observedAt)}</time>. Retrying when visible.</span>
      <ReadingInfo title={title} observedAt={observedAt} status={status} detail={detail} />
    </div>
  );
}

export function MetricCard({
  title, status, children, kind, action, footer,
}: {
  title: ReactNode;
  status: ReadingStatus;
  children: ReactNode;
  kind: "cpu" | "ram" | "disk" | "pressure" | "drives" | "downloads";
  action?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="metric-card" data-reading={kind} data-state={status}>
      <CardHeader>
        <CardTitle><h2>{title}</h2></CardTitle>
        <CardAction>{action ?? <StatusBadge status={status} />}</CardAction>
      </CardHeader>
      <CardContent className="metric-card__content">{children}</CardContent>
      {footer && <CardFooter>{footer}</CardFooter>}
    </Card>
  );
}

export function ScalarReading({ label, value }: { label: string; value: string }) {
  return (
    <dl className="scalar-reading">
      <dt>{label}</dt>
      <dd aria-live="polite" aria-atomic="true">{value}</dd>
    </dl>
  );
}

export function LoadingReading({ label }: { label: string }) {
  return (
    <div className="metric-loading" role="status">
      <Skeleton className="metric-skeleton metric-skeleton--value" />
      <Skeleton className="metric-skeleton metric-skeleton--line" />
      <p>Loading {label} reading…</p>
    </div>
  );
}

export function UnavailableReading({ requestFailure, mount = false }: { requestFailure: boolean; mount?: boolean }) {
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

export function CapacityReading({ label, value, stale }: { label: string; value: DiskSpace; stale: boolean }) {
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
