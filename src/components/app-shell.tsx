"use client";

import { Bot, LayoutDashboard, SlidersHorizontal, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";

import { LogoutButton } from "@/components/logout-button";
import { Wordmark } from "@/components/wordmark";
import { ServerMetricsProvider, useServerMetrics, formatCpu, formatPercentage, liveReadings, readingStatus } from "@/components/server-metrics";
import type { CpuHistory } from "@/components/cpu-history";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverDescription, PopoverTrigger } from "@/components/ui/popover";

function WorkspaceNavigation({ active, mobile = false }: { active: "assistant" | "dashboard"; mobile?: boolean }) {
  return (
    <nav className={mobile ? "workspace-tabs" : "workspace-navigation"} aria-label={mobile ? "Mobile workspace" : "Workspace"}>
      <Link href="/assistant" aria-current={active === "assistant" ? "page" : undefined}>
        <Bot aria-hidden="true" /><span>Assistant</span>
      </Link>
      <Link href="/" aria-current={active === "dashboard" ? "page" : undefined}>
        <LayoutDashboard aria-hidden="true" /><span>Dashboard</span>
      </Link>
      <button type="button" disabled title="Server controls are not built yet">
        <SlidersHorizontal aria-hidden="true" /><span className="workspace-control-label">Controls<Badge variant="outline">Soon</Badge></span>
      </button>
    </nav>
  );
}

function HeaderSparkline({ history }: { history: CpuHistory }) {
  if (history.samples.length < 2) return null;
  const start = history.samples[0].timestamp;
  const range = Math.max(1, history.windowEnd - start);
  const path = history.samples.map((sample, index) => {
    const previous = history.samples[index - 1];
    const command = !previous || sample.breakBefore || sample.timestamp - previous.timestamp > 15_000 ? "M" : "L";
    return `${command}${(((sample.timestamp - start) / range) * 44).toFixed(1)} ${(16 - sample.percent / 100 * 14).toFixed(1)}`;
  }).join(" ");
  return <svg className="header-sparkline" viewBox="0 0 44 18" aria-hidden="true"><path d={path} /></svg>;
}

