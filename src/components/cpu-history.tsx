"use client";

import { useEffect, useId, useRef, useState } from "react";

const HISTORY_WINDOW_MS = 5 * 60 * 1_000;
const MAX_SAMPLES = 120;
const MAX_CONTINUOUS_GAP_MS = 15 * 1_000;
const CHART_LEFT = 38;
const CHART_TOP = 12;
const CHART_BOTTOM = 126;

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

function chartPath(samples: readonly CpuHistorySample[], history: CpuHistory, width: number) {
  return samples.reduce((path, sample, index) => {
    const previous = samples[index - 1];
    const command =
      !previous ||
      sample.breakBefore ||
      sample.timestamp - previous.timestamp > MAX_CONTINUOUS_GAP_MS
        ? "M"
        : "L";
    return `${path}${command}${chartX(sample.timestamp, history, width).toFixed(2)} ${chartY(sample.percent).toFixed(2)} `;
  }, "");
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
  const path = chartPath(history.samples, chartHistory, width);
  const waiting = history.samples.length < 2;
  const right = width - 8;

  return (
    <div className="cpu-history" ref={container}>
      <svg
        className="cpu-history__chart"
        viewBox={`0 0 ${width} 180`}
        preserveAspectRatio="none"
        role="img"
        aria-label="CPU history"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>CPU history</title>
        <desc id={descriptionId}>
          {waiting
            ? emptyDescription
            : `CPU usage over the five minutes ending at ${new Date(history.windowEnd).toISOString()}.`}
        </desc>
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
        <text className="cpu-history__axis-label" x={CHART_LEFT} y={150}>Start</text>
        <text className="cpu-history__axis-label" x={right} y={150} textAnchor="end">Now</text>
        {path && <path className="cpu-history__line" d={path} />}
        {waiting && (
          <text
            className="cpu-history__waiting"
            x={(CHART_LEFT + right) / 2}
            y={(CHART_TOP + CHART_BOTTOM) / 2 - 12}
            textAnchor="middle"
          >
            {emptyMessage}
          </text>
        )}
      </svg>
      <p className="cpu-history__note">This visit · reload clears history</p>
    </div>
  );
}
