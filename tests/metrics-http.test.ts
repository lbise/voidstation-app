import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { HostMetrics } from "../src/lib/metrics-contract";

let app: ChildProcess | undefined;
let directory: string;
let dataDirectory: string;
let origin: string;
let output = "";
let port: number;
let certificate: Buffer;
const password = "test-owner-password-7";
const recoveredPassword = "recovered-owner-password-7";
const hostname = "voidstation.test-tailnet.ts.net";

function owner(command: "bootstrap" | "recover", secret = password) {
  return execFileSync(process.execPath, ["scripts/owner.ts", command, "--password-stdin"], {
    env: { ...process.env, VOIDSTATION_AUTH_DB: join(directory, "auth", "auth.sqlite") },
    input: `${secret}\n`, encoding: "utf8",
  });
}

function request(path: string, init: RequestInit = {}, cookie = ""): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) headers.set("host", new URL(origin).host);
    if (cookie) headers.set("cookie", cookie);
    const req = httpsRequest({
      hostname: "127.0.0.1", port, servername: hostname, ca: certificate,
      path, method: init.method ?? "GET", headers: Object.fromEntries(headers),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, values] of Object.entries(res.headers)) {
          for (const value of Array.isArray(values) ? values : values ? [values] : []) responseHeaders.append(name, value);
        }
        resolve(new Response(init.method === "HEAD" ? null : Buffer.concat(chunks), {
          status: res.statusCode, headers: responseHeaders,
        }));
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("Request timed out")));
    req.end(init.body?.toString());
  });
}

function login(secret = password, headers: Record<string, string> = {}) {
  return request("/api/auth/login", {
    method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ password: secret }),
  });
}

async function session(secret = password) {
  const response = await login(secret);
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "voidstation-http-"));
  // /dev/shm gives the integration test a filesystem identity distinct from /tmp.
  dataDirectory = await mkdtemp(join("/dev/shm", "voidstation-http-data-"));
  await writeFile(join(directory, "stat"), "cpu  100 20 30 40 10 0 0 0 0 0\n");
  await writeFile(join(directory, "uptime"), "90061.25 180000.00\n");
  await writeFile(join(directory, "meminfo"), "MemTotal: 8388608 kB\nMemAvailable: 3145728 kB\n");

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  origin = `https://${hostname}:${port}`;
  await mkdir(join(directory, "auth"), { mode: 0o700 });
  const certPath = join(directory, "cert.pem");
  const keyPath = join(directory, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`,
    "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  certificate = await readFile(certPath);
  owner("bootstrap");

  app = spawn(process.execPath, ["scripts/https-server.mjs"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1", PORT: String(port),
      VOIDSTATION_ORIGIN: origin,
      VOIDSTATION_AUTH_DB: join(directory, "auth", "auth.sqlite"),
      VOIDSTATION_TLS_CERT: certPath, VOIDSTATION_TLS_KEY: keyPath,
      VOIDSTATION_HOST_PROC: directory,
      VOIDSTATION_HOST_ROOT_FS: directory,
      VOIDSTATION_HOST_DATA_FS: dataDirectory,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", (chunk) => { output += chunk; });
  app.stderr?.on("data", (chunk) => { output += chunk; });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Application exited:\n${output}`);
    try {
      const response = await request("/login");
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
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

it("exposes no pages or measurements before owner login, including future routes and RSC requests", async () => {
  for (const path of ["/", "/assistant", "/unknown", "/?__rsc=test"]) {
    const response = await request(path);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toMatch(/\/login$/);
    expect(await response.text()).not.toContain("Home Server");
  }
  for (const path of ["/api/metrics", "/api/assistant", "/api/metrics?path=/etc/passwd"]) {
    const response = await request(path);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toMatch(/90061|8589934592|observedAt|Home Server/);
  }
});

it("accepts only the owner password and issues a private, secure application session", async () => {
  expect((await request("/login")).status).toBe(200);
  const invalid = await login("incorrect-password");
  expect(invalid.status).toBe(401);
  expect(invalid.headers.get("set-cookie")).toBeNull();
  expect(await invalid.text()).not.toMatch(/scrypt|salt|sqlite|test-owner/);

  const response = await login();
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/^__Host-voidstation-session=[A-Za-z0-9_-]+;/);
  for (const attribute of ["HttpOnly", "Secure", "SameSite=strict", "Path=/", "Max-Age=28800"]) {
    expect(setCookie.toLowerCase()).toContain(attribute.toLowerCase());
  }
  expect(setCookie).not.toMatch(/Domain=|password|provider|api.key/i);
});

it("does not cache authenticated pages", async () => {
  const page = await request("/", {}, await session());
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toContain("no-store");
  expect(await page.text()).toContain("Dashboard");
});

