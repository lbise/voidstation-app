#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectName = "voidstation-app";
const dashboardServiceName = "dashboard";
const workerServiceName = "assistant-worker";
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const dashboardPort = 3000;
const lanDashboardPort = 3443;
const workerPort = 3001;
const containerPaths = {
  cert: "/run/voidstation-tls/cert.pem",
  key: "/run/voidstation-tls/key.pem",
  lanCert: "/run/voidstation-lan-tls/cert.pem",
  lanKey: "/run/voidstation-lan-tls/key.pem",
  lanCa: "/run/voidstation-lan-tls/ca.pem",
  authDirectory: "/var/lib/voidstation",
  authDatabase: "/var/lib/voidstation/auth.sqlite",
  workerToken: "/run/voidstation-worker/token",
  conversationDirectory: "/var/lib/voidstation/conversations",
  credentialDirectory: "/var/lib/voidstation/credentials",
  mediaDirectory: "/run/voidstation-media",
  mediaConfig: "/run/voidstation-media/config.json",
  mediaKeys: {
    radarr: "/run/voidstation-media/radarr.key",
    sonarr: "/run/voidstation-media/sonarr.key",
  },
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
    fail(
      `${description} failed: ${error.stderr?.toString().trim() || error.message}`,
    );
  }
}
function docker(arguments_, description) {
  return run("docker", arguments_, description);
}
function runAsRoot(command, arguments_, description) {
  return process.getuid() === 0
    ? run(command, arguments_, description)
    : run("sudo", ["-n", command, ...arguments_], description);
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
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}
function isLocalUnixDockerEndpoint(endpoint) {
  return typeof endpoint === "string" && /^unix:\/\/\/[^/?]+/.test(endpoint);
}
function parsePort(value, description) {
  const text = String(value);
  if (!/^[1-9]\d{0,4}$/.test(text) || Number(text) > 65535)
    fail(`${description} must be a TCP port from 1 through 65535.`);
  return Number(text);
}
function parseIpv4(address, description) {
  if (typeof address !== "string")
    fail(`${description} must be an IPv4 address.`);
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))
  )
    fail(`${description} must be an IPv4 address.`);
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255))
    fail(`${description} must be an IPv4 address.`);
  return octets;
}
function ipv4Number(address, description) {
  return parseIpv4(address, description).reduce(
    (value, octet) => value * 256 + octet,
    0,
  );
}
function numberIpv4(value) {
  return [24, 16, 8, 0]
    .map((shift) => Math.floor(value / 2 ** shift) % 256)
    .join(".");
}
function isTailscaleCgnat(address) {
  const octets = parseIpv4(address, "The dashboard bind address");
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}
function isRfc1918(address) {
  const [first, second] = parseIpv4(address, "The LAN bind address");
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}
function parsePrivateCidr(value, description) {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+\.\d+\/(?:[0-9]|[12]\d|3[0-2])$/.test(value)
  )
    fail(`${description} must be a canonical RFC1918 IPv4 CIDR.`);
  const [address, prefixText] = value.split("/");
  const prefix = Number(prefixText);
  const number = ipv4Number(address, description);
  const size = 2 ** (32 - prefix);
  const network = Math.floor(number / size) * size;
  const broadcast = numberIpv4(network + size - 1);
  if (number !== network || !isRfc1918(address) || !isRfc1918(broadcast))
    fail(`${description} must be a canonical RFC1918 IPv4 CIDR.`);
  return { value, network, prefix, size };
}
function cidrContains(cidr, address) {
  const number = ipv4Number(address, "The LAN bind address");
  return number >= cidr.network && number < cidr.network + cidr.size;
}
function environmentMap(value) {
  if (Array.isArray(value))
    return Object.fromEntries(
      value.map((entry) => {
        if (typeof entry !== "string" || !entry.includes("="))
          fail("dashboard.environment entries must use NAME=value.");
        return entry.split(/=(.*)/s, 2);
      }),
    );
  if (!value || typeof value !== "object")
    fail("dashboard.environment must be an object.");
  return value;
}
function verifyDockerContext() {
  if (
    process.env.DOCKER_HOST &&
    !isLocalUnixDockerEndpoint(process.env.DOCKER_HOST)
  )
    fail("DOCKER_HOST must use a local unix:/// socket for deployment.");
  const contextName = docker(
    ["context", "show"],
    "Reading the Docker context",
  ).trim();
  const endpoint = parseJson(
    docker(
      [
        "context",
        "inspect",
        contextName,
        "--format",
        "{{json .Endpoints.docker}}",
      ],
      "Inspecting the Docker context",
    ),
    "The Docker context inspection",
  );
  if (!contextName || !isLocalUnixDockerEndpoint(endpoint?.Host))
    fail(`Docker context "${contextName}" is not a local unix:/// endpoint.`);
}
function composeConfig() {
  return parseJson(
    docker(
      ["compose", "--project-name", projectName, "config", "--format", "json"],
      "Resolving compose.yaml",
    ),
    "Resolved Compose configuration",
  );
}
function validateOrigin(value, description, hostname, port) {
  if (typeof value !== "string") fail(`${description} must be configured.`);
  let origin;
  try {
    origin = new URL(value);
  } catch {
    fail(`${description} must be a canonical HTTPS origin.`);
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== value ||
    origin.username ||
    origin.password ||
    origin.hostname.toLowerCase() !== hostname.toLowerCase()
  ) {
    fail(
      `${description} must be a canonical HTTPS origin for its configured endpoint.`,
    );
  }
  const originPort = origin.port
    ? parsePort(origin.port, `${description} port`)
    : 443;
  if (originPort !== port)
    fail(
      `${description} port must match its published port, or omit it only for port 443.`,
    );
}
function validateServiceShape(configuration, dashboard, worker) {
  if (
    JSON.stringify(Object.keys(configuration.services ?? {}).sort()) !==
    JSON.stringify([dashboardServiceName, workerServiceName].sort())
  )
    fail(
      "compose.yaml must define exactly dashboard and assistant-worker services.",
    );
  const allowed = new Set([
    "build",
    "restart",
    "user",
    "ports",
    "environment",
    "read_only",
    "cap_drop",
    "security_opt",
    "tmpfs",
    "volumes",
    "command",
    "entrypoint",
    "networks",
  ]);
  for (const [name, service] of [
    [dashboardServiceName, dashboard],
    [workerServiceName, worker],
  ]) {
    for (const key of Object.keys(service))
      if (!allowed.has(key))
        fail(`${name}.${key} is not allowed in this deployment.`);
    if (service.command != null || service.entrypoint != null)
      fail(`${name} command and entrypoint must use the image defaults.`);
    if (JSON.stringify(service.networks) !== JSON.stringify({ default: null }))
      fail(`${name} must use only Compose's default bridge network.`);
  }
  if (
    !dashboard.build ||
    dashboard.build.context !== repositoryRoot ||
    (dashboard.build.dockerfile ?? "Dockerfile") !== "Dockerfile" ||
    Object.keys(dashboard.build).some(
      (key) => !["context", "dockerfile"].includes(key),
    )
  )
    fail(
      "dashboard must build this repository's default Dockerfile without overrides.",
    );
  if (
    !worker.build ||
    worker.build.context !== path.join(repositoryRoot, "worker") ||
    (worker.build.dockerfile ?? "Dockerfile") !== "Dockerfile" ||
    Object.keys(worker.build).some(
      (key) => !["context", "dockerfile"].includes(key),
    )
  )
    fail(
      "assistant-worker must build only worker/Dockerfile without overrides.",
    );
  const { ipam, ...network } = configuration.networks?.default ?? {};
  if (
    !configuration.networks ||
    Object.keys(configuration.networks).length !== 1 ||
    (ipam && Object.keys(ipam).length !== 0) ||
    JSON.stringify(network) !==
      JSON.stringify({
        name: `${projectName}_default`,
        driver: "bridge",
        driver_opts: { "com.docker.network.bridge.name": "br-voidstation" },
      })
  )
    fail(
      "dashboard must use the dedicated default bridge network without overrides.",
    );
}
function validatePolicy(configuration) {
  const policy = configuration["x-voidstation"];
  if (
    !policy ||
    typeof policy.expected_data_filesystem_uuid !== "string" ||
    !policy.expected_data_filesystem_uuid.trim() ||
    policy.expected_data_filesystem_uuid.trim() !==
      policy.expected_data_filesystem_uuid
  )
    fail("x-voidstation.expected_data_filesystem_uuid must be configured.");
  const required = [
    "lan_interface",
    "lan_source",
    "lan_bind_address",
    "lan_https_port",
    "lan_tls_directory",
  ];
  if (
    Object.keys(policy).some(
      (key) => !["expected_data_filesystem_uuid", ...required].includes(key),
    ) ||
    required.some(
      (key) => typeof policy[key] !== "string" || !policy[key].trim(),
    )
  )
    fail("x-voidstation must configure the LAN ingress policy.");
  if (!/^[A-Za-z0-9_.-]+$/.test(policy.lan_interface))
    fail("VOIDSTATION_LAN_INTERFACE must name one network interface.");
  if (!isRfc1918(policy.lan_bind_address))
    fail("VOIDSTATION_LAN_BIND_ADDRESS must be an RFC1918 IPv4 address.");
  const source = parsePrivateCidr(policy.lan_source, "VOIDSTATION_LAN_SOURCE");
  if (!cidrContains(source, policy.lan_bind_address))
    fail("VOIDSTATION_LAN_SOURCE must contain VOIDSTATION_LAN_BIND_ADDRESS.");
  parsePort(policy.lan_https_port, "VOIDSTATION_LAN_HTTPS_PORT");
  if (
    !path.isAbsolute(policy.lan_tls_directory) ||
    policy.lan_tls_directory !== path.resolve(policy.lan_tls_directory)
  )
    fail("VOIDSTATION_LAN_TLS_DIRECTORY must be a normalized absolute path.");
  return {
    dataUuid: policy.expected_data_filesystem_uuid,
    lan: {
      interface: policy.lan_interface,
      source,
      address: policy.lan_bind_address,
      port: parsePort(policy.lan_https_port, "VOIDSTATION_LAN_HTTPS_PORT"),
      tls: policy.lan_tls_directory,
    },
  };
}
function validatePorts(service, lan) {
  const ports = requireArray(service.ports, "dashboard.ports");
  if (ports.length !== 2)
    fail("dashboard must publish exactly the Tailscale and LAN TLS bindings.");
  const expected = [
    {
      target: dashboardPort,
      host: undefined,
      validator: (host) => isTailscaleCgnat(host),
      label: "Tailscale",
    },
    {
      target: lanDashboardPort,
      host: lan.address,
      validator: (host) => host === lan.address,
      label: "LAN",
    },
  ];
  const endpoints = [];
  for (const specification of expected) {
    const binding = ports.find(
      (candidate) => candidate?.target === specification.target,
    );
    if (
      !binding ||
      binding.protocol !== "tcp" ||
      binding.mode !== "ingress" ||
      !specification.validator(binding.host_ip)
    )
      fail(
        `dashboard must publish the configured ${specification.label} TLS binding only.`,
      );
    const port = parsePort(binding.published, `Port for ${binding.host_ip}`);
    if (specification.target === lanDashboardPort && port !== lan.port)
      fail("VOIDSTATION_LAN_HTTPS_PORT must match the LAN publication.");
    endpoints.push({
      host: binding.host_ip,
      port,
      target: specification.target,
    });
  }
  if (new Set(ports.map((binding) => binding.target)).size !== 2)
    fail("dashboard must publish each TLS listener exactly once.");
  return { tailscale: endpoints[0], lan: endpoints[1] };
}
function validateEnvironment(service, endpoints) {
  const environment = environmentMap(service.environment);
  const required = {
    HOSTNAME: "0.0.0.0",
    PORT: "3000",
    VOIDSTATION_TLS_CERT: containerPaths.cert,
    VOIDSTATION_TLS_KEY: containerPaths.key,
    VOIDSTATION_LAN_PORT: String(lanDashboardPort),
    VOIDSTATION_LAN_TLS_CERT: containerPaths.lanCert,
    VOIDSTATION_LAN_TLS_KEY: containerPaths.lanKey,
    VOIDSTATION_AUTH_DB: containerPaths.authDatabase,
    VOIDSTATION_HOST_PROC: "/host/proc",
    VOIDSTATION_HOST_ROOT_FS: "/host/filesystems/root",
    VOIDSTATION_HOST_DATA_FS: "/host/filesystems/data",
    VOIDSTATION_WORKER_URL: `http://${workerServiceName}:${workerPort}`,
    VOIDSTATION_WORKER_TOKEN_FILE: containerPaths.workerToken,
  };
  for (const [name, expected] of Object.entries(required))
    if (String(environment[name] ?? "") !== expected)
      fail(`dashboard.environment.${name} must be ${expected}.`);
  const allowed = new Set([
    ...Object.keys(required),
    "VOIDSTATION_ORIGIN",
    "VOIDSTATION_LAN_ORIGIN",
  ]);
  for (const name of Object.keys(environment))
    if (!allowed.has(name))
      fail(`dashboard.environment.${name} is not allowed.`);
  const tsHost = new URL(environment.VOIDSTATION_ORIGIN).hostname;
  if (!tsHost.endsWith(".ts.net"))
    fail(
      "VOIDSTATION_ORIGIN must be a canonical HTTPS origin on a Tailscale .ts.net hostname.",
    );
  validateOrigin(
    environment.VOIDSTATION_ORIGIN,
    "VOIDSTATION_ORIGIN",
    tsHost,
    endpoints.tailscale.port,
  );
  validateOrigin(
    environment.VOIDSTATION_LAN_ORIGIN,
    "VOIDSTATION_LAN_ORIGIN",
    endpoints.lan.host,
    endpoints.lan.port,
  );
  return {
    tsOrigin: environment.VOIDSTATION_ORIGIN,
    lanOrigin: environment.VOIDSTATION_LAN_ORIGIN,
    tsHostname: tsHost.toLowerCase(),
  };
}
function validateSecurityConfiguration(name, service) {
  if (
    service.restart !== "unless-stopped" ||
    service.read_only !== true ||
    String(service.user) !== "1000:1000"
  )
    fail(
      `${name} must use restart: unless-stopped, read_only: true, and user: 1000:1000.`,
    );
  if (!sameArray(service.cap_drop, ["ALL"]))
    fail(`${name} must keep cap_drop: [ALL].`);
  if (!sameArray(service.security_opt, ["no-new-privileges:true"]))
    fail(`${name} must keep security_opt: [no-new-privileges:true].`);
  if (!sameArray(service.tmpfs, ["/tmp:size=16m,noexec,nosuid"]))
    fail(`${name} must keep its restricted /tmp tmpfs.`);
}
function validateVolume(volume, target, source, readOnly = true) {
  if (
    volume?.type !== "bind" ||
    volume.target !== target ||
    volume.source !== source ||
    volume.read_only !== readOnly ||
    volume.bind?.create_host_path !== false
  )
    fail(`The bind mount for ${target} has changed or is unsafe.`);
}
function validateMountConfiguration(service, lan) {
  const volumes = requireArray(service.volumes, "dashboard.volumes");
  if (volumes.length !== 9)
    fail(
      "dashboard must have five metrics mounts, auth data, two TLS directories, and the worker token.",
    );
  const byTarget = new Map(volumes.map((volume) => [volume?.target, volume]));
  if (byTarget.size !== volumes.length) fail("dashboard has duplicate mounts.");
  validateVolume(
    byTarget.get("/host/proc/stat"),
    "/host/proc/stat",
    "/proc/stat",
  );
  validateVolume(
    byTarget.get("/host/proc/uptime"),
    "/host/proc/uptime",
    "/proc/uptime",
  );
  validateVolume(
    byTarget.get("/host/proc/meminfo"),
    "/host/proc/meminfo",
    "/proc/meminfo",
  );
  for (const target of ["/host/filesystems/root", "/host/filesystems/data"]) {
    const volume = byTarget.get(target);
    if (
      volume?.type !== "bind" ||
      typeof volume.source !== "string" ||
      volume.read_only !== true ||
      volume.bind?.create_host_path !== false
    )
      fail(`The bind mount for ${target} has changed or is unsafe.`);
  }
  const auth = byTarget.get(containerPaths.authDirectory);
  if (
    auth?.type !== "bind" ||
    typeof auth.source !== "string" ||
    auth.read_only === true ||
    auth.bind?.create_host_path !== false
  )
    fail(
      "The auth-data bind mount must be writable and must not create its host path.",
    );
  const tls = byTarget.get("/run/voidstation-tls");
  if (
    tls?.type !== "bind" ||
    typeof tls.source !== "string" ||
    tls.read_only !== true ||
    tls.bind?.create_host_path !== false
  )
    fail(
      "The TLS bind mount must be read-only and must not create its host path.",
    );
  validateVolume(
    byTarget.get("/run/voidstation-lan-tls"),
    "/run/voidstation-lan-tls",
    lan.tls,
  );
  const token = byTarget.get(containerPaths.workerToken);
  validateVolume(token, containerPaths.workerToken, token?.source);
  return {
    proc: ["/proc/stat", "/proc/uptime", "/proc/meminfo"],
    root: byTarget.get("/host/filesystems/root").source,
    data: byTarget.get("/host/filesystems/data").source,
    auth: auth.source,
    tls: tls.source,
    lanTls: lan.tls,
    workerToken: token.source,
  };
}
function validateWorkerConfiguration(service, dashboardTokenSource) {
  const environment = environmentMap(service.environment);
  const required = {
    VOIDSTATION_WORKER_HOST: "0.0.0.0",
    VOIDSTATION_WORKER_PORT: String(workerPort),
    VOIDSTATION_WORKER_TOKEN_FILE: containerPaths.workerToken,
    VOIDSTATION_CONVERSATION_DIR: containerPaths.conversationDirectory,
    VOIDSTATION_CREDENTIAL_DIR: containerPaths.credentialDirectory,
    VOIDSTATION_MEDIA_CONFIG_FILE: containerPaths.mediaConfig,
  };
  for (const [name, expected] of Object.entries(required))
    if (String(environment[name] ?? "") !== expected)
      fail(`assistant-worker.environment.${name} must be ${expected}.`);
  if (Object.keys(environment).some((name) => !Object.hasOwn(required, name)))
    fail("assistant-worker environment changed.");
  if (
    service.ports != null &&
    (!Array.isArray(service.ports) || service.ports.length !== 0)
  )
    fail("assistant-worker must not publish a host port.");
  const volumes = requireArray(service.volumes, "assistant-worker.volumes");
  if (volumes.length !== 4)
    fail(
      "assistant-worker must mount only its token, conversations, credentials, and media configuration.",
    );
  const byTarget = new Map(volumes.map((volume) => [volume?.target, volume]));
  if (byTarget.size !== volumes.length)
    fail("assistant-worker has duplicate mounts.");
  validateVolume(
    byTarget.get(containerPaths.workerToken),
    containerPaths.workerToken,
    dashboardTokenSource,
  );
  for (const target of [
    containerPaths.conversationDirectory,
    containerPaths.credentialDirectory,
  ]) {
    const volume = byTarget.get(target);
    if (
      volume?.type !== "bind" ||
      typeof volume.source !== "string" ||
      volume.read_only === true ||
      volume.bind?.create_host_path !== false
    )
      fail(
        `The assistant-worker bind mount for ${target} must be writable and must not create its host path.`,
      );
  }
  const media = byTarget.get(containerPaths.mediaDirectory);
  if (
    media?.type !== "bind" ||
    typeof media.source !== "string" ||
    media.read_only !== true ||
    media.bind?.create_host_path !== false
  )
    fail(
      "The assistant-worker media configuration mount must be read-only and must not create its host path.",
    );
  const conversations = byTarget.get(
    containerPaths.conversationDirectory,
  ).source;
  const credentials = byTarget.get(containerPaths.credentialDirectory).source;
  if (conversations === credentials)
    fail(
      "assistant-worker conversation and credential storage must use separate host directories.",
    );
  return {
    token: dashboardTokenSource,
    conversations,
    credentials,
    media: media.source,
  };
}
function checkedPath(source, description, directory) {
  if (
    typeof source !== "string" ||
    !path.isAbsolute(source) ||
    source !== path.resolve(source)
  )
    fail(`${description} must be a normalized absolute path.`);
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch (error) {
    fail(`${description} is absent or cannot be inspected: ${error.message}`);
  }
  if (stat.isSymbolicLink())
    fail(`${description} must not be a symbolic link.`);
  let realPath;
  try {
    realPath = fs.realpathSync.native(source);
  } catch (error) {
    fail(`${description} cannot be resolved: ${error.message}`);
  }
  if (realPath !== source || (directory ? !stat.isDirectory() : !stat.isFile()))
    fail(
      `${description} must be a ${directory ? "directory" : "regular file"}.`,
    );
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
    if (fs.readdirSync(source).length) fail(`${description} must be empty.`);
  } catch (error) {
    if (error.message?.endsWith("must be empty.")) throw error;
    fail(`${description} cannot be read: ${error.message}`);
  }
}
function findMount(pathname) {
  const filesystem = parseJson(
    run(
      "findmnt",
      ["--json", "--target", pathname, "--output", "TARGET,UUID"],
      `Inspecting the filesystem containing ${pathname}`,
    ),
    `findmnt output for ${pathname}`,
  ).filesystems?.[0];
  if (!filesystem?.target)
    fail(`findmnt did not find the filesystem containing ${pathname}.`);
  return filesystem;
}
function validateFilesystemProbes(probes, expectedDataUuid) {
  for (const source of probes.proc) {
    checkedPath(source, `Proc file ${source}`, false);
    requireAccess(source, `Proc file ${source}`, fs.constants.R_OK);
  }
  const root = checkedPath(probes.root, "Root filesystem probe", true);
  const data = checkedPath(probes.data, "Data filesystem probe", true);
  requireAccess(
    probes.root,
    "Root filesystem probe",
    fs.constants.R_OK | fs.constants.X_OK,
  );
  requireAccess(
    probes.data,
    "Data filesystem probe",
    fs.constants.R_OK | fs.constants.X_OK,
  );
  requireEmptyDirectory(probes.root, "Root filesystem probe");
  requireEmptyDirectory(probes.data, "Data filesystem probe");
  if (root.dev !== fs.statSync("/").dev || data.dev === fs.statSync("/").dev)
    fail(
      "Filesystem probes must be narrow directories on their configured filesystems.",
    );
  const rootMount = findMount(probes.root);
  const dataMount = findMount(probes.data);
  if (rootMount.target === probes.root || dataMount.target === probes.data)
    fail("Filesystem probe directories must not be entire filesystem mounts.");
  if (
    typeof dataMount.uuid !== "string" ||
    dataMount.uuid.toLowerCase() !== expectedDataUuid.toLowerCase()
  )
    fail(
      `Data filesystem UUID does not match the configured expected UUID (${expectedDataUuid}).`,
    );
}
function validateWorkerState(worker) {
  const token = checkedPath(worker.token, "Worker token file", false);
  requireAccess(worker.token, "Worker token file", fs.constants.R_OK);
  if (
    token.uid !== 1000 ||
    token.gid !== 1000 ||
    (token.mode & 0o777) !== 0o600
  )
    fail("Worker token file must be owned by UID/GID 1000 with mode 0600.");
  if (fs.readFileSync(worker.token, "utf8").trim().length < 32)
    fail(
      "Worker token file must contain at least 32 non-whitespace characters.",
    );
  for (const [description, source] of [
    ["Conversation directory", worker.conversations],
    ["Worker credential directory", worker.credentials],
  ]) {
    const stat = checkedPath(source, description, true);
    requireAccess(
      source,
      description,
      fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
    );
    if (stat.uid !== 1000 || stat.gid !== 1000 || (stat.mode & 0o777) !== 0o700)
      fail(`${description} must be owned by UID/GID 1000 with mode 0700.`);
  }
  validateMediaConfiguration(worker.media);
}
function validateMediaEndpoint(value, service) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim())
    fail(`Media ${service} endpoint must be a non-empty URL.`);
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail(`Media ${service} endpoint must be an HTTP or HTTPS URL.`);
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    fail(`Media ${service} endpoint must not contain credentials or URL parameters.`);
}
function validateMediaConfiguration(source) {
  const directory = checkedPath(source, "Media configuration directory", true);
  requireAccess(
    source,
    "Media configuration directory",
    fs.constants.R_OK | fs.constants.X_OK,
  );
  if (
    directory.uid !== 1000 ||
    directory.gid !== 1000 ||
    (directory.mode & 0o777) !== 0o700
  )
    fail(
      "Media configuration directory must be owned by UID/GID 1000 with mode 0700.",
    );
  const configPath = path.join(source, "config.json");
  const configStat = checkedPath(configPath, "Media configuration file", false);
  requireAccess(configPath, "Media configuration file", fs.constants.R_OK);
  if (
    configStat.uid !== 1000 ||
    configStat.gid !== 1000 ||
    (configStat.mode & 0o777) !== 0o600
  )
    fail(
      "Media configuration file must be owned by UID/GID 1000 with mode 0600.",
    );
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    fail("Media configuration file must contain JSON.");
  }
  const services = ["radarr", "sonarr"];
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(services)
  )
    fail("Media configuration must contain only radarr and sonarr.");
  const expectedFiles = new Set(["config.json"]);
  for (const service of services) {
    const settings = config[service];
    const required = [
      "endpoint",
      "keyFile",
      "rootFolder",
      "defaultQualityProfileId",
      "qualityMappings",
    ];
    if (
      !settings ||
      typeof settings !== "object" ||
      Array.isArray(settings) ||
      JSON.stringify(Object.keys(settings).sort()) !==
        JSON.stringify(required.sort())
    )
      fail(`Media ${service} configuration has an invalid shape.`);
    validateMediaEndpoint(settings.endpoint, service);
    if (settings.keyFile !== containerPaths.mediaKeys[service])
      fail(`Media ${service} keyFile must use its selected worker-only key path.`);
    const keyName = path.basename(settings.keyFile);
    const keyPath = path.join(source, keyName);
    expectedFiles.add(keyName);
    const key = checkedPath(keyPath, `Media ${service} key file`, false);
    requireAccess(keyPath, `Media ${service} key file`, fs.constants.R_OK);
    if (
      key.uid !== 1000 ||
      key.gid !== 1000 ||
      (key.mode & 0o777) !== 0o600 ||
      fs.readFileSync(keyPath, "utf8").trim().length === 0
    )
      fail(
        `Media ${service} key file must be non-empty, owned by UID/GID 1000, and mode 0600.`,
      );
    if (
      typeof settings.rootFolder !== "string" ||
      !path.isAbsolute(settings.rootFolder) ||
      settings.rootFolder !== path.resolve(settings.rootFolder)
    )
      fail(`Media ${service} rootFolder must be a normalized absolute path.`);
    if (
      !Number.isSafeInteger(settings.defaultQualityProfileId) ||
      settings.defaultQualityProfileId <= 0
    )
      fail(`Media ${service} defaultQualityProfileId must be a positive integer.`);
    if (
      !settings.qualityMappings ||
      typeof settings.qualityMappings !== "object" ||
      Array.isArray(settings.qualityMappings) ||
      Object.keys(settings.qualityMappings).length === 0 ||
      Object.entries(settings.qualityMappings).some(
        ([name, id]) =>
          !name.trim() || !Number.isSafeInteger(id) || id <= 0,
      )
    )
      fail(`Media ${service} qualityMappings must map non-empty names to positive profile IDs.`);
  }
  const entries = fs.readdirSync(source).sort();
  if (
    entries.length !== expectedFiles.size ||
    entries.some((entry) => !expectedFiles.has(entry))
  )
    fail(
      "Media configuration directory must contain only config.json and the selected service key files.",
    );
  return { directory: source, config: configPath };
}
function pathsOverlap(first, second) {
  const relative = path.relative(first, second);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function validateSeparateStatePaths(probes, worker) {
  const statePaths = [
    ["auth data", probes.auth],
    ["conversation state", worker.conversations],
    ["worker credential state", worker.credentials],
    ["media configuration", worker.media],
    ["Tailscale TLS", probes.tls],
    ["LAN TLS", probes.lanTls],
  ];
  for (let index = 0; index < statePaths.length; index += 1) {
    for (let other = index + 1; other < statePaths.length; other += 1) {
      if (
        pathsOverlap(statePaths[index][1], statePaths[other][1]) ||
        pathsOverlap(statePaths[other][1], statePaths[index][1])
      )
        fail(
          `${statePaths[index][0]} and ${statePaths[other][0]} must use separate paths.`,
        );
    }
  }
}

function validateAuthDirectory(source) {
  const stat = checkedPath(source, "Auth-data directory", true);
  requireAccess(
    source,
    "Auth-data directory",
    fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
  );
  if (stat.uid !== 1000 || stat.gid !== 1000 || (stat.mode & 0o777) !== 0o700)
    fail("Auth-data directory must be owned by UID/GID 1000 with mode 0700.");
  const database = path.join(source, "auth.sqlite");
  if (fs.existsSync(database)) {
    const file = checkedPath(database, "Auth database", false);
    if (file.uid !== 1000 || file.gid !== 1000 || (file.mode & 0o777) !== 0o600)
      fail("Auth database must be owned by UID/GID 1000 with mode 0600.");
  }
}
function certificateHasSan(san, type, identity) {
  const expected = `${type}:${identity}`.toLowerCase();
  return [...san.matchAll(/(?:DNS|IP Address):[^,\s]+/gi)].some(
    (match) => match[0].toLowerCase() === expected,
  );
}

function containsPrivateKey(pathname) {
  return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(
    fs.readFileSync(pathname, "utf8"),
  );
}

function validateCertificate(
  directoryPath,
  identity,
  description,
  trustAnchor = false,
) {
  const directory = checkedPath(
    directoryPath,
    `${description} directory`,
    true,
  );
  requireAccess(
    directoryPath,
    `${description} directory`,
    fs.constants.R_OK | fs.constants.X_OK,
  );
  if ((directory.mode & 0o022) !== 0)
    fail(
      `${description} directory must not be writable by its group or others.`,
    );
  const certificate = path.join(directoryPath, "cert.pem");
  const key = path.join(directoryPath, "key.pem");
  checkedPath(certificate, `${description} certificate`, false);
  const keyStat = checkedPath(key, `${description} private key`, false);
  requireAccess(certificate, `${description} certificate`, fs.constants.R_OK);
  requireAccess(key, `${description} private key`, fs.constants.R_OK);
  if (
    keyStat.uid !== 1000 ||
    keyStat.gid !== 1000 ||
    (keyStat.mode & 0o777) !== 0o600
  )
    fail(
      `${description} private key must be owned by UID/GID 1000 with mode 0600.`,
    );
  const san = run(
    "openssl",
    ["x509", "-in", certificate, "-noout", "-ext", "subjectAltName"],
    `Reading ${description} certificate SANs`,
  );
  const sanType = trustAnchor ? "IP Address" : "DNS";
  if (!certificateHasSan(san, sanType, identity))
    fail(`${description} certificate SAN does not contain ${identity}.`);
  if (trustAnchor) {
    const ca = path.join(directoryPath, "ca.pem");
    checkedPath(ca, "LAN TLS trust anchor", false);
    requireAccess(ca, "LAN TLS trust anchor", fs.constants.R_OK);
    if (
      fs
        .readdirSync(directoryPath)
        .some((name) => !["cert.pem", "key.pem", "ca.pem"].includes(name))
    )
      fail(
        "VOIDSTATION_LAN_TLS_DIRECTORY must not contain a CA signing private key or other unmounted material.",
      );
    if (containsPrivateKey(certificate))
      fail("LAN TLS certificate must not contain private keys.");
    if (containsPrivateKey(ca))
      fail("LAN TLS trust anchor must not contain private keys.");
    const leafFingerprint = run(
      "openssl",
      ["x509", "-in", certificate, "-noout", "-fingerprint", "-sha256"],
      "Reading the LAN TLS certificate fingerprint",
    ).trim();
    const caFingerprint = run(
      "openssl",
      ["x509", "-in", ca, "-noout", "-fingerprint", "-sha256"],
      "Reading the LAN TLS trust-anchor fingerprint",
    ).trim();
    if (!leafFingerprint || leafFingerprint === caFingerprint)
      fail(
        "LAN TLS certificate must be a dedicated leaf, not its trust anchor.",
      );
    const constraints = run(
      "openssl",
      ["x509", "-in", certificate, "-noout", "-ext", "basicConstraints"],
      "Reading LAN TLS certificate constraints",
    );
    if (/CA\s*:\s*TRUE/i.test(constraints))
      fail("LAN TLS certificate must not be a CA certificate.");
    const caConstraints = run(
      "openssl",
      ["x509", "-in", ca, "-noout", "-ext", "basicConstraints"],
      "Reading LAN TLS trust-anchor constraints",
    );
    if (!/CA\s*:\s*TRUE/i.test(caConstraints))
      fail("LAN TLS trust anchor must be a CA certificate.");
    run(
      "openssl",
      [
        "verify",
        "-CAfile",
        ca,
        "-purpose",
        "sslserver",
        "-verify_ip",
        identity,
        certificate,
      ],
      "Verifying the LAN TLS leaf against its dedicated private CA",
    );
  }
  run(
    "openssl",
    [
      "x509",
      "-in",
      certificate,
      "-noout",
      "-checkend",
      String(trustAnchor ? 30 * 24 * 60 * 60 : 0),
    ],
    `Checking ${description} certificate expiry`,
  );
  const publicKey = run(
    "openssl",
    ["x509", "-in", certificate, "-noout", "-pubkey"],
    `Reading ${description} certificate public key`,
  ).trim();
  const privateKey = run(
    "openssl",
    ["pkey", "-in", key, "-pubout"],
    `Reading ${description} private key public key`,
  ).trim();
  if (!publicKey || publicKey !== privateKey)
    fail(`${description} certificate and private key do not match.`);
}
function validateRuntimeAccess(probes, worker) {
  const inputs = [
    ...probes.proc.map((source) => [source, fs.constants.R_OK]),
    ...[probes.root, probes.data, probes.tls, probes.lanTls].map((source) => [
      source,
      fs.constants.R_OK | fs.constants.X_OK,
    ]),
    [probes.auth, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK],
    [path.join(probes.tls, "cert.pem"), fs.constants.R_OK],
    [path.join(probes.tls, "key.pem"), fs.constants.R_OK],
    [
      containerPaths.lanCa.replace("/run/voidstation-lan-tls", probes.lanTls),
      fs.constants.R_OK,
    ],
    [path.join(probes.lanTls, "cert.pem"), fs.constants.R_OK],
    [path.join(probes.lanTls, "key.pem"), fs.constants.R_OK],
    [worker.token, fs.constants.R_OK],
    [
      worker.conversations,
      fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
    ],
    [
      worker.credentials,
      fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
    ],
    [worker.media, fs.constants.R_OK | fs.constants.X_OK],
    [path.join(worker.media, "config.json"), fs.constants.R_OK],
    [path.join(worker.media, "radarr.key"), fs.constants.R_OK],
    [path.join(worker.media, "sonarr.key"), fs.constants.R_OK],
  ];
  runAsRoot(
    "setpriv",
    [
      "--reuid=1000",
      "--regid=1000",
      "--clear-groups",
      process.execPath,
      "-e",
      "for (const [path, mode] of JSON.parse(process.argv[1])) require('node:fs').accessSync(path, mode)",
      JSON.stringify(inputs),
    ],
    "Checking mounted inputs as UID/GID 1000",
  );
}
function tailscaleStatus(endpoint, hostname) {
  const status = parseJson(
    run("tailscale", ["status", "--json"], "Reading Tailscale status"),
    "Tailscale status",
  );
  if (
    !requireArray(
      status?.Self?.TailscaleIPs,
      "Tailscale Self.TailscaleIPs",
    ).includes(endpoint.host)
  )
    fail(`${endpoint.host} is not assigned to this server by Tailscale.`);
  if (
    String(status?.Self?.DNSName ?? "")
      .toLowerCase()
      .replace(/\.$/, "") !== hostname
  )
    fail(
      "VOIDSTATION_ORIGIN hostname does not match this server's Tailscale DNS name.",
    );
  const serve = parseJson(
    run(
      "tailscale",
      ["serve", "status", "--json"],
      "Reading Tailscale Serve status",
    ),
    "Tailscale Serve status",
  );
  if (containsEnabledFunnel(serve))
    fail("Tailscale Funnel is enabled. Disable it before deployment.");
}
function containsEnabledFunnel(value, underFunnel = false) {
  if (Array.isArray(value))
    return value.some((item) => containsEnabledFunnel(item, underFunnel));
  if (!value || typeof value !== "object")
    return (
      underFunnel &&
      value !== false &&
      value !== null &&
      value !== "" &&
      value !== 0
    );
  return Object.entries(value).some(([key, nested]) =>
    containsEnabledFunnel(nested, underFunnel || /funnel/i.test(key)),
  );
}
function validateLanInterface(lan) {
  if (
    /^(?:lo|br-|docker|veth|virbr|tun|tap|wg|tailscale|zt)/i.test(lan.interface)
  )
    fail(
      "VOIDSTATION_LAN_INTERFACE must not be a loopback, bridge, tunnel, or virtual interface.",
    );
  const interfaces = requireArray(
    parseJson(
      run(
        "ip",
        ["-details", "-j", "-4", "address", "show", "dev", lan.interface],
        "Reading the configured LAN interface",
      ),
      "LAN interface inspection",
    ),
    "LAN interface inspection",
  );
  const device = interfaces.find(
    (candidate) => candidate?.ifname === lan.interface,
  );
  if (
    !device ||
    device.operstate !== "UP" ||
    !requireArray(device.flags, "LAN interface flags").includes("UP") ||
    [
      "bond",
      "bridge",
      "dummy",
      "geneve",
      "gre",
      "gretap",
      "ipip",
      "ipvlan",
      "macvlan",
      "sit",
      "team",
      "tunnel",
      "veth",
      "vlan",
      "vrf",
      "vxlan",
      "wireguard",
      "xfrm",
    ].includes(device.linkinfo?.info_kind)
  )
    fail("VOIDSTATION_LAN_INTERFACE is not an active physical LAN interface.");
  const address = requireArray(
    device.addr_info,
    "LAN interface addresses",
  ).find(
    (candidate) =>
      candidate?.family === "inet" && candidate.local === lan.address,
  );
  if (!address)
    fail(
      "VOIDSTATION_LAN_BIND_ADDRESS is not assigned to VOIDSTATION_LAN_INTERFACE.",
    );
  const size = 2 ** (32 - address.prefixlen);
  const actual = parsePrivateCidr(
    `${numberIpv4(Math.floor(ipv4Number(lan.address, "VOIDSTATION_LAN_BIND_ADDRESS") / size) * size)}/${address.prefixlen}`,
    "LAN interface address",
  );
  if (actual.value !== lan.source.value)
    fail(
      "VOIDSTATION_LAN_SOURCE does not match the configured LAN interface CIDR.",
    );
}
function normalizedRule(rule) {
  return rule.trim().replace(/\s+/g, " ");
}

function normalizedConntrackStates(rule) {
  return normalizedRule(rule).replace(
    /--ctstate ([A-Z,]+)/g,
    (_match, states) => `--ctstate ${states.split(",").sort().join(",")}`,
  );
}
function chainRules(chain) {
  return runAsRoot("iptables", ["-S", chain], "Reading Docker ingress rules")
    .split("\n")
    .filter((line) => line.startsWith("-A "))
    .map(normalizedConntrackStates);
}
function validateIngressPath(ingressPath) {
  if (
    runAsRoot(
      "readlink",
      ["-f", ingressPath],
      "Resolving ingress configuration",
    ).trim() !== ingressPath
  )
    fail("/etc/voidstation/ingress.json must not use symbolic-link ancestors.");
  const ownership = runAsRoot(
    "stat",
    ["-c", "%u:%g:%a", "/etc", "/etc/voidstation", ingressPath],
    "Inspecting ingress configuration ownership",
  )
    .trim()
    .split("\n");
  if (ownership.length !== 3)
    fail("Could not inspect ingress configuration ancestors.");
  for (const [pathname, value] of [
    ["/etc", ownership[0]],
    ["/etc/voidstation", ownership[1]],
  ]) {
    const [uid, gid, mode] = value.split(":");
    if (uid !== "0" || gid !== "0" || (Number.parseInt(mode, 8) & 0o022) !== 0)
      fail(
        `${pathname} must be root-owned and not writable by group or others.`,
      );
  }
  if (ownership[2] !== "0:0:600")
    fail("/etc/voidstation/ingress.json must be owned by root with mode 0600.");
}

function validateIngress(endpoints, lan) {
  const ingressPath = "/etc/voidstation/ingress.json";
  validateIngressPath(ingressPath);
  const config = parseJson(
    runAsRoot("cat", [ingressPath], "Reading ingress configuration"),
    "Ingress configuration",
  );
  const expectedConfig = {
    lanInterface: lan.interface,
    lanSource: lan.source.value,
    lanAddress: lan.address,
    lanPort: lan.port,
    tailscaleAddress: endpoints.tailscale.host,
    tailscalePort: endpoints.tailscale.port,
  };
  if (
    JSON.stringify(Object.keys(config ?? {}).sort()) !==
      JSON.stringify(Object.keys(expectedConfig).sort()) ||
    Object.entries(expectedConfig).some(([key, value]) => config[key] !== value)
  )
    fail(
      "/etc/voidstation/ingress.json does not match the Compose LAN and Tailscale ingress policy.",
    );
  runAsRoot(
    "/usr/local/libexec/voidstation-ingress",
    ["--check"],
    "Checking installed Voidstation ingress policy",
  );
  const forward = chainRules("FORWARD");
  const dockerUser = chainRules("DOCKER-USER");
  if (
    forward[0] !== "-A FORWARD -j DOCKER-USER" ||
    dockerUser[0] !== "-A DOCKER-USER -o br-voidstation -j VOIDSTATION"
  )
    fail(
      "Docker ingress rules must first jump from FORWARD to DOCKER-USER and then VOIDSTATION.",
    );
  const policy = chainRules("VOIDSTATION");
  const expected = [
    "-A VOIDSTATION -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j RETURN",
    "-A VOIDSTATION -i br-voidstation -j RETURN",
    `-A VOIDSTATION -s 100.64.0.0/10 -i tailscale0 -p tcp -m tcp --dport ${dashboardPort} -m conntrack --ctstate NEW,ESTABLISHED --ctorigdst ${endpoints.tailscale.host} --ctorigdstport ${endpoints.tailscale.port} --ctdir ORIGINAL -j RETURN`,
    `-A VOIDSTATION -s ${lan.source.value} -i ${lan.interface} -p tcp -m tcp --dport ${lanDashboardPort} -m conntrack --ctstate NEW,ESTABLISHED --ctorigdst ${lan.address} --ctorigdstport ${lan.port} --ctdir ORIGINAL -j RETURN`,
    "-A VOIDSTATION -j DROP",
  ];
  if (
    policy.length !== expected.length ||
    policy.some(
      (rule, index) => rule !== normalizedConntrackStates(expected[index]),
    )
  )
    fail(
      "VOIDSTATION must contain exactly the configured return rules followed by DROP.",
    );
}
function validateHostSupport(tlsDirectory, hostname) {
  const properties = (unit, names) =>
    Object.fromEntries(
      run(
        "systemctl",
        ["show", unit, `--property=${names.join(",")}`],
        `Inspecting ${unit}`,
      )
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  const ingress = properties("voidstation-ingress.service", [
    "ActiveState",
    "UnitFileState",
    "Before",
    "PartOf",
    "ExecStart",
  ]);
  const requires = run(
    "systemctl",
    ["show", "docker.service", "--property=Requires", "--value"],
    "Inspecting Docker startup dependencies",
  )
    .trim()
    .split(/\s+/);
  if (
    ingress.ActiveState !== "active" ||
    ingress.UnitFileState !== "enabled" ||
    !ingress.Before?.split(/\s+/).includes("docker.service") ||
    !ingress.PartOf?.split(/\s+/).includes("docker.service") ||
    !ingress.ExecStart?.includes(
      "path=/usr/local/libexec/voidstation-ingress ;",
    ) ||
    !requires.includes("voidstation-ingress.service")
  )
    fail(
      "Voidstation needs active persistent ingress protection required before Docker startup.",
    );
  const renewal = properties("voidstation-certificate-renewal.timer", [
    "ActiveState",
    "UnitFileState",
    "Unit",
  ]);
  if (
    renewal.ActiveState !== "active" ||
    renewal.UnitFileState !== "enabled" ||
    renewal.Unit !== "voidstation-certificate-renewal.service"
  )
    fail("Voidstation certificate renewal timer must be enabled and active.");
  const service = properties("voidstation-certificate-renewal.service", [
    "Environment",
    "ExecStart",
  ]);
  if (
    !service.Environment?.split(/\s+/).includes(
      `VOIDSTATION_TLS_DIRECTORY=${tlsDirectory}`,
    ) ||
    !service.Environment?.split(/\s+/).includes(
      "VOIDSTATION_HOSTNAME_FILE=/etc/voidstation/hostname",
    ) ||
    !service.ExecStart?.includes(
      "path=/usr/local/libexec/voidstation-renew-certificate ;",
    ) ||
    runAsRoot(
      "cat",
      ["/etc/voidstation/hostname"],
      "Checking certificate renewal hostname",
    ).trim() !== hostname
  )
    fail(
      "Voidstation renewal configuration must match the deployed TLS directory and hostname.",
    );
}
function runningContainers() {
  const ids = docker(["ps", "--quiet"], "Listing running Docker containers")
    .trim()
    .split("\n")
    .filter(Boolean);
  return ids.length
    ? parseJson(
        docker(["inspect", ...ids], "Inspecting running Docker containers"),
        "Docker container inspection",
      )
    : [];
}
function ownBinding(container, binding, endpoint) {
  const labels = container?.Config?.Labels ?? {};
  return (
    labels["com.docker.compose.project"] === projectName &&
    labels["com.docker.compose.service"] === dashboardServiceName &&
    binding.HostIp === endpoint.host &&
    String(binding.HostPort) === String(endpoint.port)
  );
}
function overlaps(binding, endpoint) {
  return (
    String(binding.HostPort) === String(endpoint.port) &&
    [endpoint.host, "0.0.0.0", "::", ""].includes(binding.HostIp)
  );
}
function inspectPortConflicts(endpoints) {
  const own = new Map(endpoints.map((endpoint) => [endpoint.target, false]));
  for (const container of runningContainers())
    for (const bindings of Object.values(
      container?.NetworkSettings?.Ports ?? {},
    ))
      if (Array.isArray(bindings))
        for (const binding of bindings)
          for (const endpoint of endpoints)
            if (overlaps(binding, endpoint)) {
              if (ownBinding(container, binding, endpoint))
                own.set(endpoint.target, true);
              else
                fail(
                  `TCP ${endpoint.host}:${endpoint.port} is already published by an unrelated container.`,
                );
            }
  return own;
}
function inspectNativeListeners(endpoints, own) {
  const output = run(
    "ss",
    ["--listening", "--tcp", "--numeric", "--no-header"],
    "Listing native TCP listeners",
  );
  for (const endpoint of endpoints) {
    if (own.get(endpoint.target)) continue;
    for (const line of output.split("\n")) {
      const address = line.trim().split(/\s+/)[3];
      if (
        [
          `${endpoint.host}:${endpoint.port}`,
          `0.0.0.0:${endpoint.port}`,
          `[::]:${endpoint.port}`,
          `*:${endpoint.port}`,
        ].includes(address)
      )
        fail(
          `TCP ${endpoint.host}:${endpoint.port} is already in use by a native listener.`,
        );
    }
  }
}
function environmentFromInspection(container) {
  return environmentMap(container?.Config?.Env ?? []);
}
function exactBindings(bindings, endpoints) {
  if (!bindings || typeof bindings !== "object") return false;
  const expectedNames = endpoints
    .map((endpoint) => `${endpoint.target}/tcp`)
    .sort();
  if (
    JSON.stringify(Object.keys(bindings).sort()) !==
    JSON.stringify(expectedNames)
  )
    return false;
  return endpoints.every((endpoint) => {
    const values = bindings[`${endpoint.target}/tcp`];
    return (
      Array.isArray(values) &&
      values.length === 1 &&
      values[0]?.HostIp === endpoint.host &&
      String(values[0]?.HostPort) === String(endpoint.port)
    );
  });
}
function validateRuntimeHardening(name, container) {
  const hostConfig = container?.HostConfig;
  if (
    container.Config?.User !== "1000:1000" ||
    hostConfig?.ReadonlyRootfs !== true ||
    hostConfig?.Privileged !== false ||
    !sameArray(hostConfig?.CapDrop, ["ALL"]) ||
    (hostConfig?.CapAdd != null &&
      (!Array.isArray(hostConfig.CapAdd) || hostConfig.CapAdd.length > 0)) ||
    !sameArray(hostConfig?.SecurityOpt, ["no-new-privileges:true"])
  )
    fail(`The deployed ${name} security settings changed.`);
  const tmpfs = hostConfig?.Tmpfs;
  const tmpfsOptions = String(tmpfs?.["/tmp"] ?? "").split(",");
  if (
    !tmpfs ||
    JSON.stringify(Object.keys(tmpfs).sort()) !== JSON.stringify(["/tmp"]) ||
    !tmpfsOptions.includes("noexec") ||
    !tmpfsOptions.includes("nosuid") ||
    !tmpfsOptions.some((option) =>
      /^size=(?:16m|16384k|16777216)$/i.test(option),
    )
  )
    fail(`The deployed ${name} /tmp tmpfs changed.`);
}

function validateDashboardInspection(container, endpoints, probes, origins) {
  if (!container?.State?.Running || container.State.Restarting)
    fail("The deployed dashboard is not running.");
  validateRuntimeHardening("dashboard", container);
  if (
    !exactBindings(container.HostConfig?.PortBindings, [
      endpoints.tailscale,
      endpoints.lan,
    ]) ||
    !exactBindings(container.NetworkSettings?.Ports, [
      endpoints.tailscale,
      endpoints.lan,
    ])
  )
    fail(
      "The deployed dashboard must have exactly the configured Tailscale and LAN publications in HostConfig and NetworkSettings.",
    );
  const expectedEnvironment = {
    HOSTNAME: "0.0.0.0",
    PORT: String(dashboardPort),
    VOIDSTATION_ORIGIN: origins.tsOrigin,
    VOIDSTATION_LAN_ORIGIN: origins.lanOrigin,
    VOIDSTATION_TLS_CERT: containerPaths.cert,
    VOIDSTATION_TLS_KEY: containerPaths.key,
    VOIDSTATION_LAN_PORT: String(lanDashboardPort),
    VOIDSTATION_LAN_TLS_CERT: containerPaths.lanCert,
    VOIDSTATION_LAN_TLS_KEY: containerPaths.lanKey,
    VOIDSTATION_AUTH_DB: containerPaths.authDatabase,
    VOIDSTATION_HOST_PROC: "/host/proc",
    VOIDSTATION_HOST_ROOT_FS: "/host/filesystems/root",
    VOIDSTATION_HOST_DATA_FS: "/host/filesystems/data",
    VOIDSTATION_WORKER_URL: `http://${workerServiceName}:${workerPort}`,
    VOIDSTATION_WORKER_TOKEN_FILE: containerPaths.workerToken,
  };
  const environment = environmentFromInspection(container);
  for (const [name, value] of Object.entries(expectedEnvironment))
    if (environment[name] !== value)
      fail(`The deployed dashboard environment ${name} changed.`);
  if (
    environment.NODE_OPTIONS != null ||
    Object.keys(environment).some(
      (name) =>
        name.startsWith("VOIDSTATION_") &&
        !Object.hasOwn(expectedEnvironment, name),
    )
  )
    fail(
      "The deployed dashboard has an unapproved runtime environment variable.",
    );
  if (
    container.HostConfig?.NetworkMode !== `${projectName}_default` ||
    JSON.stringify(
      Object.keys(container.NetworkSettings?.Networks ?? {}).sort(),
    ) !== JSON.stringify([`${projectName}_default`])
  )
    fail("The deployed dashboard network changed.");
  const expectedMounts = new Map([
    ["/host/proc/stat", ["/proc/stat", false]],
    ["/host/proc/uptime", ["/proc/uptime", false]],
    ["/host/proc/meminfo", ["/proc/meminfo", false]],
    ["/host/filesystems/root", [probes.root, false]],
    ["/host/filesystems/data", [probes.data, false]],
    [containerPaths.authDirectory, [probes.auth, true]],
    ["/run/voidstation-tls", [probes.tls, false]],
    ["/run/voidstation-lan-tls", [probes.lanTls, false]],
    [containerPaths.workerToken, [probes.workerToken, false]],
  ]);
  const mounts = requireArray(container.Mounts, "Dashboard mounts");
  if (mounts.length !== expectedMounts.size)
    fail("The deployed dashboard mount count changed.");
  for (const [destination, [source, writable]] of expectedMounts) {
    const mount = mounts.find(
      (candidate) => candidate.Destination === destination,
    );
    if (
      !mount ||
      mount.Type !== "bind" ||
      mount.Source !== source ||
      mount.RW !== writable
    )
      fail(
        `The deployed dashboard mount at ${destination} changed or is unsafe.`,
      );
  }
}
function validateWorkerInspection(container, worker) {
  if (!container?.State?.Running || container.State.Restarting)
    fail("The deployed assistant-worker is not running.");
  validateRuntimeHardening("assistant-worker", container);
  if (
    Object.keys(container.HostConfig?.PortBindings ?? {}).length ||
    Object.values(container.NetworkSettings?.Ports ?? {}).some(
      (bindings) => bindings !== null,
    )
  )
    fail("The deployed assistant-worker has a host port publication.");
  const expectedEnvironment = {
    VOIDSTATION_WORKER_HOST: "0.0.0.0",
    VOIDSTATION_WORKER_PORT: String(workerPort),
    VOIDSTATION_WORKER_TOKEN_FILE: containerPaths.workerToken,
    VOIDSTATION_CONVERSATION_DIR: containerPaths.conversationDirectory,
    VOIDSTATION_CREDENTIAL_DIR: containerPaths.credentialDirectory,
    VOIDSTATION_MEDIA_CONFIG_FILE: containerPaths.mediaConfig,
  };
  const environment = environmentFromInspection(container);
  for (const [name, value] of Object.entries(expectedEnvironment))
    if (environment[name] !== value)
      fail(`The deployed assistant-worker environment ${name} changed.`);
  if (
    environment.NODE_OPTIONS != null ||
    Object.keys(environment).some(
      (name) =>
        name.startsWith("VOIDSTATION_") &&
        !Object.hasOwn(expectedEnvironment, name),
    )
  )
    fail(
      "The deployed assistant-worker has an unapproved runtime environment variable.",
    );
  if (
    container.HostConfig?.NetworkMode !== `${projectName}_default` ||
    JSON.stringify(
      Object.keys(container.NetworkSettings?.Networks ?? {}).sort(),
    ) !== JSON.stringify([`${projectName}_default`])
  )
    fail("The deployed assistant-worker network changed.");
  const expected = new Map([
    [containerPaths.workerToken, [worker.token, false]],
    [containerPaths.conversationDirectory, [worker.conversations, true]],
    [containerPaths.credentialDirectory, [worker.credentials, true]],
    [containerPaths.mediaDirectory, [worker.media, false]],
  ]);
  const mounts = requireArray(container.Mounts, "Assistant-worker mounts");
  if (mounts.length !== expected.size)
    fail("The deployed assistant-worker mount count changed.");
  for (const [destination, [source, writable]] of expected) {
    const mount = mounts.find(
      (candidate) => candidate.Destination === destination,
    );
    if (
      !mount ||
      mount.Type !== "bind" ||
      mount.Source !== source ||
      mount.RW !== writable
    )
      fail(
        `The deployed assistant-worker mount at ${destination} changed or is unsafe.`,
      );
  }
}
async function probeHttps(label, origin, endpoint, ca) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve();
    };
    const request = httpsRequest(
      new URL("/login", origin),
      {
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [{ address: endpoint.host, family: 4 }])
            : callback(null, endpoint.host, 4),
        ...(ca ? { ca: fs.readFileSync(ca) } : {}),
      },
      (response) => {
        let body = "";
        let bodyBytes = 0;
        response.on("data", (chunk) => {
          bodyBytes += chunk.length;
          if (bodyBytes > 64 * 1024) {
            response.destroy();
            finish(new Error(`${label}: login response exceeded 64 KiB`));
            return;
          }
          body += chunk;
        });
        response.on("error", () =>
          finish(new Error(`${label}: HTTPS response failed`)),
        );
        response.on("end", () =>
          finish(
            response.statusCode === 200 && body.includes("Sign in")
              ? undefined
              : new Error(`${label}: login route was not ready`),
          ),
        );
      },
    );
    request.on("error", () =>
      finish(new Error(`${label}: HTTPS request failed`)),
    );
    request.setTimeout(3000, () =>
      request.destroy(new Error(`${label}: HTTPS readiness timed out`)),
    );
    request.end();
  });
}
async function probeBoth(origins, endpoints, probes, wait) {
  const deadline = Date.now() + (wait ? 30_000 : 0);
  do {
    const failures = [];
    for (const [label, origin, endpoint, ca] of [
      ["Tailscale", origins.tsOrigin, endpoints.tailscale, undefined],
      [
        "LAN",
        origins.lanOrigin,
        endpoints.lan,
        path.join(probes.lanTls, "ca.pem"),
      ],
    ]) {
      try {
        await probeHttps(label, origin, endpoint, ca);
      } catch (error) {
        failures.push(error.message);
      }
    }
    if (failures.length === 0) return;
    if (!wait || Date.now() >= deadline)
      fail(
        `Certificate-verified HTTPS login probe failed: ${failures.join("; ")}`,
      );
    await delay(500);
  } while (true);
}
async function postDeployInspection(endpoints, probes, origins, worker) {
  const dashboardId = docker(
    [
      "compose",
      "--project-name",
      projectName,
      "ps",
      "--quiet",
      dashboardServiceName,
    ],
    "Finding the deployed dashboard",
  ).trim();
  const workerId = docker(
    [
      "compose",
      "--project-name",
      projectName,
      "ps",
      "--quiet",
      workerServiceName,
    ],
    "Finding the deployed assistant-worker",
  ).trim();
  if (!dashboardId || !workerId)
    fail(
      "The dashboard and assistant-worker containers must be running after deployment.",
    );
  validateDashboardInspection(
    parseJson(
      docker(["inspect", dashboardId], "Inspecting the deployed dashboard"),
      "Dashboard inspection",
    )[0],
    endpoints,
    probes,
    origins,
  );
  validateWorkerInspection(
    parseJson(
      docker(["inspect", workerId], "Inspecting the deployed assistant-worker"),
      "Assistant-worker inspection",
    )[0],
    worker,
  );
  await probeBoth(origins, endpoints, probes, true);
}
async function main() {
  const mode = process.argv[2];
  if (
    process.argv.length > 3 ||
    (mode && !["--precutover", "--predeploy", "--postdeploy"].includes(mode))
  )
    fail(
      "Usage: deployment-preflight.mjs [--precutover|--predeploy|--postdeploy]",
    );
  verifyDockerContext();
  const configuration = composeConfig();
  if (configuration.name !== projectName)
    fail(`compose.yaml must use project name ${projectName}.`);
  const dashboard = configuration.services?.[dashboardServiceName];
  const worker = configuration.services?.[workerServiceName];
  if (!dashboard || !worker)
    fail("compose.yaml must define dashboard and assistant-worker services.");
  validateServiceShape(configuration, dashboard, worker);
  const policy = validatePolicy(configuration);
  const endpoints = validatePorts(dashboard, policy.lan);
  const origins = validateEnvironment(dashboard, endpoints);
  validateSecurityConfiguration(dashboardServiceName, dashboard);
  validateSecurityConfiguration(workerServiceName, worker);
  const probes = validateMountConfiguration(dashboard, policy.lan);
  const workerProbes = validateWorkerConfiguration(worker, probes.workerToken);
  validateFilesystemProbes(probes, policy.dataUuid);
  validateAuthDirectory(probes.auth);
  validateWorkerState(workerProbes);
  validateCertificate(probes.tls, origins.tsHostname, "Tailscale TLS");
  validateCertificate(probes.lanTls, policy.lan.address, "LAN TLS", true);
  validateSeparateStatePaths(probes, workerProbes);
  validateRuntimeAccess(probes, workerProbes);
  tailscaleStatus(endpoints.tailscale, origins.tsHostname);
  validateLanInterface(policy.lan);
  validateIngress(endpoints, policy.lan);
  validateHostSupport(probes.tls, origins.tsHostname);
  const own = inspectPortConflicts([endpoints.tailscale, endpoints.lan]);
  inspectNativeListeners([endpoints.tailscale, endpoints.lan], own);
  if (mode === "--precutover")
    await probeHttps("Tailscale", origins.tsOrigin, endpoints.tailscale);
  if (mode === "--predeploy")
    await probeBoth(origins, endpoints, probes, false);
  if (mode === "--postdeploy")
    await postDeployInspection(endpoints, probes, origins, workerProbes);
  console.log(
    mode === "--postdeploy"
      ? "Deployment post-deploy inspection passed."
      : mode === "--predeploy"
        ? "Deployment pre-deploy inspection passed."
        : mode === "--precutover"
          ? "Deployment pre-cutover inspection passed."
          : "Deployment preflight passed.",
  );
}
main().catch((error) => {
  console.error(`Deployment preflight failed: ${error.message}`);
  process.exitCode = 1;
});
