// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/app-shell";
import { useServerMetrics } from "../src/components/server-metrics";
import type { HostMetrics } from "../src/lib/metrics-contract";

const observedAt = "2026-09-30T16:02:38.000Z";
const capacity = { used: 50, available: 50, total: 100 };
function observations(): HostMetrics {
  return {
    cpu: { status: "available", value: 18, unit: "percent", observedAt },
    uptime: { status: "available", value: 90061, unit: "seconds", observedAt },
    ram: { status: "available", value: capacity, unit: "bytes", observedAt },
    rootFilesystem: { status: "available", value: capacity, unit: "bytes", observedAt },
    dataFilesystem: { status: "available", value: capacity, unit: "bytes", observedAt },
  };
}
let payload: HostMetrics;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  payload = observations();
  fetchMock = vi.fn(async () => Response.json(payload));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function settle() { await act(async () => {}); }
function Consumer() {
  const { metrics } = useServerMetrics();
  return <main>Shared CPU {metrics.cpu.measurement?.value ?? "pending"}</main>;
}

it("uses one poller for the header and workspace, with labelled navigation", async () => {
  render(<AppShell active="assistant"><Consumer /></AppShell>);
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Shared CPU 18")).toBeTruthy();
  expect(screen.getByRole("link", { name: /Live.*CPU 18%.*RAM 50/ }).getAttribute("href")).toBe("/");
  expect(screen.getAllByRole("link", { name: "Assistant" }).every((link) => link.getAttribute("aria-current") === "page")).toBe(true);
  expect(screen.getAllByRole("button", { name: /Controls/ }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not claim live readings when one measurement is unavailable", async () => {
  payload.dataFilesystem = { status: "unavailable", unit: "bytes", value: null, observedAt: null };
  render(<AppShell active="dashboard"><Consumer /></AppShell>);
  await settle();
  expect(screen.getByRole("link", { name: /^Partial readings/ })).toBeTruthy();
  expect(screen.queryByText("Live")).toBeNull();
});

it("marks retained header figures stale after a failed reading, then recovers", async () => {
  render(<AppShell active="assistant"><Consumer /></AppShell>);
  await settle();
  payload.cpu = { status: "unavailable", unit: "percent", value: null, observedAt: null };
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole("link", { name: /^Stale readings.*CPU 18%, stale reading/ })).toBeTruthy();
  expect(screen.getByText("CPU · stale")).toBeTruthy();
  payload = observations();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole("link", { name: /^Live/ })).toBeTruthy();
});

it("keeps logout in an accessible account popup", async () => {
  render(<AppShell active="dashboard"><main>Readings</main></AppShell>);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Owner account" }));
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
});