it("rejects forged session cookies", async () => {
  const cookie = await session();
  expect((await request("/api/metrics", {}, `${cookie}tampered`)).status).toBe(401);
});

it("rejects registration attempts", async () => {
  expect((await request("/api/auth/register", { method: "POST", headers: { origin } })).status).toBe(401);
});

it("serves real host measurements, fresh observations, partial failure and recovery over authenticated HTTPS", async () => {
  owner("recover");
  const cookie = await session();
  const fetch = (url: string, init: RequestInit = {}) => request(url.slice(origin.length), {
    ...init, headers: { origin, ...Object.fromEntries(new Headers(init.headers)) },
  }, cookie);
  const before = Date.now();
  const response = await fetch(`${origin}/api/metrics`);
  const metrics = await response.json() as HostMetrics;
  const after = Date.now();

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(metrics.cpu).toEqual({ status: "unavailable", value: null, unit: "percent", observedAt: null });
  expect(metrics.uptime).toEqual({ status: "available", value: 90061.25, unit: "seconds", observedAt: expect.any(String) });
  expect(metrics.ram).toEqual({
    status: "available", unit: "bytes", observedAt: expect.any(String),
    value: { total: 8589934592, available: 3221225472, used: 5368709120 },
  });
  for (const metric of [metrics.uptime, metrics.ram, metrics.rootFilesystem, metrics.dataFilesystem]) {
    expect(metric.status).toBe("available");
    if (metric.status === "available") {
      expect(Date.parse(metric.observedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(metric.observedAt)).toBeLessThanOrEqual(after);
    }
  }
  for (const metric of [metrics.rootFilesystem, metrics.dataFilesystem]) {
    if (metric.status === "available") {
      expect(metric.unit).toBe("bytes");
      expect(metric.value.total).toBeGreaterThan(0);
      expect(metric.value.used + metric.value.available).toBeLessThanOrEqual(metric.value.total);
    }
  }

  await writeFile(join(directory, "stat"), "cpu  110 25 35 50 15 0 0 0 0 0\n");
  const secondBefore = Date.now();
  const second = await (await fetch(`${origin}/api/metrics`)).json() as HostMetrics;
  const secondAfter = Date.now();
  expect(second.cpu).toEqual({ status: "available", value: (20 / 35) * 100, unit: "percent", observedAt: expect.any(String) });
  expect(Date.parse(second.cpu.observedAt!)).toBeGreaterThanOrEqual(secondBefore);
  expect(Date.parse(second.cpu.observedAt!)).toBeLessThanOrEqual(secondAfter);

  // Separate observations beyond the wall clock's millisecond resolution.
  await delay(2);
  await rm(join(directory, "meminfo"));
  await writeFile(join(directory, "stat"), "cpu  120 30 40 60 20 0 0 0 0 0\n");
  await writeFile(join(directory, "uptime"), "90066.25 180000.00\n");
  // Query strings cannot select arbitrary files or inject readings.
  const partialResponse = await fetch(`${origin}/api/metrics?path=/etc/passwd&uptime=0&fixture=zero`, {
    headers: { "If-None-Match": response.headers.get("etag") ?? '"old-reading"' },
  });
  const partial = await partialResponse.json() as HostMetrics;
  expect(partialResponse.status).toBe(200);
  expect(partialResponse.headers.get("cache-control")).toContain("no-store");
  expect(partial.cpu).toEqual({ status: "available", value: (20 / 35) * 100, unit: "percent", observedAt: expect.any(String) });
  expect(partial.uptime).toEqual({ status: "available", value: 90066.25, unit: "seconds", observedAt: expect.any(String) });
  expect(partial.ram).toEqual({ status: "unavailable", value: null, unit: "bytes", observedAt: null });
  expect(partial.rootFilesystem.status).toBe("available");
  expect(partial.dataFilesystem.status).toBe("available");
  expect(Date.parse(partial.uptime.observedAt!)).toBeGreaterThan(Date.parse(metrics.uptime.observedAt!));

  await rm(dataDirectory, { recursive: true, force: true });
  const missingData = await (await fetch(`${origin}/api/metrics`)).json() as HostMetrics;
  expect(missingData.rootFilesystem.status).toBe("available");
  expect(missingData.dataFilesystem).toEqual({ status: "unavailable", value: null, unit: "bytes", observedAt: null });
  await mkdir(dataDirectory);

  await writeFile(join(directory, "meminfo"), "MemTotal: 8388608 kB\nMemAvailable: 8388608 kB\n");
  const recovered = await (await fetch(`${origin}/api/metrics`)).json() as HostMetrics;
  expect(recovered.ram).toEqual({
    status: "available", unit: "bytes", observedAt: expect.any(String),
    value: { total: 8589934592, available: 8589934592, used: 0 },
  });
  expect((await fetch(`${origin}/api/metrics`, { method: "POST" })).status).toBe(405);
});

it("rejects missing, forged and cross-site origins for login and authenticated mutations", async () => {
  owner("recover");
  const cookie = await session();
  const rejectedHeaders: Record<string, string>[] = [
    {}, { origin: "null" }, { origin: "https://evil.invalid" },
    { origin, "sec-fetch-site": "cross-site" },
    { origin: "http://" + new URL(origin).host },
    { origin: "https://evil.invalid", "x-forwarded-host": "evil.invalid", "x-forwarded-proto": "https" },
  ];
  for (const headers of rejectedHeaders) {
    for (const path of ["/api/auth/login", "/api/auth/logout", "/api/metrics", "/api/assistant", "/assistant"]) {
      const response = await request(path, { method: "POST", headers }, cookie);
      expect(response.status, `${path} ${JSON.stringify(headers)}`).toBe(403);
      expect(await response.text()).not.toContain("observedAt");
    }
  }
  expect((await request("/api/metrics", {}, cookie)).status).toBe(200);
  expect((await request("/api/metrics", { headers: { host: "evil.invalid", "x-forwarded-host": new URL(origin).host } }, cookie)).status).toBe(421);
});

it("logs out server-side and rejects replay of the revoked cookie", async () => {
  owner("recover");
  const cookie = await session();
  const response = await request("/api/auth/logout", { method: "POST", headers: { origin } }, cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  expect((await request("/api/metrics", {}, cookie)).status).toBe(401);
  expect((await request("/", {}, cookie)).headers.get("location")).toBe(`${origin}/login`);
});

it("recovery invalidates every existing session without restarting the application", async () => {
  owner("recover");
  const first = await session();
  const second = await session();
  expect(second).not.toBe(first);
  owner("recover", recoveredPassword);
  for (const cookie of [first, second]) {
    expect((await request("/api/metrics", {}, cookie)).status).toBe(401);
  }
  expect((await login()).status).toBe(401);
  const fresh = await session(recoveredPassword);
  expect((await request("/api/metrics", {}, fresh)).status).toBe(200);
});

it("limits concurrent password attempts globally despite spoofed network identities", async () => {
  owner("recover");
  const attempts = await Promise.all(Array.from({ length: 7 }, (_, index) => login("incorrect-password", {
    "x-forwarded-for": `100.64.0.${index + 1}`, "tailscale-user-login": `forged${index}@invalid`,
  })));
  expect(attempts.filter((response) => response.status === 401)).toHaveLength(5);
  expect(attempts.filter((response) => response.status === 429)).toHaveLength(2);
  const limited = await login();
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(900);
  expect(limited.headers.get("set-cookie")).toBeNull();
});

it("recovery resets the sign-in attempt limit", async () => {
  owner("recover");
  expect((await login()).status).toBe(200);
});

it("allows only login's build assets before authentication, not arbitrary files or framework bypasses", async () => {
  const loginPage = await (await request("/login")).text();
  expect(loginPage).not.toMatch(/Home Server|observedAt|90061|8589934592/);
  const assets = [...loginPage.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+)(?:\?[^"<]*)?"/g)].map((match) => match[1]);
  expect(assets.length).toBeGreaterThan(0);
  for (const asset of assets) expect((await request(asset)).status, asset).toBe(200);
  for (const path of ["/.env", "/auth.sqlite", "/_next/image?url=/api/metrics&w=64&q=75", "/_next/static/not-login.js", "/api/metrics.json"]) {
    expect([307, 401]).toContain((await request(path)).status);
  }
  const bypass = await request("/api/metrics", { headers: {
    "x-middleware-subrequest": "src/proxy:src/proxy:src/proxy:src/proxy:src/proxy",
    "x-nextjs-data": "1", "x-forwarded-proto": "https", "x-forwarded-host": new URL(origin).host,
  } });
  expect(bypass.status).toBe(401);
  const rsc = await request("/?_rsc=test", { headers: { RSC: "1" } });
  expect(await rsc.text()).not.toMatch(/Home Server|observedAt|90061|8589934592/);
  expect(rsc.status).toBe(307);
});

it("has no plaintext HTTP listener, even with a forged host or forwarded HTTPS header", async () => {
  const result = await new Promise<string>((resolve) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path: "/api/metrics", headers: {
      host: new URL(origin).host, "x-forwarded-proto": "https",
    } }, (res) => { res.resume(); resolve(`HTTP ${res.statusCode}`); });
    req.on("error", () => resolve("connection rejected"));
    req.setTimeout(2000, () => req.destroy());
    req.end();
  });
  expect(result).toBe("connection rejected");
});
