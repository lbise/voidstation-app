"use client";

import { AlertTriangle, Film, Tv } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { formatGiB, type ReadingStatus } from "@/components/server-metrics";
import { Badge } from "@/components/ui/badge";
import { MetricCard, StaleNote } from "@/components/metric-card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { DownloadItem, DownloadQueue, DownloadStatus, ServiceQueue } from "@/lib/downloads-contract";

const POLL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 8_000;
const VISIBLE_ITEMS = 6;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const STATUSES = new Set<DownloadStatus>(["downloading", "queued", "paused", "delayed", "importing", "completed", "warning", "failed"]);
const REASONS = new Set(["not_configured", "service_unavailable", "timed_out", "invalid_response"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value));
}

function isBytes(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isDownloadItem(value: unknown): value is DownloadItem {
  return isRecord(value) && typeof value.id === "string" &&
    (value.service === "radarr" || value.service === "sonarr") &&
    typeof value.title === "string" && STATUSES.has(value.status as DownloadStatus) &&
    (value.problem === null || typeof value.problem === "string") &&
    isBytes(value.size) && isBytes(value.sizeLeft) &&
    (value.progress === null || (typeof value.progress === "number" && value.progress >= 0 && value.progress <= 100)) &&
    (value.estimatedCompletion === null || isTime(value.estimatedCompletion));
}

function isServiceQueue(value: unknown): value is ServiceQueue {
  if (!isRecord(value)) return false;
  if (value.status === "unavailable") return REASONS.has(value.reason as string) && value.observedAt === null;
  return value.status === "available" && isTime(value.observedAt) && Array.isArray(value.items) &&
    value.items.length <= 50 && value.items.every(isDownloadItem) &&
    typeof value.total === "number" && Number.isSafeInteger(value.total) && value.total >= value.items.length;
}

function isDownloadQueue(value: unknown): value is DownloadQueue {
  return isRecord(value) && isServiceQueue(value.radarr) && isServiceQueue(value.sonarr);
}

export type DownloadQueueState = {
  queue: DownloadQueue | null;
  status: ReadingStatus;
};

/** Polls the download queue while the page is visible; a failed refresh keeps the last queue as stale. */
export function useDownloadQueue(): DownloadQueueState {
  const [queue, setQueue] = useState<DownloadQueue | null>(null);
  const [status, setStatus] = useState<ReadingStatus>("loading");
  const hasQueue = useRef(false);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let intervalId: number | null = null;
    let controller: AbortController | null = null;

    const refresh = async () => {
      if (inFlight || disposed || document.visibilityState !== "visible") return;
      inFlight = true;
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch("/api/downloads", {
          cache: "no-store", headers: { "Cache-Control": "no-store" }, signal: request.signal,
        });
        if (response.status === 401) {
          window.location.replace("/login");
          return;
        }
        if (!response.ok) throw new Error(`Download queue request failed with ${response.status}`);
        const payload: unknown = await response.json();
        if (!isDownloadQueue(payload)) throw new Error("Download queue response did not match the contract");
        if (!disposed) {
          hasQueue.current = true;
          setQueue(payload);
          setStatus("available");
        }
      } catch {
        if (!disposed && controller === request) {
          setStatus(hasQueue.current ? "stale" : "unavailable");
        }
      } finally {
        window.clearTimeout(timeout);
        if (controller === request) controller = null;
        inFlight = false;
      }
    };

    const stop = () => {
      if (intervalId !== null) window.clearInterval(intervalId);
      intervalId = null;
      controller?.abort();
      controller = null;
    };
    const start = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      if (intervalId === null) intervalId = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, []);

  return { queue, status };
}

const statusLabel: Record<DownloadStatus, string> = {
  downloading: "Downloading",
  queued: "Queued",
  paused: "Paused",
  delayed: "Delayed",
  importing: "Importing",
  completed: "Completed",
  warning: "Needs attention",
  failed: "Failed",
};

