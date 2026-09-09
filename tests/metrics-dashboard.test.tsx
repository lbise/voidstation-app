// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MetricsDashboard } from "../src/components/metrics-dashboard";
import type { HostMetrics } from "../src/lib/metrics-contract";

const FIRST = "2026-01-02T03:04:05.000Z";
const SECOND = "2026-01-02T03:04:10.000Z";
const THIRD = "2026-01-02T03:04:15.000Z";
const unavailable = { status: "unavailable", value: null, observedAt: null } as const;

function observations(observedAt = FIRST): HostMetrics {
  return {
    cpu: { status: "available", value: 25, unit: "percent", observedAt },
    uptime: { status: "available", value: 90061, unit: "seconds", observedAt },
    ram: { status: "available", value: { used: 5368709120, available: 3221225472, total: 8589934592 }, unit: "bytes", observedAt },
    rootFilesystem: { status: "available", value: { used: 42949672960, available: 53687091200, total: 107374182400 }, unit: "bytes", observedAt },
    dataFilesystem: { status: "available", value: { used: 751619276800, available: 322122547200, total: 1073741824000 }, unit: "bytes", observedAt },
  };
}

let respond: (signal: AbortSignal) => Promise<Response>;

function serve(payload: HostMetrics) {
  respond = async () => Response.json(payload);
}

async function settle() {
  await act(async () => {});
}

