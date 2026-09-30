// @vitest-environment jsdom

import { act, cleanup, fireEvent, render as renderTree, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricsDashboard } from "../src/components/metrics-dashboard";
import { ServerMetricsProvider } from "../src/components/server-metrics";

function render(children: ReactElement) {
  return renderTree(<ServerMetricsProvider>{children}</ServerMetricsProvider>);
}

function latestUpdate() {
  return screen.getByText(/^Updated /, { selector: "time" });
}
import type { HostMetrics } from "../src/lib/metrics-contract";
import { extendedObservations, unavailableExtended } from "./helpers/metrics-fixture";

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
    ...extendedObservations(observedAt),
  };
}

let respond: (signal: AbortSignal) => Promise<Response>;
let respondDownloads: () => Promise<Response>;

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
  vi.setSystemTime(new Date(FIRST).getTime() + 1_000);
  serve(observations());
  respondDownloads = async () => Response.json({ error: "Download queue unavailable." }, { status: 503 });
  vi.stubGlobal("fetch", (url: string, options: RequestInit) =>
    url === "/api/downloads" ? respondDownloads() : respond(options.signal as AbortSignal));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function cardFor(title: string): HTMLElement {
  const card = screen.getByRole("heading", { name: title, level: 2 }).closest("[data-state]");
  if (!(card instanceof HTMLElement)) throw new Error(`Missing reading for ${title}`);
  return card;
}

function uptimeValue(): string | null {
  return cardFor("Uptime").querySelector(".uptime-reading__value")?.textContent ?? null;
}

