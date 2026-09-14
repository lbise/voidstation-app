import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, expect, it } from "vitest";
import { freePort, stop } from "./helpers/assistant-server";

let app: ChildProcess | undefined;
let directory: string;

afterAll(async () => {
  await stop(app);
  if (directory) await rm(directory, { recursive: true, force: true });
});

const containerBridge = Object.entries(networkInterfaces()).filter(([name]) => /^(docker|br-)/.test(name))
  .flatMap(([, addresses]) => addresses ?? []).find(({ family }) => family === "IPv4")?.address;
it.each(["0.0.0.0", ...(containerBridge ? [containerBridge] : [])])("rejects %s as a development listener outside the LAN", (host) => {
  const result = spawn(process.execPath, ["scripts/dev-network.mjs"], {
    env: { ...process.env, VOIDSTATION_DEV_HOST: host }, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<void>((resolve, reject) => {
    let output = "";
    result.stderr.on("data", (chunk) => { output += chunk; });
    result.on("error", reject);
    result.on("exit", (code) => {
      try {
        expect(code).toBe(1);
        expect(output).toContain("assigned private LAN IPv4 address");
        resolve();
      } catch (error) { reject(error); }
    });
  });
});

it("starts authenticated HTTPS development at its reported LAN address with separate debug state", async () => {
  directory = await mkdtemp(join(tmpdir(), "voidstation-network-dev-"));
  const password = "network-development-test-password";
  execFileSync(process.execPath, ["scripts/owner.ts", "bootstrap", "--password-stdin"], {
    env: { ...process.env, VOIDSTATION_AUTH_DB: join(directory, "auth.sqlite") },
    input: `${password}\n`, stdio: ["pipe", "pipe", "pipe"],
  });
  const port = await freePort();
  let output = "";
  app = spawn(process.execPath, ["scripts/dev-network.mjs"], {
    env: { PATH: process.env.PATH, HOME: directory, VOIDSTATION_DEV_HOST: "", VOIDSTATION_DEV_PORT: String(port),
      VOIDSTATION_DEV_STATE_DIR: directory, NEXT_TELEMETRY_DISABLED: "1",
      // These inherited production settings must not select the debug account or origin.
      VOIDSTATION_AUTH_DB: join(directory, "must-not-use-production.sqlite"),
      VOIDSTATION_ORIGIN: "https://production.invalid", NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", (chunk) => { output += chunk; });
  app.stderr?.on("data", (chunk) => { output += chunk; });
  let origin: string | undefined;
  const deadline = Date.now() + 60_000;

  async function request(path: string, method = "GET", body?: string, requestOrigin?: string): Promise<Response> {
    const url = new URL(path, origin);
    const ca = await readFile(join(directory, "lan-cert.pem"));
    return new Promise((resolve, reject) => {
      const req = httpsRequest(url, {
        ca, method, headers: {
          ...(requestOrigin ? { origin: requestOrigin } : {}), "content-type": "application/x-www-form-urlencoded",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode,
          headers: { "set-cookie": res.headers["set-cookie"]?.join(",") ?? "" },
        })));
      });
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("Development request timed out")));
      req.end(body);
    });
  }

  let ready = false;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Network development exited:\n${output}`);
    origin = output.match(/LAN development: (https:\/\/[\d.]+:\d+)/)?.[1];
    if (origin) {
      try { if ((await request("/login")).status === 200) { ready = true; break; } } catch { /* Wait for Next. */ }
    }
    await delay(100);
  }
  expect(ready, output).toBe(true);
  expect(new URL(origin!).hostname).not.toBe("127.0.0.1");
  expect((await request("/api/metrics")).status).toBe(401);
  const body = new URLSearchParams({ password }).toString();
  expect((await request("/api/auth/login", "POST", body, "https://attacker.invalid")).status).toBe(403);
  const login = await request("/api/auth/login", "POST", body, origin);
  expect(login.status).toBe(200);
  expect(login.headers.get("set-cookie")).toContain("Secure");
  expect(output).not.toContain(password);
}, 75_000);
