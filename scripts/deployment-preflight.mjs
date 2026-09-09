#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectName = "voidstation-app";
const serviceName = "dashboard";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function runDocker(arguments_, description) {
  try {
    return execFileSync("docker", arguments_, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error.stderr?.toString().trim();
    const detail = stderr || error.message;
    fail(`${description} failed: ${detail}`);
  }
}

function parseJson(value, description) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`${description} did not return JSON.`);
  }
}

function isLocalUnixDockerEndpoint(endpoint) {
  return typeof endpoint === "string" && /^unix:\/\/\/[^/?]+/.test(endpoint);
}

function verifyDockerContext() {
  if (process.env.DOCKER_HOST && !isLocalUnixDockerEndpoint(process.env.DOCKER_HOST)) {
    fail("DOCKER_HOST must use a local unix:/// socket for deployment.");
  }

  const contextName = runDocker(["context", "show"], "Reading the Docker context").trim();
  if (!contextName) {
    fail("Docker did not report an active context.");
  }

  const endpoint = parseJson(
    runDocker(
      ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker}}"],
      "Inspecting the Docker context",
    ),
    "The Docker context inspection",
  );

  if (!isLocalUnixDockerEndpoint(endpoint?.Host)) {
    fail(`Docker context "${contextName}" is not a local unix:/// endpoint.`);
  }
}

function composeConfig() {
  return parseJson(
    runDocker(
      ["compose", "--project-name", projectName, "config", "--format", "json"],
      "Resolving compose.yaml",
    ),
    "Resolved Compose configuration",
  );
}

function requireArray(value, description) {
  if (!Array.isArray(value)) {
    fail(`${description} must be an array.`);
  }
  return value;
}

function sameArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function parseIpv4(address, description) {
  if (typeof address !== "string") {
    fail(`${description} must be an IPv4 address.`);
  }

  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))) {
    fail(`${description} must be an IPv4 address.`);
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    fail(`${description} must be an IPv4 address.`);
  }
  return octets;
}

function parsePort(value, description) {
  const text = String(value);
  if (!/^[1-9]\d{0,4}$/.test(text)) {
    fail(`${description} must be a TCP port from 1 through 65535.`);
  }
  const port = Number(text);
  if (port > 65535) {
    fail(`${description} must be a TCP port from 1 through 65535.`);
  }
  return port;
}