async function advance(milliseconds = 5000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

beforeEach(() => {
  vi.useFakeTimers();
  serve(observations());
  vi.stubGlobal("fetch", (_url: string, options: RequestInit) => respond(options.signal as AbortSignal));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function cardFor(title: string): HTMLElement {
  const card = screen.getByText(title, { selector: '[data-slot="card-title"]' }).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error(`Missing card for ${title}`);
  return card;
}

it("distinguishes initial loading from measurements that have never succeeded, without showing zeros", async () => {
  serve({
    cpu: { ...unavailable, unit: "percent" },
    uptime: { ...unavailable, unit: "seconds" },
    ram: { ...unavailable, unit: "bytes" },
    rootFilesystem: { ...unavailable, unit: "bytes" },
    dataFilesystem: { ...unavailable, unit: "bytes" },
  });
  render(<MetricsDashboard />);
  expect(screen.getAllByText("Loading")).toHaveLength(5);
  expect(screen.queryByText("Unavailable")).toBeNull();
  expect(screen.queryByText("0%", { selector: ".metric-value" })).toBeNull();
  expect(screen.queryByText(/0\.0 GiB/)).toBeNull();
  expect(screen.queryByText("0 seconds")).toBeNull();
  expect(screen.queryAllByText(/Last updated/)).toHaveLength(0);

  await settle();
  expect(screen.queryAllByText("Loading")).toHaveLength(0);
  expect(screen.getAllByText("The Server did not provide this measurement.")).toHaveLength(5);
  expect(screen.getAllByText("No observation received")).toHaveLength(5);
  expect(screen.queryByText("0%", { selector: ".metric-value" })).toBeNull();
  expect(screen.queryByText(/0\.0 GiB/)).toBeNull();
  expect(screen.queryByText("0 seconds")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps every metric unavailable when the first request fails", async () => {
  respond = async () => { throw new Error("connection lost before any observation"); };
  render(<MetricsDashboard />);
  await settle();

  expect(screen.getByRole("alert").textContent).toContain("Metrics request failed");
  expect(screen.getAllByText("The Dashboard could not request this measurement.")).toHaveLength(5);
  expect(screen.getAllByText("No observation received")).toHaveLength(5);
  expect(screen.queryAllByRole("time")).toHaveLength(0);
  expect(screen.queryByText("0%", { selector: ".metric-value" })).toBeNull();
  expect(screen.queryByText(/0\.0 GiB/)).toBeNull();
});

it("retains a successful metric as stale while other metrics update", async () => {
  render(<MetricsDashboard />);
  await settle();
  const firstCpuTime = within(cardFor("CPU")).getByRole("time");
  expect(firstCpuTime.getAttribute("datetime")).toBe(FIRST);

  serve({
    ...observations(SECOND),
    cpu: { ...unavailable, unit: "percent" },
  });
  await advance();

  const cpuCard = cardFor("CPU");
  expect(cpuCard.getAttribute("data-state")).toBe("stale");
  expect(within(cpuCard).getByText("Stale reading")).toBeTruthy();
  expect(within(cpuCard).getByText("25%" )).toBeTruthy();
  expect(within(cpuCard).getByRole("time").getAttribute("datetime")).toBe(FIRST);
  expect(within(cardFor("Uptime")).getByRole("time").getAttribute("datetime")).toBe(SECOND);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps a never-successful metric unavailable during a later request failure", async () => {
  serve({
    ...observations(),
    ram: { ...unavailable, unit: "bytes" },
  });
  render(<MetricsDashboard />);
  await settle();
  respond = async () => { throw new Error("connection lost"); };
  await advance();

  expect(screen.getByRole("alert").textContent).toContain("Metrics request failed");
  const ramCard = cardFor("RAM");
  expect(ramCard.getAttribute("data-state")).toBe("unavailable");
  expect(within(ramCard).getByText("The Dashboard could not request this measurement.")).toBeTruthy();
  expect(within(ramCard).queryByRole("time")).toBeNull();
  for (const title of ["CPU", "Uptime", "Root filesystem", "Data filesystem"]) {
    const card = cardFor(title);
    expect(card.getAttribute("data-state")).toBe("stale");
    expect(within(card).getByText("Stale reading")).toBeTruthy();
    expect(within(card).getByRole("time").getAttribute("datetime")).toBe(FIRST);
  }
});

it("retains every measurement and timestamp during a whole-request failure", async () => {
  render(<MetricsDashboard />);
  await settle();
  respond = async () => { throw new Error("connection lost"); };
  await advance();

  expect(screen.getByRole("alert").textContent).toContain("Metrics request failed");
  for (const title of ["CPU", "Uptime", "RAM", "Root filesystem", "Data filesystem"]) {
    const card = cardFor(title);
    expect(card.getAttribute("data-state")).toBe("stale");
    expect(within(card).getByText("Stale reading")).toBeTruthy();
    expect(within(card).getByRole("time").getAttribute("datetime")).toBe(FIRST);
  }
});

it("exposes reading timestamps through an accessible clock control", async () => {
  render(<MetricsDashboard />);
  await settle();

  const trigger = screen.getByRole("button", { name: "CPU reading details" });
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger);

  expect(screen.getByRole("dialog").textContent).toContain("CPU");
  expect(screen.getByRole("dialog").textContent).toContain("1/2/2026");

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("plots successful CPU observations and does not add stale values", async () => {
  const first = new Date(Date.now() - 1_000).toISOString();
  serve(observations(first));
  render(<MetricsDashboard />);
  await settle();

  const chart = () => screen.getByRole("img", { name: /CPU history/ });
  expect(chart().querySelectorAll("circle")).toHaveLength(1);

  await advance();
  const second = new Date(Date.now() - 1_000).toISOString();
  serve(observations(second));
  await advance();
  expect(chart().querySelectorAll("circle")).toHaveLength(2);

  serve({ ...observations(second), cpu: { ...unavailable, unit: "percent" } });
  await advance();
  expect(chart().querySelectorAll("circle")).toHaveLength(2);
});

it("returns stale measurements to current after a later request succeeds", async () => {
  render(<MetricsDashboard />);
  await settle();
  respond = async () => { throw new Error("connection lost"); };
  await advance();
  serve(observations(THIRD));
  await advance();

  expect(screen.queryByRole("alert")).toBeNull();
  for (const title of ["CPU", "Uptime", "RAM", "Root filesystem", "Data filesystem"]) {
    const card = cardFor(title);
    expect(card.getAttribute("data-state")).toBe("available");
    expect(within(card).queryByText("Current")).toBeNull();
    expect(within(card).getByRole("time").getAttribute("datetime")).toBe(THIRD);
  }
});
