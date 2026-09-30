"use client";

import { useEffect, useId, useRef, useState } from "react";

const HISTORY_WINDOW_MS = 5 * 60 * 1_000;
const MAX_SAMPLES = 120;
const MAX_CONTINUOUS_GAP_MS = 15 * 1_000;
const CHART_LEFT = 38;
const CHART_TOP = 12;
const CHART_BOTTOM = 220;

type CpuReading = Readonly<{
  status: "loading" | "available" | "stale" | "unavailable";
  value: number | null;
  observedAt: string | null;
}>;

export type CpuHistorySample = Readonly<{
  observedAt: string;
  percent: number;
  timestamp: number;
  breakBefore: boolean;
}>;

export type CpuHistory = Readonly<{
  samples: readonly CpuHistorySample[];
  windowEnd: number;
  windowStart: number;
}>;

function trimSamples(samples: readonly CpuHistorySample[], now: number) {
  const earliest = now - HISTORY_WINDOW_MS;
  return samples.filter((sample) => sample.timestamp >= earliest && sample.timestamp <= now);
}

function isCurrentReading(reading: CpuReading): reading is CpuReading & {
  status: "available";
  value: number;
  observedAt: string;
} {
  return (
    reading.status === "available" &&
    reading.observedAt !== null &&
    reading.value !== null &&
    Number.isFinite(reading.value) &&
    reading.value >= 0 &&
    reading.value <= 100 &&
    Number.isFinite(Date.parse(reading.observedAt))
  );
}

function chartX(timestamp: number, history: CpuHistory, width: number) {
  const range = Math.max(1, history.windowEnd - history.windowStart);
  return CHART_LEFT + ((timestamp - history.windowStart) / range) * (width - 8 - CHART_LEFT);
}

function chartY(percent: number) {
  return CHART_BOTTOM - (percent / 100) * (CHART_BOTTOM - CHART_TOP);
}

// Both the line and its fill use these segments, so neither crosses a gap.
function chartSegments(samples: readonly CpuHistorySample[]) {
  const segments: CpuHistorySample[][] = [];
  samples.forEach((sample, index) => {
    const previous = samples[index - 1];
    if (!previous || sample.breakBefore || sample.timestamp - previous.timestamp > MAX_CONTINUOUS_GAP_MS) {
      segments.push([]);
    }
    segments[segments.length - 1].push(sample);
  });
  return segments;
}

function chartPath(samples: readonly CpuHistorySample[], history: CpuHistory, width: number) {
  return samples.map((sample, index) =>
    `${index ? "L" : "M"}${chartX(sample.timestamp, history, width).toFixed(2)} ${chartY(sample.percent).toFixed(2)}`,
  ).join(" ");
}

function areaPath(samples: readonly CpuHistorySample[], history: CpuHistory, width: number) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  return `${chartPath(samples, history, width)} L${chartX(last.timestamp, history, width).toFixed(2)} ${CHART_BOTTOM} L${chartX(first.timestamp, history, width).toFixed(2)} ${CHART_BOTTOM} Z`;
}

export function useCpuHistory(reading: CpuReading): CpuHistory {
  const [storedSamples, setStoredSamples] = useState<readonly CpuHistorySample[]>([]);
  const [now, setNow] = useState(0);
  const shouldBreakPath = useRef(true);
  const samples = trimSamples(storedSamples, now);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 5_000);
    const visibility = () => {
      shouldBreakPath.current = true;
      tick();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    const currentTime = Date.now();
    setNow(currentTime);
    const candidate = isCurrentReading(reading)
      ? {
          observedAt: reading.observedAt,
          percent: reading.value,
          timestamp: Date.parse(reading.observedAt),
          breakBefore: shouldBreakPath.current,
        }
      : null;
    shouldBreakPath.current = candidate === null;

    setStoredSamples((previous) => {
      const retained = trimSamples(previous, currentTime);
      if (
        !candidate ||
        candidate.timestamp < currentTime - HISTORY_WINDOW_MS ||
        candidate.timestamp > currentTime ||
        retained.some((sample) => sample.timestamp === candidate.timestamp)
      ) {
        return retained.length === previous.length ? previous : retained;
      }

      return [...retained, candidate]
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-MAX_SAMPLES);
    });
  }, [reading.observedAt, reading.status, reading.value]);

  return {
    samples,
    windowStart: now - HISTORY_WINDOW_MS,
    windowEnd: now,
  };
}