function isRfc1918(octets) {
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function isTailscaleCgnat(octets) {
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function validatePorts(service) {
  const ports = requireArray(service.ports, "dashboard.ports");
  if (ports.length !== 2) {
    fail("dashboard must publish exactly the LAN and Tailscale TCP bindings.");
  }

  const bindings = [];
  for (const port of ports) {
    if (port?.target !== 3000 || port.protocol !== "tcp" || port.mode !== "ingress") {
      fail("Each dashboard port must publish TCP host traffic to container port 3000.");
    }

    const host = port.host_ip;
    const octets = parseIpv4(host, "A dashboard bind address");
    bindings.push({ host, port: parsePort(port.published, `Port for ${host}`), octets });
  }

  const lanBindings = bindings.filter((binding) => isRfc1918(binding.octets));
  const tailscaleBindings = bindings.filter((binding) => isTailscaleCgnat(binding.octets));
  if (lanBindings.length !== 1 || tailscaleBindings.length !== 1) {
    fail("dashboard must have one RFC1918 LAN binding and one 100.64.0.0/10 Tailscale binding.");
  }
  if (lanBindings[0].host === tailscaleBindings[0].host) {
    fail("The LAN and Tailscale bind addresses must differ.");
  }

  const localAddresses = new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4")
      .map((entry) => entry.address),
  );
  for (const binding of bindings) {
    if (!localAddresses.has(binding.host)) {
      const available = [...localAddresses].sort().join(", ") || "none";
      fail(`${binding.host} is not assigned to this server. Available IPv4 addresses: ${available}.`);
    }
  }

  return bindings;
}

function validateVolume(volume, target, source) {
  if (
    volume?.type !== "bind" ||
    volume.target !== target ||
    volume.source !== source ||
    volume.read_only !== true ||
    volume.bind?.create_host_path !== false
  ) {
    fail(`The bind mount for ${target} must be read-only and must not create host paths.`);
  }
}

function validateMountConfiguration(service) {
  const volumes = requireArray(service.volumes, "dashboard.volumes");
  if (volumes.length !== 5) {
    fail("dashboard must have exactly three proc-file mounts and two filesystem probe mounts.");
  }

  const byTarget = new Map();
  for (const volume of volumes) {
    if (byTarget.has(volume?.target)) {
      fail(`dashboard has more than one mount at ${volume.target}.`);
    }
    byTarget.set(volume?.target, volume);
  }

  validateVolume(byTarget.get("/host/proc/stat"), "/host/proc/stat", "/proc/stat");
  validateVolume(byTarget.get("/host/proc/uptime"), "/host/proc/uptime", "/proc/uptime");
  validateVolume(byTarget.get("/host/proc/meminfo"), "/host/proc/meminfo", "/proc/meminfo");

  const root = byTarget.get("/host/filesystems/root");
  const data = byTarget.get("/host/filesystems/data");
  for (const [name, volume] of [["root", root], ["data", data]]) {
    if (
      volume?.type !== "bind" ||
      typeof volume.source !== "string" ||
      volume.read_only !== true ||
      volume.bind?.create_host_path !== false
    ) {
      fail(`The ${name} filesystem probe mount must be read-only and must not create its host path.`);
    }
  }

  return { root: root.source, data: data.source, proc: ["/proc/stat", "/proc/uptime", "/proc/meminfo"] };
}

function validateSecurityConfiguration(service) {
  if (service.restart !== "unless-stopped" || service.read_only !== true) {
    fail("dashboard must keep restart: unless-stopped and read_only: true.");
  }
  if (!sameArray(service.cap_drop, ["ALL"])) {
    fail("dashboard must keep cap_drop: [ALL].");
  }
  if (!sameArray(service.security_opt, ["no-new-privileges:true"])) {
    fail("dashboard must keep security_opt: [no-new-privileges:true].");
  }
  if (!sameArray(service.tmpfs, ["/tmp:size=16m,noexec,nosuid"])) {
    fail("dashboard must keep its restricted /tmp tmpfs.");
  }
}

function checkedPath(source, description, directory) {
  if (!path.isAbsolute(source) || source !== path.resolve(source)) {
    fail(`${description} must be a normalized absolute path.`);
  }

  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch (error) {
    fail(`${description} is absent or cannot be inspected: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    fail(`${description} must not be a symbolic link.`);
  }

  let realPath;
  try {
    realPath = fs.realpathSync.native(source);
  } catch (error) {
    fail(`${description} cannot be resolved: ${error.message}`);
  }
  if (realPath !== source) {
    fail(`${description} must not contain a symbolic-link path component.`);
  }

  try {
    fs.accessSync(source, directory ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK);
  } catch (error) {
    fail(`${description} is not readable${directory ? " and searchable" : ""}: ${error.message}`);
  }

  if (directory && !stat.isDirectory()) {
    fail(`${description} must be a directory.`);
  }
  if (!directory && !stat.isFile()) {
    fail(`${description} must be a regular file.`);
  }
  return stat;
}

function findMount(pathname) {
  let output;
  try {
    output = execFileSync("findmnt", ["--json", "--target", pathname, "--output", "TARGET,UUID"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    fail(`findmnt could not inspect ${pathname}: ${detail}`);
  }
  const filesystem = parseJson(output, `findmnt output for ${pathname}`).filesystems?.[0];
  if (!filesystem?.target) {
    fail(`findmnt did not find the filesystem containing ${pathname}.`);
  }
  return filesystem;
}

function requireEmptyDirectory(pathname, description) {
  let entries;
  try {
    entries = fs.readdirSync(pathname);
  } catch (error) {
    fail(`${description} cannot be read: ${error.message}`);
  }
  if (entries.length !== 0) {
    fail(`${description} must be empty.`);
  }
}

function validateFilesystemProbes(probes, expectedDataUuid) {
  for (const procFile of probes.proc) {
    checkedPath(procFile, `Proc file ${procFile}`, false);
  }

  const rootStat = checkedPath(probes.root, "Root filesystem probe", true);
  const dataStat = checkedPath(probes.data, "Data filesystem probe", true);
  requireEmptyDirectory(probes.root, "Root filesystem probe");
  requireEmptyDirectory(probes.data, "Data filesystem probe");

  const rootDevice = fs.statSync("/").dev;
  if (rootStat.dev !== rootDevice) {
    fail("Root filesystem probe is not on the filesystem mounted at /.");
  }
  if (dataStat.dev === rootDevice) {
    fail("Data filesystem probe must be on a filesystem different from /.");
  }

  const rootMount = findMount(probes.root);
  const dataMount = findMount(probes.data);
  if (rootMount.target === probes.root || dataMount.target === probes.data) {
    fail("Filesystem probe directories must not be entire filesystem mounts.");
  }
  if (typeof dataMount.uuid !== "string" || dataMount.uuid.toLowerCase() !== expectedDataUuid.toLowerCase()) {
    fail(`Data filesystem UUID does not match the configured expected UUID (${expectedDataUuid}).`);
  }
}

function isSameServiceBinding(container, containerPort, binding, endpoint) {
  const labels = container?.Config?.Labels ?? {};
  return containerPort === "3000/tcp" &&
    labels["com.docker.compose.project"] === projectName &&
    labels["com.docker.compose.service"] === serviceName &&
    binding.HostIp === endpoint.host &&
    String(binding.HostPort) === String(endpoint.port);
}

function bindingsOverlap(binding, endpoint) {
  return String(binding.HostPort) === String(endpoint.port) &&
    (binding.HostIp === endpoint.host || binding.HostIp === "0.0.0.0" || binding.HostIp === "::" || binding.HostIp === "");
}

function runningContainers() {
  const ids = runDocker(["ps", "--quiet"], "Listing running Docker containers")
    .trim()
    .split("\n")
    .filter(Boolean);
  if (ids.length === 0) {
    return [];
  }
  return parseJson(runDocker(["inspect", ...ids], "Inspecting running Docker containers"), "Docker container inspection");
}

function inspectDockerPortConflicts(endpoints) {
  const occupiedByThisService = new Set();
  for (const container of runningContainers()) {
    for (const [containerPort, bindings] of Object.entries(container?.NetworkSettings?.Ports ?? {})) {
      if (!/^\d+\/tcp$/.test(containerPort) || !Array.isArray(bindings)) {
        continue;
      }
      for (const binding of bindings) {
        for (const endpoint of endpoints) {
          if (!bindingsOverlap(binding, endpoint)) {
            continue;
          }
          if (isSameServiceBinding(container, containerPort, binding, endpoint)) {
            occupiedByThisService.add(`${endpoint.host}:${endpoint.port}`);
            continue;
          }
          const name = container.Name?.replace(/^\//, "") || container.Id;
          fail(`TCP ${endpoint.host}:${endpoint.port} is already published by unrelated container ${name}.`);
        }
      }
    }
  }
  return occupiedByThisService;
}

function nativeListeners() {
  let output;
  try {
    output = execFileSync("ss", ["--listening", "--tcp", "--numeric", "--no-header"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    fail(`Listing native TCP listeners failed: ${detail}`);
  }
  return output.split("\\n").map((line) => line.trim().split(/\\s+/)[3]).filter(Boolean);
}

async function probeFreePorts(endpoints, occupiedByThisService) {
  const listeners = nativeListeners();
  for (const endpoint of endpoints) {
    if (occupiedByThisService.has(`${endpoint.host}:${endpoint.port}`)) {
      continue;
    }

    const port = String(endpoint.port);
    const listenerOwnsEndpoint = listeners.some((address) => {
      const wildcard = address === `0.0.0.0:${port}` || address === `*:${port}` || address === `[::]:${port}`;
      return wildcard || address === `${endpoint.host}:${port}`;
    });
    if (listenerOwnsEndpoint) {
      fail(`TCP ${endpoint.host}:${endpoint.port} is already in use by a native listener.`);
    }

    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: endpoint.host, port: endpoint.port, exclusive: true }, () => {
          server.close((error) => error ? reject(error) : resolve());
        });
      });
    } catch (error) {
      if (error?.code === "EADDRINUSE") {
        fail(`TCP ${endpoint.host}:${endpoint.port} is already in use by a native listener.`);
      }
      fail(`Could not bind a TCP probe at ${endpoint.host}:${endpoint.port}: ${error.message}`);
    }
  }
}

async function main() {
  if (process.argv.length !== 2) {
    fail("This preflight accepts no arguments.");
  }

  verifyDockerContext();
  const configuration = composeConfig();
  if (configuration.name !== projectName) {
    fail(`compose.yaml must use project name ${projectName}.`);
  }

  const service = configuration.services?.[serviceName];
  if (!service) {
    fail("compose.yaml must define the dashboard service.");
  }
  const expectedDataUuid = configuration["x-voidstation"]?.expected_data_filesystem_uuid;
  if (typeof expectedDataUuid !== "string" || expectedDataUuid.trim() !== expectedDataUuid || expectedDataUuid.length === 0) {
    fail("x-voidstation.expected_data_filesystem_uuid must be configured.");
  }

  const endpoints = validatePorts(service);
  validateSecurityConfiguration(service);
  const probes = validateMountConfiguration(service);
  validateFilesystemProbes(probes, expectedDataUuid);
  const occupiedByThisService = inspectDockerPortConflicts(endpoints);
  await probeFreePorts(endpoints, occupiedByThisService);
  console.log("Deployment preflight passed.");
}

main().catch((error) => {
  console.error(`Deployment preflight failed: ${error.message}`);
  process.exitCode = 1;
});
