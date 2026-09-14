import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { isIPv4 } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function privateIpv4(address) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function lanAddress() {
  const interfaces = Object.entries(networkInterfaces())
    .filter(([name]) => !/^(docker|br-|veth|virbr|tailscale|tun|tap|wg)/.test(name))
    .flatMap(([, addresses]) => (addresses ?? []).filter((address) =>
      !address.internal && address.family === "IPv4" && privateIpv4(address.address)));
  const configured = process.env.VOIDSTATION_DEV_HOST;
  if (configured) {
    if (!privateIpv4(configured) || !interfaces.some(({ address }) => address === configured)) {
      throw new Error("VOIDSTATION_DEV_HOST must be an assigned private LAN IPv4 address.");
    }
    return configured;
  }
  const candidates = [...new Set(interfaces.map(({ address }) => address))];
  if (candidates.length !== 1) throw new Error("Set VOIDSTATION_DEV_HOST to an assigned private LAN IPv4 address; automatic selection requires exactly one LAN address.");
  return candidates[0];
}

function resolvedPath(path) {
  const absolute = resolve(path);
  let existing = absolute;
  const missing = [];
  while (!existsSync(existing)) {
    missing.unshift(existing.slice(dirname(existing).length + 1));
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

function overlaps(first, second) {
  const path = relative(first, second);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function environmentFile() {
  try { return parseEnv(readFileSync(join(process.cwd(), ".env"), "utf8")); }
  catch { return {}; }
}

function pathDetails(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function verifyIsolatedState(state) {
  const requested = resolve(state);
  const requestedDetails = pathDetails(requested);
  if (requestedDetails?.isSymbolicLink()) throw new Error("VOIDSTATION_DEV_STATE_DIR must be a real directory, not a symlink.");
  const actualState = resolvedPath(requested);
  const checkout = resolvedPath(process.cwd());
  if (overlaps(actualState, checkout) || overlaps(checkout, actualState)) {
    throw new Error("VOIDSTATION_DEV_STATE_DIR must not contain or target the checkout.");
  }
  const fileEnvironment = environmentFile();
  const protectedPaths = [
    ["Voidstation application state", "/var/lib/voidstation"],
    ...["VOIDSTATION_AUTH_DB", "VOIDSTATION_AUTH_DIRECTORY", "VOIDSTATION_CONVERSATION_DIR",
      "VOIDSTATION_CONVERSATION_DIRECTORY", "VOIDSTATION_CREDENTIAL_DIR", "VOIDSTATION_CREDENTIAL_DIRECTORY",
      "VOIDSTATION_WORKER_TOKEN_FILE", "VOIDSTATION_TLS_DIRECTORY", "VOIDSTATION_LAN_TLS_DIRECTORY"].flatMap((name) =>
      [fileEnvironment[name], process.env[name]].filter(Boolean).map((value) => [name, value])),
  ];
  for (const [name, configured] of protectedPaths) {
    const protectedPath = resolvedPath(configured);
    if (overlaps(actualState, protectedPath) || overlaps(protectedPath, actualState)) {
      throw new Error(`VOIDSTATION_DEV_STATE_DIR must not contain or target ${name}.`);
    }
  }
  mkdirSync(actualState, { recursive: true, mode: 0o700 });
  const details = lstatSync(actualState);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("VOIDSTATION_DEV_STATE_DIR must be a real directory, not a symlink.");
  return realpathSync(actualState);
}

function requireRegularFile(path, name) {
  const details = pathDetails(path);
  if (!details) return;
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${name} must be a regular file, not a symlink or directory.`);
}

async function main() {
  process.umask(0o077);
  const host = lanAddress();
  const port = Number(process.env.VOIDSTATION_DEV_PORT ?? "3443");
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("VOIDSTATION_DEV_PORT must be a port from 1 to 65535.");
  const state = verifyIsolatedState(resolve(process.env.VOIDSTATION_DEV_STATE_DIR ?? join(tmpdir(), "voidstation-debug")));
  const origin = `https://${host}:${port}`;
  const database = join(state, "auth.sqlite");
  const certPath = join(state, "lan-cert.pem");
  const keyPath = join(state, "lan-key.pem");
  requireRegularFile(database, "Development authentication database");
  requireRegularFile(certPath, "Development certificate");
  requireRegularFile(keyPath, "Development private key");

  // Do not inherit production listeners, TLS material, worker credentials, or
  // durable state. Explicit empty LAN values also keep Next from importing a
  // same-named value from .env.
  const env = { ...process.env };
  for (const name of [
    "VOIDSTATION_ORIGIN", "VOIDSTATION_LAN_ORIGIN", "VOIDSTATION_LAN_PORT", "VOIDSTATION_PORT", "VOIDSTATION_TAILSCALE_BIND_ADDRESS",
    "VOIDSTATION_TLS_CERT", "VOIDSTATION_TLS_KEY", "VOIDSTATION_LAN_TLS_CERT", "VOIDSTATION_LAN_TLS_KEY", "VOIDSTATION_TLS_DIRECTORY", "VOIDSTATION_LAN_TLS_DIRECTORY",
    "VOIDSTATION_AUTH_DB", "VOIDSTATION_AUTH_DIRECTORY", "VOIDSTATION_WORKER_URL", "VOIDSTATION_WORKER_TOKEN_FILE",
    "VOIDSTATION_CONVERSATION_DIR", "VOIDSTATION_CONVERSATION_DIRECTORY", "VOIDSTATION_CREDENTIAL_DIR", "VOIDSTATION_CREDENTIAL_DIRECTORY",
    "VOIDSTATION_HOST_PROC", "VOIDSTATION_HOST_ROOT_FS", "VOIDSTATION_HOST_DATA_FS", "VOIDSTATION_DEV_NEXT_DIST_DIR", "VOIDSTATION_DEV_NETWORK",
  ]) delete env[name];
  Object.assign(env, {
    NODE_ENV: "development", VOIDSTATION_AUTH_DB: database, VOIDSTATION_ORIGIN: origin,
    VOIDSTATION_LAN_ORIGIN: "", VOIDSTATION_LAN_PORT: "",
    VOIDSTATION_TLS_CERT: certPath, VOIDSTATION_TLS_KEY: keyPath,
    VOIDSTATION_LAN_TLS_CERT: "", VOIDSTATION_LAN_TLS_KEY: "",
    VOIDSTATION_WORKER_URL: "http://127.0.0.1:9", VOIDSTATION_WORKER_TOKEN_FILE: join(state, "no-worker-token"),
    VOIDSTATION_CONVERSATION_DIR: join(state, "conversations"), VOIDSTATION_CREDENTIAL_DIR: join(state, "credentials"),
    VOIDSTATION_HOST_PROC: "/proc", VOIDSTATION_HOST_ROOT_FS: "/", VOIDSTATION_HOST_DATA_FS: "/host/filesystems/data",
    VOIDSTATION_DEV_NETWORK: "1",
  });
  if (!existsSync(database)) {
    console.log("Create a debug-only owner password. Do not use your production password.");
    const setup = spawnSync(process.execPath, [join(repository, "scripts", "owner.ts"), "bootstrap"], { env, stdio: "inherit" });
    if (setup.error) throw setup.error;
    if (setup.status !== 0) { process.exitCode = setup.status ?? 1; return; }
  }

  let validCertificate = false;
  try {
    const certificate = new X509Certificate(readFileSync(certPath));
    validCertificate = certificate.checkIP(host) === host && Date.parse(certificate.validTo) > Date.now() + 86_400_000 &&
      certificate.checkPrivateKey(createPrivateKey(readFileSync(keyPath)));
  } catch { /* First run, changed address, or an expired development certificate. */ }
  if (!validCertificate) {
    // Supply explicit files so Next cannot fall back to HTTP if mkcert fails.
    // This does not install a CA or change either machine's trust store.
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
      "-subj", `/CN=${host}`, "-addext", `subjectAltName=IP:${host}`, "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  }
  console.log(`LAN development: ${origin}`);
  console.log("Accept the development certificate warning on your laptop. No Tailscale is needed.");
  const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [next, "dev", "--hostname", host, "--port", String(port),
    "--experimental-https", "--experimental-https-key", keyPath, "--experimental-https-cert", certPath], { env, stdio: "inherit" });
  let force;
  const shutdown = (signal) => {
    if (force) return;
    child.kill(signal);
    force = setTimeout(() => child.kill("SIGKILL"), 5000);
  };
  const interrupt = () => shutdown("SIGINT");
  const terminate = () => shutdown("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit(code ?? (["SIGINT", "SIGTERM"].includes(signal) ? 0 : 1)));
    });
  } finally {
    clearTimeout(force);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

main().catch((error) => { console.error(`Network development could not start: ${error.message}`); process.exitCode = 1; });
