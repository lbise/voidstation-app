#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectName = "voidstation-app";
const serviceName = "dashboard";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const containerPort = 3000;
const containerPaths = {
  cert: "/run/voidstation-tls/cert.pem",
  key: "/run/voidstation-tls/key.pem",
  authDirectory: "/var/lib/voidstation",
  authDatabase: "/var/lib/voidstation/auth.sqlite",
};

function fail(message) {
  throw new Error(message);
}

function run(command, arguments_, description) {
  try {
    return execFileSync(command, arguments_, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    fail(`${description} failed: ${detail}`);
  }
}

function docker(arguments_, description) {
  return run("docker", arguments_, description);
}

function parseJson(value, description) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`${description} did not return JSON.`);
  }
}

function requireArray(value, description) {
  if (!Array.isArray(value)) fail(`${description} must be an array.`);
  return value;
}

function sameArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function isLocalUnixDockerEndpoint(endpoint) {
  return typeof endpoint === "string" && /^unix:\/\/\/[^/?]+/.test(endpoint);
}

function verifyDockerContext() {
  if (process.env.DOCKER_HOST && !isLocalUnixDockerEndpoint(process.env.DOCKER_HOST)) {
    fail("DOCKER_HOST must use a local unix:/// socket for deployment.");
  }
  const contextName = docker(["context", "show"], "Reading the Docker context").trim();
  if (!contextName) fail("Docker did not report an active context.");
  const endpoint = parseJson(
    docker(["context", "inspect", contextName, "--format", "{{json .Endpoints.docker}}"], "Inspecting the Docker context"),
    "The Docker context inspection",
  );
  if (!isLocalUnixDockerEndpoint(endpoint?.Host)) {
    fail(`Docker context "${contextName}" is not a local unix:/// endpoint.`);
  }
}

function composeConfig() {
  return parseJson(
    docker(["compose", "--project-name", projectName, "config", "--format", "json"], "Resolving compose.yaml"),
    "Resolved Compose configuration",
  );
}

function parseIpv4(address, description) {
  if (typeof address !== "string") fail(`${description} must be an IPv4 address.`);
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))) {
    fail(`${description} must be an IPv4 address.`);
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) fail(`${description} must be an IPv4 address.`);
  return octets;
}

function parsePort(value, description) {
  const text = String(value);
  if (!/^[1-9]\d{0,4}$/.test(text)) fail(`${description} must be a TCP port from 1 through 65535.`);
  const port = Number(text);
  if (port > 65535) fail(`${description} must be a TCP port from 1 through 65535.`);
  return port;
}

function isTailscaleCgnat(octets) {
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function environmentMap(value) {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => {
      if (typeof entry !== "string" || !entry.includes("=")) fail("dashboard.environment entries must use NAME=value.");
      return entry.split(/=(.*)/s, 2);
    });
    return Object.fromEntries(entries);
  }
  if (!value || typeof value !== "object") fail("dashboard.environment must be an object.");
  return value;
}

function validateOrigin(value, endpoint) {
  if (typeof value !== "string") fail("VOIDSTATION_ORIGIN must be configured.");
  let origin;
  try {
    origin = new URL(value);
  } catch {
    fail("VOIDSTATION_ORIGIN must be an HTTPS origin.");
  }
  if (
    origin.protocol !== "https:" || origin.origin !== value || origin.username || origin.password ||
    !origin.hostname.endsWith(".ts.net")
  ) {
    fail("VOIDSTATION_ORIGIN must be a canonical HTTPS origin on a Tailscale .ts.net hostname.");
  }
  const originPort = origin.port ? parsePort(origin.port, "VOIDSTATION_ORIGIN port") : 443;
  if (originPort !== endpoint.port) {
    fail("VOIDSTATION_ORIGIN port must match the published Tailscale port, or omit it only for port 443.");
  }
  return origin.hostname.toLowerCase();
}

