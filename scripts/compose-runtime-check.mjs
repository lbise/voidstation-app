#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function main() {
  const temporary = mkdtempSync(path.join(tmpdir(), "voidstation-compose-config-"));
  const fixture = path.join(temporary, "fixture");
  const environment = path.join(temporary, ".env");
  writeFileSync(environment, [
    "VOIDSTATION_DATA_FILESYSTEM_UUID=fixture-data-uuid",
    "VOIDSTATION_TAILSCALE_BIND_ADDRESS=100.101.102.103",
    "VOIDSTATION_PORT=8443",
    "VOIDSTATION_ORIGIN=https://voidstation.test-tailnet.ts.net:8443",
    "VOIDSTATION_LAN_BIND_ADDRESS=192.168.50.10",
    "VOIDSTATION_LAN_HTTPS_PORT=3000",
    "VOIDSTATION_LAN_ORIGIN=https://192.168.50.10:3000",
    "VOIDSTATION_LAN_INTERFACE=enp1s0",
    "VOIDSTATION_LAN_SOURCE=192.168.50.0/24",
    `VOIDSTATION_LAN_TLS_DIRECTORY=${fixture}/lan-tls`,
    `VOIDSTATION_AUTH_DIRECTORY=${fixture}/auth`,
    `VOIDSTATION_TLS_DIRECTORY=${fixture}/tls`,
    `VOIDSTATION_WORKER_TOKEN_FILE=${fixture}/worker-token`,
    `VOIDSTATION_CONVERSATION_DIRECTORY=${fixture}/conversations`,
    `VOIDSTATION_CREDENTIAL_DIRECTORY=${fixture}/credentials`,
    `VOIDSTATION_ROOT_FILESYSTEM_PATH=${fixture}/root`,
    `VOIDSTATION_DATA_FILESYSTEM_PATH=${fixture}/data`,
    "",
  ].join("\n"));
  try {
    const output = execFileSync("docker", ["compose", "--env-file", environment, "--project-name", "voidstation-app", "config", "--format", "json"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const configuration = JSON.parse(output);
    const services = configuration.services ?? {};
    if (JSON.stringify(Object.keys(services).sort()) !== JSON.stringify(["assistant-worker", "dashboard"])) {
      fail("Effective Compose configuration must contain only dashboard and assistant-worker.");
    }
    const dashboard = services.dashboard;
    const worker = services["assistant-worker"];
    if (dashboard.environment?.VOIDSTATION_WORKER_URL !== "http://assistant-worker:3001" ||
        dashboard.environment?.VOIDSTATION_WORKER_TOKEN_FILE !== "/run/voidstation-worker/token" ||
        dashboard.environment?.VOIDSTATION_LAN_ORIGIN !== "https://192.168.50.10:3000" ||
        dashboard.environment?.VOIDSTATION_LAN_PORT !== "3443" ||
        dashboard.environment?.VOIDSTATION_LAN_TLS_CERT !== "/run/voidstation-lan-tls/cert.pem" ||
        dashboard.environment?.VOIDSTATION_LAN_TLS_KEY !== "/run/voidstation-lan-tls/key.pem") {
      fail("Dashboard effective dual-listener configuration changed.");
    }
    const publications = dashboard.ports ?? [];
    if (publications.length !== 2 || !publications.some((port) => port.target === 3000 && port.host_ip === "100.101.102.103" && String(port.published) === "8443") ||
        !publications.some((port) => port.target === 3443 && port.host_ip === "192.168.50.10" && String(port.published) === "3000")) {
      fail("Dashboard must publish exactly the Tailscale and LAN listeners.");
    }
    if (!dashboard.volumes?.some((volume) => volume.target === "/run/voidstation-lan-tls" && volume.source === `${fixture}/lan-tls` && volume.read_only === true)) {
      fail("Dashboard LAN TLS directory mount changed.");
    }
    const workerEnvironment = worker.environment ?? {};
    const expectedWorkerEnvironment = {
      VOIDSTATION_WORKER_HOST: "0.0.0.0",
      VOIDSTATION_WORKER_PORT: "3001",
      VOIDSTATION_WORKER_TOKEN_FILE: "/run/voidstation-worker/token",
      VOIDSTATION_CONVERSATION_DIR: "/var/lib/voidstation/conversations",
      VOIDSTATION_CREDENTIAL_DIR: "/var/lib/voidstation/credentials",
    };
    if (Object.keys(workerEnvironment).length !== Object.keys(expectedWorkerEnvironment).length ||
        Object.entries(expectedWorkerEnvironment).some(([name, value]) => workerEnvironment[name] !== value)) {
      fail("Assistant-worker effective environment changed.");
    }
    if (worker.ports != null) fail("Assistant-worker effective configuration publishes a host port.");
    if (worker.build?.context !== path.join(root, "worker") || worker.build?.dockerfile !== "Dockerfile") {
      fail("Assistant-worker effective build must use worker/Dockerfile.");
    }
    const targets = (worker.volumes ?? []).map((volume) => volume.target).sort();
    if (JSON.stringify(targets) !== JSON.stringify(["/run/voidstation-worker/token", "/var/lib/voidstation/conversations", "/var/lib/voidstation/credentials"])) {
      fail("Assistant-worker effective mounts changed.");
    }
    for (const service of [dashboard, worker]) {
      if (service.user !== "1000:1000" || service.read_only !== true || JSON.stringify(service.cap_drop) !== JSON.stringify(["ALL"]) ||
          !service.security_opt?.includes("no-new-privileges:true") || !service.tmpfs?.includes("/tmp:size=16m,noexec,nosuid")) {
        fail("Effective service hardening changed.");
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log("Synthetic effective Compose configuration inspection passed.");
}

try {
  main();
} catch (error) {
  console.error(`Effective Compose configuration inspection failed: ${error.message}`);
  process.exitCode = 1;
}