function relativeEta(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes <= 0) return "any moment";
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min left`;
  return `${Math.round(hours / 24)} days left`;
}

function DownloadRow({ item, stale }: { item: DownloadItem; stale: boolean }) {
  const problem = item.status === "failed" || item.status === "warning";
  const Icon = item.service === "radarr" ? Film : Tv;
  const transferred = item.size !== null && item.sizeLeft !== null ? Math.max(0, item.size - item.sizeLeft) : null;
  const detail = [
    transferred !== null && item.size ? `${formatGiB(transferred)} of ${formatGiB(item.size)}` : null,
    item.status === "downloading" && item.estimatedCompletion ? relativeEta(item.estimatedCompletion) : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="download-item" data-status={item.status} data-problem={problem}>
      <div className="download-item__head">
        <Icon aria-label={item.service === "radarr" ? "Movie" : "Series"} className="download-item__kind" />
        <span className="download-item__title" title={item.title}>{item.title}</span>
        <span className="download-item__status">
          {problem && <AlertTriangle aria-hidden="true" />}
          {statusLabel[item.status]}
        </span>
      </div>
      {item.progress !== null && (
        <Progress
          className="capacity-progress download-item__progress"
          value={item.progress}
          aria-label={`${item.title} progress${stale ? ", stale reading" : ""}`}
          aria-valuetext={`${Math.round(item.progress)}%${detail ? `, ${detail}` : ""}`}
        />
      )}
      {(detail || item.problem) && (
        <p className="download-item__detail">{item.problem ?? detail}</p>
      )}
    </li>
  );
}

const reasonText: Record<Extract<ServiceQueue, { status: "unavailable" }>["reason"], string> = {
  not_configured: "not configured",
  service_unavailable: "unreachable",
  timed_out: "timed out",
  invalid_response: "returned an unexpected response",
};

export function DownloadQueueCard({ queue, status }: DownloadQueueState) {
  const services = queue ? ([["Radarr", queue.radarr], ["Sonarr", queue.sonarr]] as const) : [];
  const items = services.flatMap(([, service]) => service.status === "available" ? service.items : [])
    .sort((a, b) => rank(a) - rank(b) || eta(a) - eta(b));
  const total = services.reduce((sum, [, service]) => sum + (service.status === "available" ? service.total : 0), 0);
  const problems = items.filter((item) => item.status === "failed" || item.status === "warning").length;
  const unavailable = services.filter(([, service]) => service.status === "unavailable");
  const observedAt = services.map(([, service]) => service.observedAt).filter((time): time is string => Boolean(time)).sort().at(-1);
  const stale = status === "stale";

  return (
    <MetricCard
      title="Downloads"
      kind="downloads"
      status={status}
      action={status !== "available" ? undefined : problems > 0
        ? <Badge variant="warning"><AlertTriangle data-icon="inline-start" aria-hidden="true" />{problems} need{problems === 1 ? "s" : ""} attention</Badge>
        : total > 0 ? <Badge variant="secondary">{total} in queue</Badge> : <span />}
      footer={stale && (
        <StaleNote title="Downloads" observedAt={observedAt ?? null} status={status}
          detail="The Radarr and Sonarr queue as last read. A retained queue is historical, not the current state." />
      )}
    >
      {status === "loading" ? (
        <div className="metric-loading" role="status">
          <Skeleton className="metric-skeleton metric-skeleton--line" />
          <p>Loading the download queue…</p>
        </div>
      ) : !queue ? (
        <p className="metric-note">The download queue is unavailable. Radarr and Sonarr are read through the Assistant worker.</p>
      ) : items.length === 0 ? (
        <p className="metric-note">{unavailable.length === 2 ? "Neither Radarr nor Sonarr could be read." : "Nothing is downloading."}</p>
      ) : (
        <ul className="download-list" aria-label="Download queue" data-stale={stale}>
          {items.slice(0, VISIBLE_ITEMS).map((item) => <DownloadRow key={item.id} item={item} stale={stale} />)}
        </ul>
      )}
      {queue && total > Math.min(items.length, VISIBLE_ITEMS) && (
        <p className="metric-note download-queue__more">{total - Math.min(items.length, VISIBLE_ITEMS)} more in the queue</p>
      )}
      {unavailable.length === 1 && unavailable.map(([name, service]) => service.status === "unavailable" && (
        <p key={name} className="metric-note download-queue__service">{name} {reasonText[service.reason]}.</p>
      ))}
    </MetricCard>
  );
}

function rank(item: DownloadItem): number {
  return item.status === "failed" ? 0 : item.status === "warning" ? 1 : item.status === "downloading" ? 2 : item.status === "importing" ? 3 : 4;
}

function eta(item: DownloadItem): number {
  return item.estimatedCompletion ? Date.parse(item.estimatedCompletion) : Number.MAX_SAFE_INTEGER;
}