function validateServiceShape(configuration, service) {
  const serviceNames = Object.keys(configuration.services ?? {});
  if (serviceNames.length !== 1 || serviceNames[0] !== serviceName) {
    fail("compose.yaml must define exactly one dashboard service.");
  }
  const allowed = new Set(["build", "restart", "user", "ports", "environment", "read_only", "cap_drop", "security_opt", "tmpfs", "volumes", "command", "entrypoint", "networks"]);
  for (const key of Object.keys(service)) {
    if (!allowed.has(key)) fail(`dashboard.${key} is not allowed in this deployment.`);
  }
  const build = service.build;
  if (!build || build.context !== repositoryRoot || (build.dockerfile ?? "Dockerfile") !== "Dockerfile" ||
      Object.keys(build).some((key) => !["context", "dockerfile"].includes(key))) {
    fail("dashboard must build this repository's default Dockerfile without overrides.");
  }
  const networks = configuration.networks;
  const { ipam, ...network } = networks?.default ?? {};
  if (!networks || Object.keys(networks).length !== 1 || (ipam && Object.keys(ipam).length !== 0) ||
      JSON.stringify(network) !== JSON.stringify({
        name: `${projectName}_default`, driver: "bridge",
        driver_opts: { "com.docker.network.bridge.name": "br-voidstation" },
      })) {
    fail("dashboard must use the dedicated default bridge network without overrides.");
  }
  if (service.command != null || service.entrypoint != null) fail("dashboard command and entrypoint must use the image defaults.");
  if (JSON.stringify(service.networks) !== JSON.stringify({ default: null })) {
    fail("dashboard must use only Compose's default bridge network.");
  }
}

function validatePorts(service) {
  const ports = requireArray(service.ports, "dashboard.ports");
  if (ports.length !== 1) fail("dashboard must publish exactly one Tailscale TLS binding.");
  const binding = ports[0];
  if (binding?.target !== containerPort || binding.protocol !== "tcp" || binding.mode !== "ingress") {
    fail("dashboard must publish TCP host traffic to container port 3000.");
  }
  const host = binding.host_ip;
  const octets = parseIpv4(host, "The dashboard bind address");
  if (!isTailscaleCgnat(octets)) {
    fail("dashboard must publish only one 100.64.0.0/10 Tailscale CGNAT binding, never LAN or wildcard traffic.");
  }
  return { host, port: parsePort(binding.published, `Port for ${host}`) };
}

function validateEnvironment(service, endpoint) {
  const environment = environmentMap(service.environment);
  const required = {
    HOSTNAME: "0.0.0.0",
    PORT: "3000",
    VOIDSTATION_TLS_CERT: containerPaths.cert,
    VOIDSTATION_TLS_KEY: containerPaths.key,
    VOIDSTATION_AUTH_DB: containerPaths.authDatabase,
    VOIDSTATION_HOST_PROC: "/host/proc",
    VOIDSTATION_HOST_ROOT_FS: "/host/filesystems/root",
    VOIDSTATION_HOST_DATA_FS: "/host/filesystems/data",
  };
  for (const [name, expected] of Object.entries(required)) {
    if (String(environment[name] ?? "") !== expected) fail(`dashboard.environment.${name} must be ${expected}.`);
  }
  const allowed = new Set([...Object.keys(required), "VOIDSTATION_ORIGIN"]);
  for (const name of Object.keys(environment)) {
    if (!allowed.has(name)) fail(`dashboard.environment.${name} is not allowed.`);
  }
  return validateOrigin(environment.VOIDSTATION_ORIGIN, endpoint);
}

function validateSecurityConfiguration(service) {
  if (service.restart !== "unless-stopped" || service.read_only !== true || String(service.user) !== "1000:1000") {
    fail("dashboard must use restart: unless-stopped, read_only: true, and user: 1000:1000.");
  }
  if (!sameArray(service.cap_drop, ["ALL"])) fail("dashboard must keep cap_drop: [ALL].");
  if (!sameArray(service.security_opt, ["no-new-privileges:true"])) {
    fail("dashboard must keep security_opt: [no-new-privileges:true].");
  }
  if (!sameArray(service.tmpfs, ["/tmp:size=16m,noexec,nosuid"])) {
    fail("dashboard must keep its restricted /tmp tmpfs.");
  }
}