function shortUptime(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return days ? `${days}d ${hours}h ${minutes}m` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function ServerGlance() {
  const { metrics, initialLoading, requestFailure, cpuHistory, lastUpdated } = useServerMetrics();
  const readings = liveReadings(metrics);
  const anyStale = readings.some((reading) => reading.stale);
  const allAvailable = readings.every((reading) => Boolean(reading.measurement) && !reading.stale);
  const state = initialLoading ? "loading" : anyStale ? "stale" : requestFailure ? "unavailable" : allAvailable ? "available" : "partial";
  const status = state === "available" ? "Live" : state === "loading" ? "Loading" : state === "stale" ? "Stale readings" : state === "partial" ? "Partial readings" : "Unavailable";
  const cpuStatus = readingStatus(metrics.cpu, initialLoading);
  const ramStatus = readingStatus(metrics.ram, initialLoading);
  const diskStatus = readingStatus(metrics.rootFilesystem, initialLoading);
  const uptimeStatus = readingStatus(metrics.uptime, initialLoading);
  const cpu = metrics.cpu.measurement;
  const ram = metrics.ram.measurement;
  const disk = metrics.rootFilesystem.measurement;
  const uptime = metrics.uptime.measurement;
  const ramPercent = ram ? formatPercentage(ram.value.used, ram.value.total) : null;
  const diskPercent = disk ? formatPercentage(disk.value.used, disk.value.total) : null;
  const describe = (label: string, value: string, status: string) => `${label} ${value}${status === "stale" ? ", stale reading" : ""}`;
  const cpuValue = cpu ? formatCpu(cpu.value) : initialLoading ? "…" : "Unavailable";
  const ramValue = ramPercent !== null ? `${ramPercent.toFixed(1)}%` : initialLoading ? "…" : "Unavailable";
  const readout = (value: string) => value === "Unavailable" ? <><span className="glance-unavailable-full">Unavailable</span><span className="glance-unavailable-short" aria-hidden="true">—</span></> : value;
  return (
    <Link className="server-glance" href="/" aria-label={`${status}. ${describe("CPU", cpuValue, cpuStatus)}. ${describe("RAM", ramValue, ramStatus)}. Open Dashboard for readings and observation times.`}>
      <div className="glance-server" data-state={state}>
        <span className="glance-label">Home Server <span className="glance-os">· Ubuntu</span></span>
        <span className="glance-value"><i className="server-status-dot" aria-hidden="true" />{status}{state === "available" && lastUpdated && <time dateTime={lastUpdated}>{new Date(lastUpdated).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>}</span>
      </div>
      <div className="glance-reading glance-cpu" data-state={cpuStatus}>
        <span className="glance-label">CPU{cpuStatus === "stale" && " · stale"}</span>
        <span className="glance-value">{readout(cpuValue)}{cpuStatus === "available" && <HeaderSparkline history={cpuHistory} />}</span>
      </div>
      <div className="glance-reading glance-ram" data-state={ramStatus}>
        <span className="glance-label">RAM{ramStatus === "stale" && " · stale"}</span>
        <span className="glance-value">{readout(ramValue)}{ramPercent !== null && <span className="glance-meter" aria-hidden="true"><i style={{ width: `${ramPercent}%` }} /></span>}</span>
      </div>
      <div className="glance-reading glance-disk" data-state={diskStatus}>
        <span className="glance-label">Disk /{diskStatus === "stale" && " · stale"}</span>
        <span className="glance-value">{diskPercent !== null ? `${diskPercent.toFixed(1)}%` : initialLoading ? "…" : "Unavailable"}{diskPercent !== null && <span className="glance-meter" aria-hidden="true"><i style={{ width: `${diskPercent}%` }} /></span>}</span>
      </div>
      <div className="glance-reading glance-uptime" data-state={uptimeStatus}>
        <span className="glance-label">Uptime{uptimeStatus === "stale" && " · stale"}</span>
        <span className="glance-value">{uptime ? shortUptime(uptime.value) : initialLoading ? "…" : "Unavailable"}</span>
      </div>
      <span className="mobile-server-status" data-state={state} title={status}><i className="server-status-dot" aria-hidden="true" /><span className="visually-hidden">{status}</span></span>
    </Link>
  );
}

function AccountMenu() {
  return (
    <Popover>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon" className="account-trigger" aria-label="Owner account" />}>
        <UserRound data-icon="inline-start" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="account-menu">
        <PopoverTitle>Owner account</PopoverTitle>
        <PopoverDescription>Voidstation · Home Server</PopoverDescription>
        <LogoutButton />
      </PopoverContent>
    </Popover>
  );
}

export function AppShell({ active, mobileLeading, mobileTrailing, children }: {
  active: "assistant" | "dashboard";
  mobileLeading?: ReactNode;
  mobileTrailing?: ReactNode;
  children: ReactNode;
}) {
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const element = shell.current;
      if (!element) return;
      const small = window.matchMedia("(max-width: 859px)").matches;
      const typing = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
      const keyboardOpen = small && typing && window.innerHeight - viewport.height > 150;
      element.dataset.keyboardOpen = String(keyboardOpen);
      if (keyboardOpen) element.style.setProperty("--shell-height", `${viewport.height}px`);
      else element.style.removeProperty("--shell-height");
    };
    viewport.addEventListener("resize", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      viewport.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
  return (
    <ServerMetricsProvider>
      <div className="app-shell" data-workspace={active} ref={shell}>
        <a className="skip-link" href="#workspace-content">Skip to content</a>
        <header className="app-header">
          {mobileLeading && <div className="app-mobile-action">{mobileLeading}</div>}
          <Link className="app-logo" href="/assistant"><Wordmark /></Link>
          <WorkspaceNavigation active={active} />
          <ServerGlance />
          {mobileTrailing && <div className="app-mobile-action app-mobile-trailing">{mobileTrailing}</div>}
          <AccountMenu />
        </header>
        <div className="app-content" id="workspace-content" tabIndex={-1}>{children}</div>
        <WorkspaceNavigation active={active} mobile />
      </div>
    </ServerMetricsProvider>
  );
}
