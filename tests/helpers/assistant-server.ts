import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";

export async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  const force = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(force);
}

export async function assistantServer() {
  const directory = await mkdtemp(join(tmpdir(), "voidstation-assistant-"));
  const port = await freePort();
  const lanPort = await freePort();
  const workerPort = await freePort();
  const hostname = "voidstation.test-tailnet.ts.net";
  const lanHostname = "voidstation.test-lan.invalid";
  const origin = `https://${hostname}:${port}`;
  const lanOrigin = `https://${lanHostname}:${lanPort}`;
  const password = "assistant-test-owner-password";
  const token = "synthetic-worker-secret-canary-123456789";
  const tokenFile = join(directory, "worker-token");
  const fixtureFile = join(directory, "model.json");
  const authDatabase = join(directory, "auth", "auth.sqlite");
  const cert = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  const lanCert = join(directory, "lan-cert.pem");
  const lanKey = join(directory, "lan-key.pem");
  let output = "";
  let worker: ChildProcess | undefined;
  await mkdir(join(directory, "auth"), { mode: 0o700 });
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(fixtureFile, JSON.stringify({ steps: [{ text: "A saved reply." }] }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`,
    "-keyout", key, "-out", cert], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${lanHostname}`, "-addext", `subjectAltName=DNS:${lanHostname}`,
    "-keyout", lanKey, "-out", lanCert], { stdio: "ignore" });
  const certificate = await readFile(cert);
  const lanCertificate = await readFile(lanCert);
  execFileSync(process.execPath, ["scripts/owner.ts", "bootstrap", "--password-stdin"], {
    env: { ...process.env, VOIDSTATION_AUTH_DB: authDatabase }, input: `${password}\n`, stdio: ["pipe", "pipe", "pipe"],
  });
  const capture = (child: ChildProcess) => {
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    return child;
  };
  const app = capture(spawn(process.execPath, ["scripts/https-server.mjs"], {
    env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port),
      VOIDSTATION_ORIGIN: origin, VOIDSTATION_LAN_ORIGIN: lanOrigin, VOIDSTATION_LAN_PORT: String(lanPort), VOIDSTATION_AUTH_DB: authDatabase,
      VOIDSTATION_TLS_CERT: cert, VOIDSTATION_TLS_KEY: key, VOIDSTATION_LAN_TLS_CERT: lanCert, VOIDSTATION_LAN_TLS_KEY: lanKey,
      VOIDSTATION_HOST_PROC: directory, VOIDSTATION_HOST_ROOT_FS: directory, VOIDSTATION_HOST_DATA_FS: directory,
      VOIDSTATION_WORKER_URL: `http://127.0.0.1:${workerPort}`, VOIDSTATION_WORKER_TOKEN_FILE: tokenFile,
      NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
  }));

  function request(path: string, init: RequestInit = {}, cookie = ""): Promise<Response> {
    return new Promise((resolve, reject) => {
      const headers = new Headers(init.headers);
      headers.set("host", new URL(origin).host);
      if (cookie) headers.set("cookie", cookie);
      const req = httpsRequest({ hostname: "127.0.0.1", port, servername: hostname, ca: certificate,
        path, method: init.method ?? "GET", headers: Object.fromEntries(headers) }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, values] of Object.entries(res.headers)) {
            for (const value of Array.isArray(values) ? values : values ? [values] : []) responseHeaders.append(name, value);
          }
          resolve(new Response(res.statusCode === 204 || init.method === "HEAD" ? null : Buffer.concat(chunks), {
            status: res.statusCode, headers: responseHeaders,
          }));
        });
      });
      req.on("error", reject);
      req.setTimeout(10_000, () => req.destroy(new Error("Request timed out")));
      req.end(init.body?.toString());
    });
  }

  function lanRequest(path: string, init: RequestInit = {}, cookie = ""): Promise<Response> {
    return new Promise((resolve, reject) => {
      const headers = new Headers(init.headers);
      headers.set("host", new URL(lanOrigin).host);
      if (cookie) headers.set("cookie", cookie);
      const req = httpsRequest({ hostname: "127.0.0.1", port: lanPort, servername: lanHostname, ca: lanCertificate,
        path, method: init.method ?? "GET", headers: Object.fromEntries(headers) }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, values] of Object.entries(res.headers)) {
            for (const value of Array.isArray(values) ? values : values ? [values] : []) responseHeaders.append(name, value);
          }
          resolve(new Response(res.statusCode === 204 || init.method === "HEAD" ? null : Buffer.concat(chunks), {
            status: res.statusCode, headers: responseHeaders,
          }));
        });
      });
      req.on("error", reject);
      req.setTimeout(10_000, () => req.destroy(new Error("Request timed out")));
      req.end(init.body?.toString());
    });
  }

  function internal(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: workerPort, path, headers }, (res) => {
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode }));
      });
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("Worker request timed out")));
      req.end();
    });
  }

  async function ready(check: () => Promise<boolean>, child: ChildProcess) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Server exited:\n${output}`);
      try { if (await check()) return; } catch { /* Waiting for the listener. */ }
      await delay(50);
    }
    throw new Error(`Server did not start:\n${output}`);
  }
  try { await ready(async () => (await request("/login")).ok, app); }
  catch (error) { await stop(app); await rm(directory, { recursive: true, force: true }); throw error; }

  return {
    directory, port, lanPort, workerPort, origin, lanOrigin, token, fixtureFile, certificate, lanCertificate, hostname, lanHostname, password,
    get output() { return output; }, request, lanRequest, internal,
    stream(path: string, cookie: string) {
      return new Promise<{ status: number; reader: ReadableStreamDefaultReader<Uint8Array>; close: () => void }>((resolve, reject) => {
        const req = httpsRequest({ hostname: "127.0.0.1", port, servername: hostname, ca: certificate,
          path, headers: { host: new URL(origin).host, cookie } }, (res) => {
          const reader = (Readable.toWeb(res) as ReadableStream<Uint8Array>).getReader();
          resolve({ status: res.statusCode!, reader, close: () => { void reader.cancel().catch(() => {}); req.destroy(); } });
        });
        req.on("error", reject);
        req.setTimeout(10_000, () => req.destroy(new Error("Stream timed out")));
        req.end();
      });
    },
    lanStream(path: string, cookie: string) {
      return new Promise<{ status: number; reader: ReadableStreamDefaultReader<Uint8Array>; close: () => void }>((resolve, reject) => {
        const req = httpsRequest({ hostname: "127.0.0.1", port: lanPort, servername: lanHostname, ca: lanCertificate,
          path, headers: { host: new URL(lanOrigin).host, cookie } }, (res) => {
          const reader = (Readable.toWeb(res) as ReadableStream<Uint8Array>).getReader();
          resolve({ status: res.statusCode!, reader, close: () => { void reader.cancel().catch(() => {}); req.destroy(); } });
        });
        req.on("error", reject);
        req.setTimeout(10_000, () => req.destroy(new Error("LAN stream timed out")));
        req.end();
      });
    },
    async session() {
      const response = await request("/api/auth/login", { method: "POST", headers: {
        origin, "content-type": "application/x-www-form-urlencoded",
      }, body: new URLSearchParams({ password }) });
      if (!response.ok) throw new Error(`Login failed: ${response.status}`);
      return response.headers.get("set-cookie")!.split(";")[0];
    },
    async lanSession() {
      const response = await lanRequest("/api/auth/login", { method: "POST", headers: {
        origin: lanOrigin, "content-type": "application/x-www-form-urlencoded",
      }, body: new URLSearchParams({ password }) });
      if (!response.ok) throw new Error(`LAN login failed: ${response.status}`);
      return response.headers.get("set-cookie")!.split(";")[0];
    },
    mutate(path: string, method: string, body: unknown, cookie: string) {
      return request(path, { method, headers: { origin, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie);
    },
    lanMutate(path: string, method: string, body: unknown, cookie: string) {
      return lanRequest(path, { method, headers: { origin: lanOrigin, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie);
    },
    async startWorker(extraEnv: Record<string, string> = {}) {
      worker = capture(spawn(process.execPath, ["worker/dist/server.js"], {
        env: { PATH: process.env.PATH, HOME: join(directory, "synthetic-home"), NODE_ENV: "test", VOIDSTATION_WORKER_HOST: "127.0.0.1",
          VOIDSTATION_WORKER_PORT: String(workerPort), VOIDSTATION_WORKER_TOKEN_FILE: tokenFile,
          VOIDSTATION_CONVERSATION_DIR: join(directory, "conversations"),
          VOIDSTATION_CREDENTIAL_DIR: join(directory, "credentials"),
          VOIDSTATION_MEDIA_SCRIPT_DIR: join(process.cwd(), "worker/media/upstream"),
          VOIDSTATION_MEDIA_CONFIG_FILE: join(directory, "media.json"),
          VOIDSTATION_TEST_MODEL_FILE: fixtureFile, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"],
      }));
      try {
        await ready(async () => {
          const response = await internal("/health", { authorization: `Bearer ${token}` });
          await response.body?.cancel();
          return response.ok;
        }, worker);
      } catch (error) { await stop(worker); worker = undefined; throw error; }
    },
    async stopWorker(signal: NodeJS.Signals = "SIGTERM") { await stop(worker, signal); worker = undefined; },
    async fixture(steps: { text?: string; chunks?: { text: string; delayMs?: number }[]; parts?: ({ type: "text"; text: string; delayMs?: number } | { type: "toolCall"; name: string; arguments: unknown })[]; toolCalls?: { name: string; arguments: unknown }[]; delayMs?: number; error?: string; rawError?: string; fault?: string; ignoreAbort?: boolean }[]) {
      await writeFile(fixtureFile, JSON.stringify({ steps }));
    },
    async close() {
      await stop(app); await stop(worker); await rm(directory, { recursive: true, force: true });
    },
  };
}

export type AssistantServer = Awaited<ReturnType<typeof assistantServer>>;