function validateVolume(volume, target, source, readOnly = true) {
  if (
    volume?.type !== "bind" || volume.target !== target || volume.source !== source ||
    volume.read_only !== readOnly || volume.bind?.create_host_path !== false
  ) {
    fail(`The bind mount for ${target} has changed or is unsafe.`);
  }
}

function validateMountConfiguration(service) {
  const volumes = requireArray(service.volumes, "dashboard.volumes");
  if (volumes.length !== 7) fail("dashboard must have five metrics mounts, one auth-data mount, and one TLS mount.");
  const byTarget = new Map();
  for (const volume of volumes) {
    if (byTarget.has(volume?.target)) fail(`dashboard has more than one mount at ${volume.target}.`);
    byTarget.set(volume?.target, volume);
  }
  validateVolume(byTarget.get("/host/proc/stat"), "/host/proc/stat", "/proc/stat");
  validateVolume(byTarget.get("/host/proc/uptime"), "/host/proc/uptime", "/proc/uptime");
  validateVolume(byTarget.get("/host/proc/meminfo"), "/host/proc/meminfo", "/proc/meminfo");
  for (const target of ["/host/filesystems/root", "/host/filesystems/data"]) {
    const volume = byTarget.get(target);
    if (volume?.type !== "bind" || typeof volume.source !== "string" || volume.read_only !== true || volume.bind?.create_host_path !== false) {
      fail(`The bind mount for ${target} has changed or is unsafe.`);
    }
  }
  const auth = byTarget.get(containerPaths.authDirectory);
  if (auth?.type !== "bind" || typeof auth.source !== "string" || auth.read_only === true || auth.bind?.create_host_path !== false) {
    fail("The auth-data bind mount must be writable and must not create its host path.");
  }
  const tls = byTarget.get("/run/voidstation-tls");
  if (tls?.type !== "bind" || typeof tls.source !== "string" || tls.read_only !== true || tls.bind?.create_host_path !== false) {
    fail("The TLS bind mount must be read-only and must not create its host path.");
  }
  return {
    proc: ["/proc/stat", "/proc/uptime", "/proc/meminfo"],
    root: byTarget.get("/host/filesystems/root").source,
    data: byTarget.get("/host/filesystems/data").source,
    auth: auth.source,
    tls: tls.source,
  };
}

function checkedPath(source, description, directory) {
  if (typeof source !== "string" || !path.isAbsolute(source) || source !== path.resolve(source)) {
    fail(`${description} must be a normalized absolute path.`);
  }
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch (error) {
    fail(`${description} is absent or cannot be inspected: ${error.message}`);
  }
  if (stat.isSymbolicLink()) fail(`${description} must not be a symbolic link.`);
  let realPath;
  try {
    realPath = fs.realpathSync.native(source);
  } catch (error) {
    fail(`${description} cannot be resolved: ${error.message}`);
  }
  if (realPath !== source) fail(`${description} must not contain a symbolic-link path component.`);
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail(`${description} must be a ${directory ? "directory" : "regular file"}.`);
  return stat;
}

function requireAccess(source, description, mode) {
  try {
    fs.accessSync(source, mode);
  } catch (error) {
    fail(`${description} has insufficient permissions: ${error.message}`);
  }
}

function requireEmptyDirectory(source, description) {
  try {
    if (fs.readdirSync(source).length !== 0) fail(`${description} must be empty.`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("must be empty.")) throw error;
    fail(`${description} cannot be read: ${error.message}`);
  }
}

function findMount(pathname) {
  const filesystem = parseJson(
    run("findmnt", ["--json", "--target", pathname, "--output", "TARGET,UUID"], `Inspecting the filesystem containing ${pathname}`),
    `findmnt output for ${pathname}`,
  ).filesystems?.[0];
  if (!filesystem?.target) fail(`findmnt did not find the filesystem containing ${pathname}.`);
  return filesystem;
}

