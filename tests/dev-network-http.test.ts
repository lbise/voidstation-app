import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cp, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, expect, it } from "vitest";
import { freePort, stop } from "./helpers/assistant-server";

const checkout = process.cwd();
const devNetwork = join(checkout, "scripts", "dev-network.mjs");
let app: ChildProcess | undefined;
let directory: string;
let productionDirectory: string;
let fixture: string;

async function fixtureCheckout() {
  const project = await mkdtemp(join(tmpdir(), "voidstation-network-fixture-"));
  for (const file of ["next.config.ts", "next-env.d.ts", "package.json", "package-lock.json", "postcss.config.mjs", "tokens.css", "tsconfig.json"]) {
    await copyFile(join(checkout, file), join(project, file));
  }
  await cp(join(checkout, "src"), join(project, "src"), { recursive: true });
  const dependencies = join(project, "node_modules");
  try {
    execFileSync("cp", ["-al", join(checkout, "node_modules"), dependencies], { stdio: "ignore" });
  } catch {
    // /tmp may be a different filesystem, where hard links are unavailable.
    await rm(dependencies, { recursive: true, force: true });
    await cp(join(checkout, "node_modules"), dependencies, { recursive: true });
  }
  return project;
}

afterAll(async () => {
  await stop(app);
  for (const path of [directory, productionDirectory, fixture]) {
    if (path) await rm(path, { recursive: true, force: true });
  }
});

const containerBridge = Object.entries(networkInterfaces()).filter(([name]) => /^(docker|br-)/.test(name))
  .flatMap(([, addresses]) => addresses ?? []).find(({ family }) => family === "IPv4")?.address;
it.each(["0.0.0.0", ...(containerBridge ? [containerBridge] : [])])("rejects %s as a development listener outside the LAN", (host) => {
  const result = spawn(process.execPath, [devNetwork], {
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

it("rejects a production state path supplied only by the local .env", async () => {
  const protectedState = await mkdtemp(join(tmpdir(), "voidstation-network-production-env-"));
  const project = await fixtureCheckout();
  try {
    await writeFile(join(project, ".env"), `VOIDSTATION_AUTH_DIRECTORY=${protectedState}\n`);
    const result = spawn(process.execPath, [devNetwork], {
      cwd: project,
      env: { PATH: process.env.PATH, HOME: project, NODE_ENV: "development", VOIDSTATION_DEV_HOST: "", VOIDSTATION_DEV_STATE_DIR: protectedState },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = await new Promise<string>((resolve, reject) => {
      let value = "";
      result.stderr.on("data", (chunk) => { value += chunk; });
      result.on("error", reject);
      result.on("exit", (code) => code === 1 ? resolve(value) : reject(new Error(`Expected exit 1, received ${code}`)));
    });
    expect(output).toContain("VOIDSTATION_AUTH_DIRECTORY");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(protectedState, { recursive: true, force: true });
  }
});

it("starts authenticated HTTPS development from an editable isolated fixture", async () => {
  directory = await mkdtemp(join(tmpdir(), "voidstation-network-dev-"));
  productionDirectory = await mkdtemp(join(tmpdir(), "voidstation-network-production-"));
  fixture = await fixtureCheckout();
  await writeFile(join(fixture, ".env"), `VOIDSTATION_AUTH_DIRECTORY=${productionDirectory}\n`);
  const password = "network-development-test-password";
  execFileSync(process.execPath, ["scripts/owner.ts", "bootstrap", "--password-stdin"], {
    env: { ...process.env, VOIDSTATION_AUTH_DB: join(directory, "auth.sqlite") },
    input: `${password}\n`, stdio: ["pipe", "pipe", "pipe"],
  });
  const port = await freePort();
  let output = "";
  app = spawn(process.execPath, [devNetwork], {
    cwd: fixture,
    env: { PATH: process.env.PATH, HOME: directory, VOIDSTATION_DEV_HOST: "", VOIDSTATION_DEV_PORT: String(port),
      VOIDSTATION_DEV_STATE_DIR: directory, NEXT_TELEMETRY_DISABLED: "1",
      // These inherited production settings must not select the debug account or origin.
      VOIDSTATION_AUTH_DB: join(productionDirectory, "must-not-use-production.sqlite"),
      VOIDSTATION_ORIGIN: "https://production.invalid", VOIDSTATION_LAN_ORIGIN: "https://production-lan.invalid",
      VOIDSTATION_LAN_TLS_CERT: join(productionDirectory, "lan-cert.pem"), VOIDSTATION_LAN_TLS_KEY: join(productionDirectory, "lan-key.pem"),
      VOIDSTATION_WORKER_URL: "http://production.invalid:3001", VOIDSTATION_WORKER_TOKEN_FILE: join(productionDirectory, "worker-token"),
      VOIDSTATION_CONVERSATION_DIR: join(productionDirectory, "conversations"), VOIDSTATION_CREDENTIAL_DIR: join(productionDirectory, "credentials"),
      VOIDSTATION_DEV_TEST_TURBOPACK_ROOT: fixture, NODE_ENV: "production" },
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
        res.on("end", () => {
          clearTimeout(timeout);
          resolve(new Response(Buffer.concat(chunks), {
            status: res.statusCode,
            headers: { "set-cookie": res.headers["set-cookie"]?.join(",") ?? "" },
          }));
        });
      });
      const timeout = setTimeout(() => req.destroy(new Error(`Development request for ${path} timed out`)), 30_000);
      req.on("error", (error) => { clearTimeout(timeout); reject(error); });
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

  const loginPath = join(fixture, "src", "app", "login", "page.tsx");
  const marker = "Changed without restarting development.";
  await writeFile(loginPath, (await readFile(loginPath, "utf8")).replace("Enter your password to continue.", marker));
  let refreshed = false;
  while (Date.now() < deadline) {
    if ((await (await request("/login")).text()).includes(marker)) { refreshed = true; break; }
    await delay(100);
  }
  expect(refreshed, output).toBe(true);
  expect(output).not.toContain(password);
}, 105_000);
