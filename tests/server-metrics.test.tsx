// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ServerMetricsProvider, useServerMetrics, readingStatus,
  type ServerMetricsContextValue,
} from "../src/components/server-metrics";
import type { HostMetrics } from "../src/lib/metrics-contract";

const START = Date.parse("2026-01-02T03:04:05.000Z");
const unavailable = { status: "unavailable", value: null, observedAt: null } as const;
function observations(observedAt = new Date(Date.now() - 1000).toISOString()): HostMetrics {
  return {
    cpu: { status: "available", value: 0, unit: "percent", observedAt },
    uptime: { status: "available", value: 0, unit: "seconds", observedAt },
    ram: { status: "available", value: { used: 0, available: 100, total: 100 }, unit: "bytes", observedAt },
    rootFilesystem: { status: "available", value: { used: 0, available: 90, total: 100 }, unit: "bytes", observedAt },
    dataFilesystem: { status: "available", value: { used: 0, available: 100, total: 100 }, unit: "bytes", observedAt },
  };
}

let latest: ServerMetricsContextValue;
let respond: (signal: AbortSignal) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn>;
function Probe({ onRead }: { onRead?: (value: ServerMetricsContextValue) => void }) {
  const value = useServerMetrics();
  latest = value;
  onRead?.(value);
  return null;
}
function mount() { return render(<ServerMetricsProvider><Probe /></ServerMetricsProvider>); }
async function settle() { await act(async () => {}); }
async function advance(milliseconds = 5000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
function stall(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  respond = async () => Response.json(observations());
  fetchMock = vi.fn((_url: string, options: RequestInit) => respond(options.signal as AbortSignal));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shares one poller and one CPU history between consumers, with the exact public shape", async () => {
  let header: ServerMetricsContextValue | undefined;
  let dashboard: ServerMetricsContextValue | undefined;
  const tree = (showDashboard: boolean) => (
    <ServerMetricsProvider>
      <Probe onRead={(value) => { header = value; }} />
      {showDashboard && <Probe onRead={(value) => { dashboard = value; }} />}
    </ServerMetricsProvider>
  );
  const view = render(tree(true));
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(Object.keys(latest).sort()).toEqual(["cpuHistory", "initialLoading", "lastUpdated", "metrics", "requestFailure"]);
  expect(header).toBe(dashboard);
  expect(header?.cpuHistory.samples).toHaveLength(1);
  const firstSample = latest.cpuHistory.samples[0];
  view.rerender(tree(false));
  await advance();
  view.rerender(tree(true));
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(header?.cpuHistory).toBe(dashboard?.cpuHistory);
  expect(latest.cpuHistory.samples[0]).toBe(firstSample);
  expect(latest.cpuHistory.samples).toHaveLength(2);
  expect(fetchMock.mock.calls[0][0]).toBe("/api/metrics");
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { "Cache-Control": "no-store" } });
});

it("accepts real zero readings without treating them as unavailable", async () => {
  mount();
  await settle();
  expect(latest.initialLoading).toBe(false);
  expect(latest.requestFailure).toBe(false);
  expect(latest.metrics.cpu.measurement?.value).toBe(0);
  expect(latest.metrics.uptime.measurement?.value).toBe(0);
  expect(latest.metrics.ram.measurement?.value.used).toBe(0);
  expect(latest.cpuHistory.samples[0].percent).toBe(0);
  expect(Object.values(latest.metrics).every((reading) => readingStatus(reading, false) === "available")).toBe(true);
});

it("retains each observation independently and reports the most recent observation, not a synchronized time", async () => {
  mount();
  await settle();
  const cpu = latest.metrics.cpu.measurement;
  const nextTime = new Date(START + 4000).toISOString();
  respond = async () => Response.json({ ...observations(nextTime), cpu: { ...unavailable, unit: "percent" } });
  await advance();
  expect(latest.metrics.cpu).toEqual({ measurement: cpu, stale: true });
  expect(latest.metrics.ram.stale).toBe(false);
  expect(latest.lastUpdated).toBe(nextTime);
  expect(latest.requestFailure).toBe(false);
  expect(latest.cpuHistory.samples).toHaveLength(1);
});