function validateFilesystemProbes(probes, expectedDataUuid) {
  for (const procFile of probes.proc) {
    checkedPath(procFile, `Proc file ${procFile}`, false);
    requireAccess(procFile, `Proc file ${procFile}`, fs.constants.R_OK);
  }
  const rootStat = checkedPath(probes.root, "Root filesystem probe", true);
  const dataStat = checkedPath(probes.data, "Data filesystem probe", true);
  requireAccess(probes.root, "Root filesystem probe", fs.constants.R_OK | fs.constants.X_OK);
  requireAccess(probes.data, "Data filesystem probe", fs.constants.R_OK | fs.constants.X_OK);
  requireEmptyDirectory(probes.root, "Root filesystem probe");
  requireEmptyDirectory(probes.data, "Data filesystem probe");
  if (rootStat.dev !== fs.statSync("/").dev) fail("Root filesystem probe is not on the filesystem mounted at /.");
  if (dataStat.dev === fs.statSync("/").dev) fail("Data filesystem probe must be on a filesystem different from /.");
  const rootMount = findMount(probes.root);
  const dataMount = findMount(probes.data);
  if (rootMount.target === probes.root || dataMount.target === probes.data) fail("Filesystem probe directories must not be entire filesystem mounts.");
  if (typeof dataMount.uuid !== "string" || dataMount.uuid.toLowerCase() !== expectedDataUuid.toLowerCase()) {
    fail(`Data filesystem UUID does not match the configured expected UUID (${expectedDataUuid}).`);
  }
}

