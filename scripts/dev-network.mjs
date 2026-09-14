import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isIPv4 } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

async function main() {
  process.umask(0o077);
  const host = lanAddress();
  const port = Number(process.env.VOIDSTATION_DEV_PORT ?? "3443");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("VOIDSTATION_DEV_PORT must be a port from 1 to 65535.");
  const state = resolve(process.env.VOIDSTATION_DEV_STATE_DIR ?? join(tmpdir(), "voidstation-debug"));
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const origin = `https://${host}:${port}`;
  const database = join(state, "auth.sqlite");
  const env = { ...process.env, NODE_ENV: "development", VOIDSTATION_AUTH_DB: database, VOIDSTATION_ORIGIN: origin };
  if (!existsSync(database)) {
    console.log("Create a debug-only owner password. Do not use your production password.");
    const setup = spawnSync(process.execPath, ["scripts/owner.ts", "bootstrap"], { env, stdio: "inherit" });
    if (setup.error) throw setup.error;
    if (setup.status !== 0) { process.exitCode = setup.status ?? 1; return; }
  }

  const certPath = join(state, "lan-cert.pem");
  const keyPath = join(state, "lan-key.pem");
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
