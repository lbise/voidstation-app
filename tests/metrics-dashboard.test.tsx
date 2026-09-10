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
  const card = screen.getByRole("heading", { name: title, level: 2 }).closest('[data-slot="card"]');
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
  expect(screen.getAllByText("Loading")).toHaveLength(6);
  expect(screen.queryByText("Unavailable")).toBeNull();
  expect(screen.queryByText("0%", { selector: ".metric-value" })).toBeNull();
  expect(screen.queryByText(/0\.0 GiB/)).toBeNull();
  expect(screen.queryByText("0 seconds")).toBeNull();
  expect(screen.queryAllByText(/Last updated/)).toHaveLength(0);

  await settle();
  expect(screen.queryAllByText("Loading")).toHaveLength(0);
  expect(screen.getAllByText("The Server did not provide this measurement.")).toHaveLength(3);
  expect(screen.getAllByText("No measurement")).toHaveLength(2);
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
  expect(screen.getAllByText("The Dashboard could not request this measurement.")).toHaveLength(3);
  expect(screen.getAllByText("No measurement")).toHaveLength(2);
  expect(screen.queryAllByRole("time")).toHaveLength(0);
  expect(screen.queryByText("0%", { selector: ".metric-value" })).toBeNull();
  expect(screen.queryByText(/0\.0 GiB/)).toBeNull();
});

it("retains a successful metric as stale while other metrics update", async () => {
  render(<MetricsDashboard />);
  await settle();
  const firstUpdate = screen.getByRole("time");
  expect(firstUpdate.getAttribute("datetime")).toBe(FIRST);

  serve({
    ...observations(SECOND),
    cpu: { ...unavailable, unit: "percent" },
  });
  await advance();

  const cpuCard = cardFor("CPU");
  expect(cpuCard.getAttribute("data-state")).toBe("stale");
  expect(within(cpuCard).getByText("Stale reading")).toBeTruthy();
  expect(within(cpuCard).getByText("25%" )).toBeTruthy();
  expect(screen.getByRole("time").getAttribute("datetime")).toBe(SECOND);
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
  const storageCard = cardFor("Storage");
  expect(storageCard.getAttribute("data-state")).toBe("stale");
  expect(within(storageCard).getAllByText("Stale reading")).toHaveLength(3);
  expect(screen.getByRole("time").getAttribute("datetime")).toBe(FIRST);
});

it("retains every measurement and timestamp during a whole-request failure", async () => {
  render(<MetricsDashboard />);
  await settle();
  respond = async () => { throw new Error("connection lost"); };
  await advance();

  expect(screen.getByRole("alert").textContent).toContain("Metrics request failed");
  for (const title of ["CPU", "Uptime", "RAM"]) {
    const card = cardFor(title);
    expect(card.getAttribute("data-state")).toBe("stale");
    expect(within(card).getByText("Stale reading")).toBeTruthy();
  }
  const storageCard = cardFor("Storage");
  expect(storageCard.getAttribute("data-state")).toBe("stale");
  expect(within(storageCard).getAllByText("Stale reading")).toHaveLength(3);
  expect(screen.getByRole("time").getAttribute("datetime")).toBe(FIRST);
});

it("exposes reading timestamps through an accessible clock control", async () => {
  render(<MetricsDashboard />);
  await settle();

  const trigger = screen.getByRole("button", { name: "Server readings update details" });
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger);

  expect(screen.getByRole("dialog").textContent).toContain("Server readings");
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
  expect(chart().querySelector("path")?.getAttribute("d")).not.toContain("L");

  await advance();
  const second = new Date(Date.now() - 1_000).toISOString();
  serve(observations(second));
  await advance();
  expect(chart().querySelector("path")?.getAttribute("d")).toContain("L");

  serve({ ...observations(second), cpu: { ...unavailable, unit: "percent" } });
  await advance();
  expect(chart().querySelector("path")?.getAttribute("d")).toContain("L");
});

it("uses the same capacity breakdown for RAM and each storage mount", async () => {
  render(<MetricsDashboard />);
  await settle();

  for (const [label, used, percent, total, available] of [
    ["RAM", "5.0 GiB", "62.5%", "8.0 GiB", "3.0 GiB"],
    ["/", "40.0 GiB", "40%", "100.0 GiB", "50.0 GiB"],
    ["/data", "700.0 GiB", "70%", "1,000.0 GiB", "300.0 GiB"],
  ]) {
    const capacity = within(screen.getByRole("group", { name: `${label} capacity` }));
    const usedValue = capacity.getByText("Used", { selector: "dt" }).nextElementSibling;
    expect(usedValue?.textContent).toContain(used);
    expect(usedValue?.textContent).toContain(percent);
    expect(capacity.getByText("Total capacity", { selector: "dt" }).nextElementSibling?.textContent).toBe(total);
    expect(capacity.getByText("Available", { selector: "dt" }).nextElementSibling?.textContent).toBe(available);
    expect(capacity.getAllByText(used, { exact: true })).toHaveLength(1);
    expect(capacity.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(percent.replace("%", ""));
  }
});

it("retains the complete stale capacity breakdown while other readings refresh", async () => {
  render(<MetricsDashboard />);
  await settle();

  const next = observations(SECOND);
  serve({
    ...next,
    ram: { ...unavailable, unit: "bytes" },
    rootFilesystem: { ...unavailable, unit: "bytes" },
    dataFilesystem: {
      status: "available", unit: "bytes", observedAt: SECOND,
      value: { used: 0, available: 1073741824000, total: 1073741824000 },
    },
  });
  await advance();

  for (const [label, used, available] of [["RAM", "5.0 GiB", "3.0 GiB"], ["/", "40.0 GiB", "50.0 GiB"]]) {
    const capacity = within(screen.getByRole("group", { name: `${label} capacity` }));
    expect(capacity.getByText(used)).toBeTruthy();
    expect(capacity.getByText("Available", { selector: "dt" }).nextElementSibling?.textContent).toBe(available);
    expect(capacity.getByRole("progressbar", { name: `${label} usage, stale reading` })).toBeTruthy();
  }
  const data = within(screen.getByRole("group", { name: "/data capacity" }));
  expect(data.getByText("0.0 GiB")).toBeTruthy();
  expect(data.getByText("0%")).toBeTruthy();
  expect(data.getByRole("progressbar", { name: "/data usage" }).getAttribute("aria-valuenow")).toBe("0");
});

it("does not invent capacity values for a storage mount that has never succeeded", async () => {
  serve({ ...observations(), dataFilesystem: { ...unavailable, unit: "bytes" } });
  render(<MetricsDashboard />);
  await settle();

  expect(screen.queryByRole("group", { name: "/data capacity" })).toBeNull();
  expect(within(cardFor("Storage")).getByText("No measurement")).toBeTruthy();
  expect(screen.getByRole("group", { name: "/ capacity" })).toBeTruthy();
});

it("returns stale measurements to current after a later request succeeds", async () => {
  render(<MetricsDashboard />);
  await settle();
  respond = async () => { throw new Error("connection lost"); };
  await advance();
  serve(observations(THIRD));
  await advance();

  expect(screen.queryByRole("alert")).toBeNull();
  for (const title of ["CPU", "Uptime", "RAM", "Storage"]) {
    const card = cardFor(title);
    expect(card.getAttribute("data-state")).toBe("available");
    expect(within(card).queryByText("Current")).toBeNull();
  }
  expect(screen.getByRole("time").getAttribute("datetime")).toBe(THIRD);
});