function validateAuthDirectory(source) {
  const stat = checkedPath(source, "Auth-data directory", true);
  requireAccess(source, "Auth-data directory", fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  if (stat.uid !== 1000 || stat.gid !== 1000 || (stat.mode & 0o777) !== 0o700) {
    fail("Auth-data directory must be owned by UID/GID 1000 with mode 0700.");
  }
  const databasePath = path.join(source, "auth.sqlite");
  if (!fs.existsSync(databasePath)) return;
  const database = checkedPath(databasePath, "Auth database", false);
  if (database.uid !== 1000 || database.gid !== 1000 || (database.mode & 0o777) !== 0o600) {
    fail("Auth database must be owned by UID/GID 1000 with mode 0600.");
  }
}

function validateCertificate(tlsDirectory, hostname) {
  const directory = checkedPath(tlsDirectory, "TLS directory", true);
  requireAccess(tlsDirectory, "TLS directory", fs.constants.R_OK | fs.constants.X_OK);
  if ((directory.mode & 0o022) !== 0) fail("TLS directory must not be writable by its group or others.");
  const certificatePath = path.join(tlsDirectory, "cert.pem");
  const keyPath = path.join(tlsDirectory, "key.pem");
  checkedPath(certificatePath, "TLS certificate", false);
  const key = checkedPath(keyPath, "TLS private key", false);
  requireAccess(certificatePath, "TLS certificate", fs.constants.R_OK);
  requireAccess(keyPath, "TLS private key", fs.constants.R_OK);
  if (key.uid !== 1000 || key.gid !== 1000 || (key.mode & 0o777) !== 0o600) {
    fail("TLS private key must be owned by UID/GID 1000 with mode 0600.");
  }
  const san = run("openssl", ["x509", "-in", certificatePath, "-noout", "-ext", "subjectAltName"], "Reading TLS certificate SANs");
  const names = [...san.matchAll(/DNS:([^,\s]+)/gi)].map((match) => match[1].toLowerCase().replace(/\.$/, ""));
  if (!names.includes(hostname)) fail(`TLS certificate SAN does not contain ${hostname}.`);
  run("openssl", ["x509", "-in", certificatePath, "-noout", "-checkend", "0"], "Checking TLS certificate expiry");
  const certificatePublicKey = run("openssl", ["x509", "-in", certificatePath, "-noout", "-pubkey"], "Reading TLS certificate public key").trim();
  const privateKeyPublicKey = run("openssl", ["pkey", "-in", keyPath, "-pubout"], "Reading TLS private key public key").trim();
  if (!certificatePublicKey || certificatePublicKey !== privateKeyPublicKey) fail("TLS certificate and private key do not match.");
}

function tailscaleStatus(endpoint, hostname) {
  const status = parseJson(run("tailscale", ["status", "--json"], "Reading Tailscale status"), "Tailscale status");
  const self = status?.Self;
  const addresses = requireArray(self?.TailscaleIPs, "Tailscale Self.TailscaleIPs");
  if (!addresses.includes(endpoint.host)) fail(`${endpoint.host} is not assigned to this server by Tailscale.`);
  const dnsName = typeof self?.DNSName === "string" ? self.DNSName.toLowerCase().replace(/\.$/, "") : "";
  if (dnsName !== hostname) fail("VOIDSTATION_ORIGIN hostname does not match this server's Tailscale DNS name.");
  const serve = parseJson(run("tailscale", ["serve", "status", "--json"], "Reading Tailscale Serve status"), "Tailscale Serve status");
  if (containsEnabledFunnel(serve)) fail("Tailscale Funnel is enabled. Disable it before deployment.");
}

function containsEnabledFunnel(value, underFunnel = false) {
  if (Array.isArray(value)) return value.some((item) => containsEnabledFunnel(item, underFunnel));
  if (!value || typeof value !== "object") return underFunnel && value !== false && value !== null && value !== "" && value !== 0;
  return Object.entries(value).some(([key, nested]) => containsEnabledFunnel(nested, underFunnel || /funnel/i.test(key)));
}

function runAsRoot(command, arguments_, description) {
  return process.getuid() === 0 ? run(command, arguments_, description)
    : run("sudo", ["-n", command, ...arguments_], description);
}

function validateIngress() {
  const rules = (chain) => runAsRoot("iptables", ["-S", chain], "Reading Docker ingress rules")
    .split("\n").filter((line) => line.startsWith("-A "));
  const rule = "-A DOCKER-USER ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP";
  if (rules("FORWARD")[0] !== "-A FORWARD -j DOCKER-USER" || rules("DOCKER-USER")[0] !== rule) {
    fail("Docker ingress rule must reject non-Tailscale ingress to br-voidstation before any accept rules. See docs/deployment.md.");
  }
}

function validateHostSupport(tlsDirectory, hostname) {
  const properties = (unit, names) => Object.fromEntries(
    run("systemctl", ["show", unit, `--property=${names.join(",")}`], `Inspecting ${unit}`)
      .trim().split("\n").map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const ingress = properties("voidstation-ingress.service", ["ActiveState", "UnitFileState", "Before", "PartOf", "ExecStart"]);
  const requires = run("systemctl", ["show", "docker.service", "--property=Requires", "--value"], "Inspecting Docker startup dependencies").trim().split(/\s+/);
  if (ingress.ActiveState !== "active" || ingress.UnitFileState !== "enabled" ||
      !ingress.Before?.split(/\s+/).includes("docker.service") ||
      !ingress.PartOf?.split(/\s+/).includes("docker.service") ||
      !ingress.ExecStart?.includes("path=/usr/local/libexec/voidstation-ingress ;") ||
      !requires.includes("voidstation-ingress.service")) {
    fail("Voidstation needs active persistent ingress protection required before Docker startup. See docs/deployment.md.");
  }
  const renewal = properties("voidstation-certificate-renewal.timer", ["ActiveState", "UnitFileState", "Unit"]);
  if (renewal.ActiveState !== "active" || renewal.UnitFileState !== "enabled" || renewal.Unit !== "voidstation-certificate-renewal.service") {
    fail("Voidstation certificate renewal timer must be enabled and active.");
  }
  const renewalService = properties("voidstation-certificate-renewal.service", ["Environment", "ExecStart"]);
  const renewalEnvironment = renewalService.Environment?.split(/\s+/) ?? [];
  if (!renewalEnvironment.includes(`VOIDSTATION_TLS_DIRECTORY=${tlsDirectory}`) ||
      !renewalEnvironment.includes("VOIDSTATION_HOSTNAME_FILE=/etc/voidstation/hostname") ||
      !renewalService.ExecStart?.includes("path=/usr/local/libexec/voidstation-renew-certificate ;") ||
      runAsRoot("cat", ["/etc/voidstation/hostname"], "Checking certificate renewal hostname").trim() !== hostname) {
    fail("Voidstation renewal configuration must match the deployed TLS directory and hostname.");
  }
}

function validateRuntimeAccess(probes) {
  const inputs = [
    ...probes.proc.map((source) => [source, fs.constants.R_OK]),
    ...[probes.root, probes.data, probes.tls].map((source) => [source, fs.constants.R_OK | fs.constants.X_OK]),
    [probes.auth, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK],
    [path.join(probes.tls, "cert.pem"), fs.constants.R_OK],
    [path.join(probes.tls, "key.pem"), fs.constants.R_OK],
  ];
  // Check real permissions and ACLs with the container's identity, not root's.
  runAsRoot("setpriv", ["--reuid=1000", "--regid=1000", "--clear-groups", process.execPath,
    "-e", "for (const [path, mode] of JSON.parse(process.argv[1])) require('node:fs').accessSync(path, mode)", JSON.stringify(inputs)],
  "Checking mounted inputs as UID/GID 1000");
}

function runningContainers() {
  const ids = docker(["ps", "--quiet"], "Listing running Docker containers").trim().split("\n").filter(Boolean);
  if (ids.length === 0) return [];
  return parseJson(docker(["inspect", ...ids], "Inspecting running Docker containers"), "Docker container inspection");
}

function ownBinding(container, binding, endpoint) {
  const labels = container?.Config?.Labels ?? {};
  return labels["com.docker.compose.project"] === projectName && labels["com.docker.compose.service"] === serviceName &&
    binding.HostIp === endpoint.host && String(binding.HostPort) === String(endpoint.port);
}

function overlaps(binding, endpoint) {
  return String(binding.HostPort) === String(endpoint.port) &&
    (binding.HostIp === endpoint.host || binding.HostIp === "0.0.0.0" || binding.HostIp === "::" || binding.HostIp === "");
}

function inspectPortConflicts(endpoint) {
  let own = false;
  for (const container of runningContainers()) {
    for (const bindings of Object.values(container?.NetworkSettings?.Ports ?? {})) {
      if (!Array.isArray(bindings)) continue;
      for (const binding of bindings) {
        if (!overlaps(binding, endpoint)) continue;
        if (ownBinding(container, binding, endpoint)) {
          own = true;
          continue;
        }
        const name = container.Name?.replace(/^\//, "") || container.Id;
        fail(`TCP ${endpoint.host}:${endpoint.port} is already published by unrelated container ${name}.`);
      }
    }
  }
  return own;
}

function inspectNativeListeners(endpoint, ownDashboardBinding) {
  const output = run("ss", ["--listening", "--tcp", "--numeric", "--no-header"], "Listing native TCP listeners");
  if (ownDashboardBinding) return;
  const port = String(endpoint.port);
  for (const line of output.split("\n")) {
    const address = line.trim().split(/\s+/)[3];
    if (address === `${endpoint.host}:${port}` || address === `0.0.0.0:${port}` || address === `[::]:${port}` || address === `*:${port}`) {
      fail(`TCP ${endpoint.host}:${endpoint.port} is already in use by a native listener.`);
    }
  }
}

async function postDeployInspection(endpoint, probes, origin) {
  const id = docker(["compose", "--project-name", projectName, "ps", "--quiet", serviceName], "Finding the deployed dashboard").trim();
  if (!id) fail("The dashboard container is not running after deployment.");
  const container = parseJson(docker(["inspect", id], "Inspecting the deployed dashboard"), "Dashboard inspection")[0];
  if (!container) fail("Docker did not return the deployed dashboard inspection.");
  if (container.Config?.User !== "1000:1000" || container.HostConfig?.ReadonlyRootfs !== true) {
    fail("The deployed dashboard is not running as UID/GID 1000 with a read-only root filesystem.");
  }
  if (!sameArray(container.HostConfig?.CapDrop, ["ALL"]) || !requireArray(container.HostConfig?.SecurityOpt, "Dashboard security options").includes("no-new-privileges:true")) {
    fail("The deployed dashboard security settings changed.");
  }
  const ports = container.NetworkSettings?.Ports?.["3000/tcp"];
  if (!Array.isArray(ports) || ports.length !== 1 || ports[0].HostIp !== endpoint.host || String(ports[0].HostPort) !== String(endpoint.port)) {
    fail("The deployed dashboard does not have exactly the configured Tailscale TLS publication.");
  }
  const otherPorts = Object.entries(container.NetworkSettings?.Ports ?? {}).filter(([name, bindings]) => name !== "3000/tcp" && bindings !== null);
  if (otherPorts.length) fail("The deployed dashboard has an extra publication.");
  const expectedMounts = new Map([
    ["/host/proc/stat", "/proc/stat"], ["/host/proc/uptime", "/proc/uptime"], ["/host/proc/meminfo", "/proc/meminfo"],
    ["/host/filesystems/root", probes.root], ["/host/filesystems/data", probes.data], [containerPaths.authDirectory, probes.auth], ["/run/voidstation-tls", probes.tls],
  ]);
  const mounts = requireArray(container.Mounts, "Dashboard mounts");
  if (mounts.length !== expectedMounts.size) fail("The deployed dashboard mount count changed.");
  for (const [destination, source] of expectedMounts) {
    const mount = mounts.find((candidate) => candidate.Destination === destination);
    if (!mount || mount.Type !== "bind" || mount.Source !== source || (destination !== containerPaths.authDirectory && mount.RW !== false) || (destination === containerPaths.authDirectory && mount.RW !== true)) {
      fail(`The deployed dashboard mount at ${destination} changed or is unsafe.`);
    }
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = parseJson(docker(["inspect", id], "Checking dashboard readiness"), "Dashboard inspection")[0];
    if (current?.State?.Running && !current?.State?.Restarting) {
      try {
        await new Promise((resolve, reject) => {
          const request = httpsRequest(new URL("/login", origin), {
            lookup: (_hostname, options, callback) => options.all
              ? callback(null, [{ address: endpoint.host, family: 4 }])
              : callback(null, endpoint.host, 4),
            agent: false,
          }, (response) => {
            let body = "";
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => response.statusCode === 200 && body.includes("Sign in")
              ? resolve() : reject(new Error("Login is not ready")));
            response.on("error", reject);
          });
          request.on("error", reject);
          request.setTimeout(3000, () => request.destroy(new Error("HTTPS readiness timed out")));
          request.end();
        });
        return;
      } catch { /* Wait for the TLS listener and login route, with normal certificate verification. */ }
    }
    await delay(500);
  }
  fail("Dashboard did not become ready with a certificate-verified HTTPS login response within 30 seconds.");
}

async function main() {
  const postDeploy = process.argv.length === 3 && process.argv[2] === "--postdeploy";
  if (!postDeploy && process.argv.length !== 2) fail("Usage: deployment-preflight.mjs [--postdeploy]");
  verifyDockerContext();
  const configuration = composeConfig();
  if (configuration.name !== projectName) fail(`compose.yaml must use project name ${projectName}.`);
  const service = configuration.services?.[serviceName];
  if (!service) fail("compose.yaml must define the dashboard service.");
  validateServiceShape(configuration, service);
  const expectedDataUuid = configuration["x-voidstation"]?.expected_data_filesystem_uuid;
  if (typeof expectedDataUuid !== "string" || expectedDataUuid.trim() !== expectedDataUuid || !expectedDataUuid) {
    fail("x-voidstation.expected_data_filesystem_uuid must be configured.");
  }
  const endpoint = validatePorts(service);
  const hostname = validateEnvironment(service, endpoint);
  validateSecurityConfiguration(service);
  const probes = validateMountConfiguration(service);
  validateFilesystemProbes(probes, expectedDataUuid);
  validateAuthDirectory(probes.auth);
  validateCertificate(probes.tls, hostname);
  validateRuntimeAccess(probes);
  tailscaleStatus(endpoint, hostname);
  validateIngress();
  validateHostSupport(probes.tls, hostname);
  const ownDashboardBinding = inspectPortConflicts(endpoint);
  inspectNativeListeners(endpoint, ownDashboardBinding);
  if (postDeploy) await postDeployInspection(endpoint, probes, environmentMap(service.environment).VOIDSTATION_ORIGIN);
  console.log(postDeploy ? "Deployment post-deploy inspection passed." : "Deployment preflight passed.");
}

main().catch((error) => {
  console.error(`Deployment preflight failed: ${error.message}`);
  process.exitCode = 1;
});
