// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CpuHistoryChart, useCpuHistory, type CpuHistory, type CpuHistorySample } from "../src/components/cpu-history";

const START = Date.parse("2026-01-02T03:04:05.000Z");
function reading(offset = -1000, value = 0): Parameters<typeof useCpuHistory>[0] {
  return { status: "available" as const, observedAt: new Date(Date.now() + offset).toISOString(), value };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("records real zero observations once, never appends stale or unavailable values, and breaks on recovery", () => {
  const first = reading();
  const { result, rerender } = renderHook((value: Parameters<typeof useCpuHistory>[0]) => useCpuHistory(value), { initialProps: first });
  expect(result.current.samples).toHaveLength(1);
  expect(result.current.samples[0].percent).toBe(0);
  rerender({ ...first });
  expect(result.current.samples).toHaveLength(1);
  rerender({ ...first, status: "stale" });
  rerender({ status: "unavailable", observedAt: null, value: null });
  expect(result.current.samples).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(5000); });
  rerender(reading(-1000, 25));
  expect(result.current.samples).toHaveLength(2);
  expect(result.current.samples[1].breakBefore).toBe(true);
});

it("breaks CPU history across hidden-tab gaps even when no request failed", () => {
  const { result, rerender } = renderHook((value) => useCpuHistory(value), { initialProps: reading() });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); vi.advanceTimersByTime(5000); });
  rerender(reading(-1000, 50));
  expect(result.current.samples[1].breakBefore).toBe(true);
});

it("rejects future and expired observations, trims the five-minute window, and resets on remount", () => {
  const { result, rerender, unmount } = renderHook((value) => useCpuHistory(value), { initialProps: reading(1000) });
  expect(result.current.samples).toHaveLength(0);
  rerender(reading(-301000));
  expect(result.current.samples).toHaveLength(0);
  rerender(reading(-1000));
  expect(result.current.samples).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(305000); });
  expect(result.current.samples).toHaveLength(0);
  unmount();
  const fresh = renderHook(() => useCpuHistory({ status: "loading", value: null, observedAt: null }));
  expect(fresh.result.current.samples).toHaveLength(0);
});

it("closes each gradient area within the same continuous segments as the line", () => {
  const sample = (seconds: number, percent: number, breakBefore = false): CpuHistorySample => ({
    timestamp: START + seconds * 1000,
    observedAt: new Date(START + seconds * 1000).toISOString(),
    percent,
    breakBefore,
  });
  const history: CpuHistory = {
    samples: [sample(0, 0), sample(5, 50), sample(10, 25, true), sample(15, 100), sample(35, 75)],
    windowStart: START,
    windowEnd: START + 40000,
  };
  render(<CpuHistoryChart history={history} />);
  const chart = screen.getByRole("img", { name: /CPU history/ });
  const line = chart.querySelector(".cpu-history__line")?.getAttribute("d") ?? "";
  const areas = [...chart.querySelectorAll(".cpu-history__area")];
  expect(line.match(/M/g)).toHaveLength(3);
  expect(areas).toHaveLength(2);
  for (const area of areas) {
    const path = area.getAttribute("d") ?? "";
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path.endsWith("Z")).toBe(true);
    expect(path.match(/L/g)).toHaveLength(3);
  }
  expect(line).toContain("M38.00 220.00 L72.25 116.00");
  expect(areas[0].getAttribute("d")).toBe("M38.00 220.00 L72.25 116.00 L72.25 220 L38.00 220 Z");
  expect(areas[1].getAttribute("d")).toBe("M106.50 168.00 L140.75 12.00 L140.75 220 L106.50 220 Z");
  expect(chart.querySelectorAll(".cpu-history__sample")).toHaveLength(1);
  expect(chart.querySelectorAll("linearGradient")).toHaveLength(1);
  expect(chart.textContent).toContain("5 successful CPU samples");
  expect(chart.textContent).toContain("100%");
  expect(chart.textContent).toContain("50%");
  expect(chart.textContent).toContain("0%");
});

it("collapses an empty history instead of showing a large empty graph", () => {
  render(<CpuHistoryChart history={{ samples: [], windowStart: START - 300000, windowEnd: START }} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Waiting for a current CPU measurement.");
});