export function CpuHistoryChart({
  history,
  emptyMessage = "Collecting readings",
  emptyDescription = "Waiting for a current CPU measurement.",
}: {
  history: CpuHistory;
  emptyMessage?: string;
  emptyDescription?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const gradientId = useId();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(200, entry.contentRect.width)),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  const chartHistory = history.samples.length
    ? { ...history, windowStart: Math.max(history.windowStart, history.samples[0].timestamp) }
    : history;
  const segments = chartSegments(history.samples);
  const path = segments.map((segment) => chartPath(segment, chartHistory, width)).join(" ");
  const waiting = history.samples.length < 2;
  const right = width - 8;
  const startTime = history.samples[0]?.observedAt;
  const clock = (timestamp: number) => new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div className="cpu-history" ref={container} data-waiting={waiting} data-empty={!history.samples.length}>
      {history.samples.length > 0 ? <svg
        className="cpu-history__chart"
        viewBox={`0 0 ${width} 260`}
        preserveAspectRatio="none"
        role="img"
        aria-label="CPU history"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>CPU history</title>
        <desc id={descriptionId}>
          {`${history.samples.length} successful CPU ${history.samples.length === 1 ? "sample" : "samples"} collected this visit, from ${startTime} to ${new Date(history.windowEnd).toISOString()}. Scale 0 to 100 percent. Gaps mark missing observations; retained stale values are not added.`}
        </desc>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop className="cpu-history__gradient-start" offset="0" />
            <stop className="cpu-history__gradient-end" offset="1" />
          </linearGradient>
        </defs>
        <line className="cpu-history__guide" x1={CHART_LEFT} x2={right} y1={CHART_TOP} y2={CHART_TOP} />
        <line
          className="cpu-history__guide"
          x1={CHART_LEFT}
          x2={right}
          y1={(CHART_TOP + CHART_BOTTOM) / 2}
          y2={(CHART_TOP + CHART_BOTTOM) / 2}
        />
        <line className="cpu-history__guide" x1={CHART_LEFT} x2={right} y1={CHART_BOTTOM} y2={CHART_BOTTOM} />
        <text className="cpu-history__axis-label" x={0} y={CHART_TOP + 4}>100%</text>
        <text className="cpu-history__axis-label" x={8} y={(CHART_TOP + CHART_BOTTOM) / 2 + 4}>50%</text>
        <text className="cpu-history__axis-label" x={16} y={CHART_BOTTOM + 4}>0%</text>
        <text className="cpu-history__axis-label" x={CHART_LEFT} y={246}>{clock(chartHistory.windowStart)}</text>
        <text className="cpu-history__axis-label" x={right} y={246} textAnchor="end">Now</text>
        {segments.filter((segment) => segment.length > 1).map((segment) => (
          <path key={segment[0].timestamp} className="cpu-history__area"
            d={areaPath(segment, chartHistory, width)} fill={`url(#${gradientId})`} />
        ))}
        {path && <path className="cpu-history__line" d={path} />}
        {segments.filter((segment) => segment.length === 1).map(([sample]) => (
          <circle key={sample.timestamp} className="cpu-history__sample"
            cx={chartX(sample.timestamp, chartHistory, width)} cy={chartY(sample.percent)} r={2.5} />
        ))}
      </svg> : (
        <div className="cpu-history__empty" role="status">
          <p>{emptyMessage}</p><p>{emptyDescription}</p>
        </div>
      )}
      <p className="cpu-history__note">
        {waiting && history.samples.length > 0 && "Collecting readings · "}
        This visit · up to 5 minutes · reload clears history
      </p>
    </div>
  );
}