it("distinguishes initial loading from measurements that have never succeeded, without showing zeros", async () => {
  serve({
    cpu: { ...unavailable, unit: "percent" },
    uptime: { ...unavailable, unit: "seconds" },
    ram: { ...unavailable, unit: "bytes" },
    rootFilesystem: { ...unavailable, unit: "bytes" },
    dataFilesystem: { ...unavailable, unit: "bytes" },
    ...unavailableExtended,
  });
  render(<MetricsDashboard />);
  // Header, CPU, Uptime, RAM, two Disk space cards, Downloads, Pressure and Drive health.
  expect(screen.getAllByText("Loading")).toHaveLength(9);
  expect(screen.queryByText("Unavailable")).toBeNull();
  expect(screen.queryByText("0%", { selector: "dd" })).toBeNull();
  expect(screen.queryByText(/0\.0 GiB/)).toBeNull();
  expect(screen.queryByText("0 seconds")).toBeNull();
  expect(screen.queryAllByText(/Last updated/)).toHaveLength(0);

  await settle();
  expect(screen.queryAllByText("Loading")).toHaveLength(0);
  // CPU, Uptime, RAM, two Disk space cards and Pressure.
  expect(screen.getAllByText("The Server did not provide this measurement.")).toHaveLength(6);
  expect(screen.getByText(/No report from the Server's host-status helper/)).toBeTruthy();
  expect(screen.getByText("Update check unavailable")).toBeTruthy();
  expect(screen.queryByRole("img", { name: /CPU history/ })).toBeNull();
  expect(screen.getAllByText("No measurement")).toHaveLength(2);
  expect(screen.queryByText("0%", { selector: "dd" })).toBeNull();
  expect(screen.queryByText(/0\.0 GiB/)).toBeNull();
  expect(screen.queryByText("0 seconds")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps every metric unavailable when the first request fails", async () => {
  respond = async () => { throw new Error("connection lost before any observation"); };
  render(<MetricsDashboard />);
  await settle();

  expect(screen.getByRole("alert").textContent).toContain("Metrics request failed");
  expect(screen.getAllByText("The Dashboard could not request this measurement.")).toHaveLength(6);
  expect(screen.getAllByText("No measurement")).toHaveLength(2);
  expect(screen.queryAllByRole("time")).toHaveLength(0);
  expect(screen.queryByText("0%", { selector: "dd" })).toBeNull();
  expect(screen.queryByText(/0\.0 GiB/)).toBeNull();
});

it("retains a successful metric as stale while other metrics update", async () => {
  render(<MetricsDashboard />);
  await settle();
  const firstUpdate = latestUpdate();
  expect(firstUpdate.getAttribute("datetime")).toBe(FIRST);

  serve({
    ...observations(SECOND),
    cpu: { ...unavailable, unit: "percent" },
  });
  await advance();

  const cpuCard = cardFor("CPU");
  expect(cpuCard.getAttribute("data-state")).toBe("stale");
  expect(within(cpuCard).getByText("Stale reading")).toBeTruthy();
  expect(within(cpuCard).getByText("Utilization", { selector: "dt" }).nextElementSibling?.textContent).toBe("25%");
  expect(within(cpuCard).getByRole("time").getAttribute("datetime")).toBe(FIRST);
  expect(latestUpdate().getAttribute("datetime")).toBe(SECOND);
  expect(screen.queryByText("Live", { exact: true })).toBeNull();
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
  for (const title of ["Disk space on /", "Disk space on /data"]) {
    const storageCard = cardFor(title);
    expect(storageCard.getAttribute("data-state")).toBe("stale");
    expect(within(storageCard).getByText("Stale reading")).toBeTruthy();
  }
  expect(latestUpdate().getAttribute("datetime")).toBe(FIRST);
});

it("retains every measurement and timestamp during a whole-request failure", async () => {
  render(<MetricsDashboard />);
  await settle();
  respond = async () => { throw new Error("connection lost"); };
  await advance();

  expect(screen.getByRole("alert").textContent).toContain("Metrics request failed");
  for (const title of ["CPU", "Uptime", "RAM", "Disk space on /", "Disk space on /data"]) {
    const card = cardFor(title);
    expect(card.getAttribute("data-state")).toBe("stale");
    expect(within(card).getByText("Stale reading")).toBeTruthy();
    expect(card.querySelector(".metric-observation time")?.getAttribute("datetime")).toBe(FIRST);
  }
  expect(latestUpdate().getAttribute("datetime")).toBe(FIRST);
});

it("exposes reading timestamps through an accessible clock control", async () => {
  render(<MetricsDashboard />);
  await settle();

  const trigger = screen.getByRole("button", { name: "Server readings update details" });
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger);

  expect(screen.getByRole("dialog").textContent).toContain("Server readings");
  expect(screen.getByRole("dialog").textContent).toContain("1/2/2026");
  expect(screen.getByRole("dialog").textContent).toContain("most recent observation");
  expect(screen.getByRole("dialog").textContent).toContain("every 5 seconds");
  expect(screen.getByRole("dialog").textContent).toContain("ages may differ");

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows the update time once for current readings and dates stale figures individually", async () => {
  render(<MetricsDashboard />);
  await settle();
  expect(screen.getByText("Live", { exact: true })).toBeTruthy();
  // Live readings share one time; only the periodic host-status check shows its own.
  expect(screen.getAllByText(/^Updated /)).toHaveLength(1);
  expect(document.querySelector(".metric-observation")).toBeNull();
  expect(screen.getAllByRole("button", { name: /update details$/ })).toHaveLength(1);
  expect(screen.queryByText(/Current reading/)).toBeNull();
  serve({ ...observations(SECOND), ram: { ...unavailable, unit: "bytes" } });
  await advance();
  const ram = within(cardFor("RAM"));
  expect(ram.getByRole("time").getAttribute("datetime")).toBe(FIRST);
  expect(ram.getByText(/Retrying when visible/)).toBeTruthy();
  fireEvent.click(ram.getByRole("button", { name: "RAM update details" }));
  expect(screen.getByRole("dialog").textContent).toContain("Last successful reading");
  expect(screen.getByRole("dialog").textContent).toContain("historical, not the current state");
  expect(latestUpdate().getAttribute("datetime")).toBe(SECOND);
});

it("plots successful CPU observations and does not add stale values", async () => {
  const first = new Date(Date.now() - 1_000).toISOString();
  serve(observations(first));
  render(<MetricsDashboard />);
  await settle();

  const chart = () => screen.getByRole("img", { name: /CPU history/ });
  expect(chart().querySelector(".cpu-history__line")?.getAttribute("d")).not.toContain("L");

  await advance();
  const second = new Date(Date.now() - 1_000).toISOString();
  serve(observations(second));
  await advance();
  const line = chart().querySelector(".cpu-history__line")?.getAttribute("d");
  expect(line).toContain("L");

  serve({ ...observations(second), cpu: { ...unavailable, unit: "percent" } });
  await advance();
  const staleLine = chart().querySelector(".cpu-history__line")?.getAttribute("d") ?? "";
  expect(staleLine.match(/[ML]/g)).toEqual(line?.match(/[ML]/g));
});

it("presents CPU and Uptime as labelled readings and retains them after a failed refresh", async () => {
  render(<MetricsDashboard />);
  await settle();

  const cpuValue = () => within(cardFor("CPU")).getByText("Utilization", { selector: "dt" }).nextElementSibling?.textContent;
  expect(cpuValue()).toBe("25%");
  expect(uptimeValue()).toBe("1 day 1 hour 1 minute");
  expect(cardFor("Uptime").closest("header")).toBeTruthy();
  expect(within(cardFor("CPU")).getByRole("img", { name: /CPU history/ })).toBeTruthy();

  respond = async () => { throw new Error("connection lost"); };
  await advance();
  for (const title of ["CPU", "Uptime"]) expect(within(cardFor(title)).getByText("Stale reading")).toBeTruthy();
  expect(cpuValue()).toBe("25%");
  expect(uptimeValue()).toBe("1 day 1 hour 1 minute");

  serve({
    ...observations(THIRD),
    cpu: { status: "available", value: 0, unit: "percent", observedAt: THIRD },
    uptime: { status: "available", value: 0, unit: "seconds", observedAt: THIRD },
  });
  await advance();
  expect(within(cardFor("CPU")).getByText("Utilization", { selector: "dt" }).nextElementSibling?.textContent).toBe("0%");
  expect(uptimeValue()).toBe("0 seconds");
  expect(screen.queryByText("Stale reading")).toBeNull();
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
  expect(within(cardFor("Disk space on /data")).getByText("No measurement")).toBeTruthy();
  expect(screen.queryByText("Live", { exact: true })).toBeNull();
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
  for (const title of ["CPU", "Uptime", "RAM", "Disk space on /", "Disk space on /data"]) {
    const card = cardFor(title);
    expect(card.getAttribute("data-state")).toBe("available");
    expect(within(card).queryByText("Current")).toBeNull();
  }
  expect(latestUpdate().getAttribute("datetime")).toBe(THIRD);
});

function withHostStatus(value: Partial<import("../src/lib/metrics-contract").HostStatus>, checkedAt = FIRST): HostMetrics {
  const base = observations();
  if (base.hostStatus.status !== "available") throw new Error("fixture");
  return { ...base, hostStatus: { ...base.hostStatus, observedAt: checkedAt, value: { ...base.hostStatus.value, ...value } } };
}

it("shows load against cores, swap and pressure beside the existing readings", async () => {
  serve({
    ...observations(),
    load: { status: "available", value: { one: 9.5, five: 4, fifteen: 2.25, cores: 8 }, unit: "tasks", observedAt: FIRST },
    swap: { status: "available", value: { used: 536870912, total: 2147483648 }, unit: "bytes", observedAt: FIRST },
    pressure: {
      status: "available", unit: "percent", observedAt: FIRST,
      value: { cpu: { avg10: 1.2, avg60: 0.8 }, memory: { avg10: 0, avg60: 0 }, io: { avg10: 23, avg60: 12.5 } },
    },
  });
  render(<MetricsDashboard />);
  await settle();

  const load = screen.getByLabelText(/^Load average 9\.50 over 1 minute, 4\.00 over 5 minutes, 2\.25 over 15 minutes, on 8 cores$/);
  expect(load.getAttribute("data-busy")).toBe("true");
  expect(within(cardFor("RAM")).getByText("Swap", { selector: "dt" }).nextElementSibling?.textContent).toBe("0.5 GiB of 2.0 GiB");
  const pressure = within(cardFor("Pressure"));
  expect(pressure.getByRole("progressbar", { name: "Disk I/O pressure" }).getAttribute("aria-valuetext")).toBe("23% over 10 seconds, 13% over 1 minute");
  expect(pressure.getByRole("progressbar", { name: "Disk I/O pressure" }).closest("li")?.getAttribute("data-high")).toBe("true");
  expect(pressure.getByRole("progressbar", { name: "CPU pressure" }).closest("li")?.getAttribute("data-high")).toBe("false");
});

it("reports no swap honestly", async () => {
  serve({ ...observations(), swap: { status: "available", value: { used: 0, total: 0 }, unit: "bytes", observedAt: FIRST } });
  render(<MetricsDashboard />);
  await settle();
  expect(within(cardFor("RAM")).getByText("Swap", { selector: "dt" }).nextElementSibling?.textContent).toBe("None");
});

it("shows reboot and update state under Uptime with the helper's own check time", async () => {
  const checked = "2026-01-02T02:50:00.000Z";
  serve(withHostStatus({ rebootRequired: true, rebootPackages: ["linux-image-generic"], updates: { total: 12, security: 3 } }, checked));
  render(<MetricsDashboard />);
  await settle();

  const uptime = within(cardFor("Uptime"));
  expect(uptime.getByText("Reboot required").getAttribute("title")).toBe("Requested by linux-image-generic");
  expect(uptime.getByText("12 updates, 3 security")).toBeTruthy();
  expect(uptime.getByText(/checked/).querySelector("time")?.getAttribute("datetime")).toBe(checked);
  expect(latestUpdate().getAttribute("datetime")).toBe(FIRST);
});

it("keeps the Dashboard live when only the periodic host-status check is missing", async () => {
  serve({ ...observations(), hostStatus: { status: "unavailable", value: null, unit: "status", observedAt: null } });
  render(<MetricsDashboard />);
  await settle();
  expect(screen.getByText("Live", { exact: true })).toBeTruthy();
  expect(within(cardFor("Uptime")).getByText("Update check unavailable")).toBeTruthy();
  expect(within(cardFor("Drive health")).getByText(/No report from the Server's host-status helper/)).toBeTruthy();
});

it("assesses each drive from SMART without waking sleeping drives", async () => {
  const drive = { model: null, temperatureCelsius: null, powerOnHours: null, reallocatedSectors: null, pendingSectors: null, mediaErrors: null, percentageUsed: null };
  serve(withHostStatus({
    drives: [
      { ...drive, device: "sda", passed: true, standby: false, reallocatedSectors: 0, pendingSectors: 0, temperatureCelsius: 36, powerOnHours: 26280 },
      { ...drive, device: "sdb", passed: true, standby: false, reallocatedSectors: 8, pendingSectors: 0 },
      { ...drive, device: "sdc", passed: false, standby: false },
      { ...drive, device: "sdd", passed: null, standby: true },
      { ...drive, device: "nvme0n1", passed: true, standby: false, mediaErrors: 0, percentageUsed: 93 },
    ],
  }));
  render(<MetricsDashboard />);
  await settle();

  const card = cardFor("Drive health");
  const status = (device: string) => within(card).getByText(device).closest("li")?.querySelector(".drive-item__status")?.textContent;
  expect(status("sda")).toBe("Healthy");
  expect(status("sdb")).toBe("Needs attention");
  expect(status("sdc")).toBe("Failing");
  expect(status("sdd")).toBe("Asleep");
  expect(status("nvme0n1")).toBe("Needs attention");
  expect(within(card).getByText("3 need attention")).toBeTruthy();
  expect(within(card).getByText("3 years")).toBeTruthy();
  expect(within(card).getByText(/Not woken to check/)).toBeTruthy();
});

it("explains when SMART is not installed on the Server", async () => {
  serve(withHostStatus({ drives: null }));
  render(<MetricsDashboard />);
  await settle();
  expect(within(cardFor("Drive health")).getByText(/Install smartmontools/)).toBeTruthy();
});

describe("download queue", () => {
  const item = (overrides: Partial<import("../src/lib/downloads-contract").DownloadItem>) => ({
    id: "radarr-1", service: "radarr", title: "Dune (2021)", status: "downloading", problem: null,
    size: 4294967296, sizeLeft: 1073741824, progress: 75, estimatedCompletion: null, ...overrides,
  });
  const queue = (radarr: unknown, sonarr: unknown) => async () => Response.json({ radarr, sonarr });
  const available = (items: unknown[], total = items.length) => ({ status: "available", items, total, observedAt: FIRST });

  it("lists problems first with progress, and says which service could not be read", async () => {
    respondDownloads = queue(
      available([item({}), item({ id: "radarr-2", title: "Arrival (2016)", status: "failed", problem: "Download client unavailable", progress: 10 })]),
      { status: "unavailable", reason: "service_unavailable", observedAt: null },
    );
    render(<MetricsDashboard />);
    await settle();

    const card = within(cardFor("Downloads"));
    const rows = card.getAllByRole("listitem");
    expect(rows[0].textContent).toContain("Arrival (2016)");
    expect(rows[0].textContent).toContain("Download client unavailable");
    expect(rows[1].textContent).toContain("3.0 GiB of 4.0 GiB");
    expect(card.getByRole("progressbar", { name: "Dune (2021) progress" }).getAttribute("aria-valuenow")).toBe("75");
    expect(card.getByText("1 needs attention")).toBeTruthy();
    expect(card.getByText("Sonarr unreachable.")).toBeTruthy();
  });

  it("shows an empty queue, caps the list, and keeps the last queue as stale after a failure", async () => {
    respondDownloads = queue(available([]), available([]));
    render(<MetricsDashboard />);
    await settle();
    expect(within(cardFor("Downloads")).getByText("Nothing is downloading.")).toBeTruthy();

    const many = Array.from({ length: 8 }, (_, index) => item({ id: `radarr-${index}`, title: `Movie ${index}` }));
    respondDownloads = queue(available(many, 11), available([]));
    await advance(10_000);
    expect(within(cardFor("Downloads")).getAllByRole("listitem")).toHaveLength(6);
    expect(within(cardFor("Downloads")).getByText("5 more in the queue")).toBeTruthy();

    respondDownloads = async () => { throw new Error("connection lost"); };
    await advance(10_000);
    const card = cardFor("Downloads");
    expect(card.getAttribute("data-state")).toBe("stale");
    expect(within(card).getByText("Stale reading")).toBeTruthy();
    expect(within(card).getByRole("progressbar", { name: "Movie 0 progress, stale reading" })).toBeTruthy();
  });

  it("never shows a queue that does not match the contract", async () => {
    respondDownloads = queue(available([{ ...item({}), status: "exploded" }]), available([]));
    render(<MetricsDashboard />);
    await settle();
    expect(within(cardFor("Downloads")).getByText(/download queue is unavailable/)).toBeTruthy();
  });
});
