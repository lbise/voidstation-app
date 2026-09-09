import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { HostMetrics } from "../src/lib/metrics-contract";

let app: ChildProcess | undefined;
let directory: string;
let origin: string;
let output = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "voidstation-http-"));
  await writeFile(join(directory, "uptime"), "90061.25 180000.00\n");
  await writeFile(join(directory, "meminfo"), "MemTotal: 8388608 kB\nMemAvailable: 3145728 kB\n");

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;

  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, NODE_ENV: "production", VOIDSTATION_HOST_PROC: directory, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", (chunk) => { output += chunk; });
  app.stderr?.on("data", (chunk) => { output += chunk; });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Application exited:\n${output}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Wait for the real production server to listen. */ }
    await delay(100);
  }
  throw new Error(`Application did not start. Run npm run build first.\n${output}`);
});

afterAll(async () => {
  if (app && app.exitCode === null) {
    const exited = once(app, "exit");
    app.kill("SIGTERM");
    const force = setTimeout(() => app?.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(force);
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("serves real host measurements, fresh observations, partial failure and recovery over HTTP", async () => {
  const before = Date.now();
  const response = await fetch(`${origin}/api/metrics`);
  const metrics = await response.json() as HostMetrics;
  const after = Date.now();

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(metrics).toEqual({
    uptime: { status: "available", value: 90061.25, unit: "seconds", observedAt: expect.any(String) },
    ram: {
      status: "available", unit: "bytes", observedAt: expect.any(String),
      value: { total: 8589934592, available: 3221225472, used: 5368709120 },
    },
  });
  for (const metric of Object.values(metrics)) {
    expect(Date.parse(metric.observedAt!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(metric.observedAt!)).toBeLessThanOrEqual(after);
  }

  // Separate observations beyond the wall clock's millisecond resolution.
  await delay(2);
  await rm(join(directory, "meminfo"));
  await writeFile(join(directory, "uptime"), "90066.25 180000.00\n");
  // Query strings cannot select arbitrary files or inject readings.
  const partialResponse = await fetch(`${origin}/api/metrics?path=/etc/passwd&uptime=0&fixture=zero`, {
    headers: { "If-None-Match": response.headers.get("etag") ?? '"old-reading"' },
  });
  const partial = await partialResponse.json() as HostMetrics;
  expect(partialResponse.status).toBe(200);
  expect(partialResponse.headers.get("cache-control")).toContain("no-store");
  expect(partial).toEqual({
    uptime: { status: "available", value: 90066.25, unit: "seconds", observedAt: expect.any(String) },
    ram: { status: "unavailable", value: null, unit: "bytes", observedAt: null },
  });
  expect(Date.parse(partial.uptime.observedAt!)).toBeGreaterThan(Date.parse(metrics.uptime.observedAt!));

  await writeFile(join(directory, "meminfo"), "MemTotal: 8388608 kB\nMemAvailable: 8388608 kB\n");
  const recovered = await (await fetch(`${origin}/api/metrics`)).json() as HostMetrics;
  expect(recovered.ram).toEqual({
    status: "available", unit: "bytes", observedAt: expect.any(String),
    value: { total: 8589934592, available: 8589934592, used: 0 },
  });
  expect((await fetch(`${origin}/api/metrics`, { method: "POST" })).status).toBe(405);
});