it("turns a four-second timeout into a failure without adding stale CPU samples", async () => {
  mount();
  await settle();
  respond = stall;
  await advance(9000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
  expect(latest.requestFailure).toBe(true);
  expect(Object.values(latest.metrics).every((reading) => reading.stale)).toBe(true);
  expect(latest.cpuHistory.samples).toHaveLength(1);
  respond = async () => Response.json(observations());
  await advance(1000);
  expect(latest.requestFailure).toBe(false);
  expect(latest.cpuHistory.samples).toHaveLength(2);
  expect(latest.cpuHistory.samples[1].breakBefore).toBe(true);
});

it("does not overlap requests and aborts the in-flight request on unmount", async () => {
  respond = () => new Promise(() => {});
  const view = mount();
  await advance(15000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = fetchMock.mock.calls[0][1].signal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await advance();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("pauses in a hidden tab, cancels in-flight work without a failure, and refreshes on return", async () => {
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  respond = stall;
  mount();
  await act(async () => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(latest.requestFailure).toBe(false);
  expect(latest.initialLoading).toBe(true);
  await advance(20000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  respond = async () => Response.json(observations());
  await act(async () => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(latest.initialLoading).toBe(false);
  expect(latest.metrics.cpu.stale).toBe(false);
});

it("does not start a request while mounted hidden", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  mount();
  await advance(10000);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("ignores a late response from a cancelled request before refreshing on return", async () => {
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
  let finish!: (response: Response) => void;
  respond = () => new Promise((resolve) => { finish = resolve; });
  mount();
  await act(async () => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  respond = async () => Response.json({ ...observations(), cpu: { ...unavailable, unit: "percent" } });
  await act(async () => { finish(Response.json(observations())); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(latest.metrics.cpu.measurement).toBeNull();
  expect(latest.cpuHistory.samples).toHaveLength(0);
});

it("redirects an unauthorized request to login and clears retained measurements", async () => {
  const realWindow = window;
  const replace = vi.fn();
  vi.stubGlobal("window", new Proxy(realWindow, {
    get(target, key) {
      if (key === "location") return { replace };
      return Reflect.get(target, key);
    },
  }));
  mount();
  await settle();
  respond = async () => new Response(null, { status: 401 });
  await advance();
  expect(replace).toHaveBeenCalledWith("/login");
  expect(Object.values(latest.metrics).every((reading) => reading.measurement === null)).toBe(true);
  expect(latest.lastUpdated).toBeNull();
});

it.each([
  ["out-of-range CPU", (payload: HostMetrics) => ({ ...payload, cpu: { ...payload.cpu, value: 101 } })],
  ["bad timestamp", (payload: HostMetrics) => ({ ...payload, uptime: { ...payload.uptime, observedAt: "yesterday" } })],
  ["wrong unit", (payload: HostMetrics) => ({ ...payload, cpu: { ...payload.cpu, unit: "bytes" } })],
  ["inconsistent RAM", (payload: HostMetrics) => ({ ...payload, ram: { ...payload.ram, value: { used: 1, available: 100, total: 100 } } })],
  ["oversized filesystem", (payload: HostMetrics) => ({ ...payload, rootFilesystem: { ...payload.rootFilesystem, value: { used: 80, available: 80, total: 100 } } })],
  ["zero total", (payload: HostMetrics) => ({ ...payload, ram: { ...payload.ram, value: { used: 0, available: 0, total: 0 } } })],
  ["unsafe bytes", (payload: HostMetrics) => ({ ...payload, dataFilesystem: { ...payload.dataFilesystem, value: { used: 0, available: Number.MAX_SAFE_INTEGER + 1, total: Number.MAX_SAFE_INTEGER + 1 } } })],
  ["malformed unavailable", (payload: HostMetrics) => ({ ...payload, cpu: { ...unavailable, unit: "percent", observedAt: "2026-01-02T03:04:05.000Z" } })],
] as const)("rejects %s and retains the prior measurements as stale", async (_name, malformed) => {
  mount();
  await settle();
  const before = latest.metrics.cpu.measurement;
  respond = async () => Response.json(malformed(observations()));
  await advance();
  expect(latest.requestFailure).toBe(true);
  expect(latest.metrics.cpu.measurement).toBe(before);
  expect(latest.metrics.cpu.stale).toBe(true);
  expect(latest.cpuHistory.samples).toHaveLength(1);
});
