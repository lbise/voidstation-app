import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";

const workspaces: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

type Paths = Record<string, string>;
type Endpoint = { host: string; port: string };
type PreflightOptions = {
  dnsName?: string;
  san?: string;
  lanSan?: string;
  lanCertificateIsCa?: boolean;
  funnel?: boolean;
  ingressRule?: "missing" | "after-accept";
  ingressStateOrder?: "reversed";
  ingressCheck?: boolean;
  ipLinkKind?: string;
  forwardRule?: boolean;
  runtimeAccess?: boolean;
  bootProtection?: boolean;
  renewalTarget?: boolean;
  preDeploy?: boolean;
  preCutover?: boolean;
  postDeploy?: boolean;
  inspection?: (paths: Paths, endpoint: Endpoint) => Record<string, any>;
  workerInspection?: (paths: Paths) => Record<string, any>;
  setup?: (
    paths: Paths,
    workspace: string,
  ) => Promise<Record<string, string | undefined> | void>;
};

async function writeExecutable(path: string, source: string) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

function lockedDashboard(paths: Paths): Record<string, any> {
  return {
    name: "voidstation-app",
    "x-voidstation": {
      expected_data_filesystem_uuid: "data-uuid",
      lan_interface: "enp1s0",
      lan_source: "192.168.50.0/24",
      lan_bind_address: "192.168.50.10",
      lan_https_port: "3000",
      lan_tls_directory: paths.lanTls,
    },
    networks: {
      default: {
        name: "voidstation-app_default",
        driver: "bridge",
        driver_opts: { "com.docker.network.bridge.name": "br-voidstation" },
      },
    },
    services: {
      dashboard: {
        build: { context: process.cwd(), dockerfile: "Dockerfile" },
        command: null,
        entrypoint: null,
        networks: { default: null },
        restart: "unless-stopped",
        user: "1000:1000",
        ports: [
          {
            target: 3000,
            published: "8443",
            protocol: "tcp",
            mode: "ingress",
            host_ip: "100.101.102.103",
          },
          {
            target: 3443,
            published: "3000",
            protocol: "tcp",
            mode: "ingress",
            host_ip: "192.168.50.10",
          },
        ],
        environment: {
          HOSTNAME: "0.0.0.0",
          PORT: "3000",
          VOIDSTATION_ORIGIN: "https://voidstation.test-tailnet.ts.net:8443",
          VOIDSTATION_LAN_ORIGIN: "https://192.168.50.10:3000",
          VOIDSTATION_LAN_PORT: "3443",
          VOIDSTATION_LAN_TLS_CERT: "/run/voidstation-lan-tls/cert.pem",
          VOIDSTATION_LAN_TLS_KEY: "/run/voidstation-lan-tls/key.pem",
          VOIDSTATION_TLS_CERT: "/run/voidstation-tls/cert.pem",
          VOIDSTATION_TLS_KEY: "/run/voidstation-tls/key.pem",
          VOIDSTATION_AUTH_DB: "/var/lib/voidstation/auth.sqlite",
          VOIDSTATION_HOST_PROC: "/host/proc",
          VOIDSTATION_HOST_ROOT_FS: "/host/filesystems/root",
          VOIDSTATION_HOST_DATA_FS: "/host/filesystems/data",
          VOIDSTATION_WORKER_URL: "http://assistant-worker:3001",
          VOIDSTATION_WORKER_TOKEN_FILE: "/run/voidstation-worker/token",
        },
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        tmpfs: ["/tmp:size=16m,noexec,nosuid"],
        volumes: [
          bind("/proc/stat", "/host/proc/stat"),
          bind("/proc/uptime", "/host/proc/uptime"),
          bind("/proc/meminfo", "/host/proc/meminfo"),
          bind(paths.root, "/host/filesystems/root"),
          bind(paths.data, "/host/filesystems/data"),
          bind(paths.auth, "/var/lib/voidstation", false),
          bind(paths.tls, "/run/voidstation-tls"),
          bind(paths.lanTls, "/run/voidstation-lan-tls"),
          bind(paths.token, "/run/voidstation-worker/token"),
        ],
      },
      "assistant-worker": lockedWorker(paths),
    },
  };
}

function lockedWorker(paths: Paths): Record<string, any> {
  return {
    build: { context: `${process.cwd()}/worker`, dockerfile: "Dockerfile" },
    command: null,
    entrypoint: null,
    networks: { default: null },
    restart: "unless-stopped",
    user: "1000:1000",
    environment: {
      VOIDSTATION_WORKER_HOST: "0.0.0.0",
      VOIDSTATION_WORKER_PORT: "3001",
      VOIDSTATION_WORKER_TOKEN_FILE: "/run/voidstation-worker/token",
      VOIDSTATION_CONVERSATION_DIR: "/var/lib/voidstation/conversations",
      VOIDSTATION_CREDENTIAL_DIR: "/var/lib/voidstation/credentials",
    },
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    tmpfs: ["/tmp:size=16m,noexec,nosuid"],
    volumes: [
      bind(paths.token, "/run/voidstation-worker/token"),
      bind(paths.conversations, "/var/lib/voidstation/conversations", false),
      bind(paths.credentials, "/var/lib/voidstation/credentials", false),
    ],
  };
}

function bind(source: string, target: string, readOnly = true) {
  return {
    type: "bind",
    source,
    target,
    read_only: readOnly,
    bind: { create_host_path: false },
  };
}

function deployedWorker(paths: Paths): Record<string, any> {
  return {
    Config: {
      User: "1000:1000",
      Env: [
        "VOIDSTATION_WORKER_HOST=0.0.0.0",
        "VOIDSTATION_WORKER_PORT=3001",
        "VOIDSTATION_WORKER_TOKEN_FILE=/run/voidstation-worker/token",
        "VOIDSTATION_CONVERSATION_DIR=/var/lib/voidstation/conversations",
        "VOIDSTATION_CREDENTIAL_DIR=/var/lib/voidstation/credentials",
      ],
      Labels: {
        "com.docker.compose.project": "voidstation-app",
        "com.docker.compose.service": "assistant-worker",
      },
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16384k" },
      NetworkMode: "voidstation-app_default",
    },
    NetworkSettings: {
      Ports: { "3001/tcp": null },
      Networks: { "voidstation-app_default": {} },
    },
    Mounts: [
      {
        Type: "bind",
        Source: paths.token,
        Destination: "/run/voidstation-worker/token",
        RW: false,
      },
      {
        Type: "bind",
        Source: paths.conversations,
        Destination: "/var/lib/voidstation/conversations",
        RW: true,
      },
      {
        Type: "bind",
        Source: paths.credentials,
        Destination: "/var/lib/voidstation/credentials",
        RW: true,
      },
    ],
    State: { Running: true, Restarting: false },
  };
}

function deployedDashboard(
  paths: Paths,
  endpoint: Endpoint,
  lanEndpoint: Endpoint = { host: "192.168.50.10", port: "3000" },
): Record<string, any> {
  return {
    Config: {
      User: "1000:1000",
      Env: [
        `VOIDSTATION_ORIGIN=https://voidstation.test-tailnet.ts.net:${endpoint.port}`,
        "HOSTNAME=0.0.0.0",
        "PORT=3000",
        `VOIDSTATION_LAN_ORIGIN=https://${lanEndpoint.host}:${lanEndpoint.port}`,
        "VOIDSTATION_TLS_CERT=/run/voidstation-tls/cert.pem",
        "VOIDSTATION_TLS_KEY=/run/voidstation-tls/key.pem",
        "VOIDSTATION_LAN_PORT=3443",
        "VOIDSTATION_LAN_TLS_CERT=/run/voidstation-lan-tls/cert.pem",
        "VOIDSTATION_LAN_TLS_KEY=/run/voidstation-lan-tls/key.pem",
        "VOIDSTATION_AUTH_DB=/var/lib/voidstation/auth.sqlite",
        "VOIDSTATION_HOST_PROC=/host/proc",
        "VOIDSTATION_HOST_ROOT_FS=/host/filesystems/root",
        "VOIDSTATION_HOST_DATA_FS=/host/filesystems/data",
        "VOIDSTATION_WORKER_URL=http://assistant-worker:3001",
        "VOIDSTATION_WORKER_TOKEN_FILE=/run/voidstation-worker/token",
      ],
      Labels: {
        "com.docker.compose.project": "voidstation-app",
        "com.docker.compose.service": "dashboard",
      },
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16384k" },
      NetworkMode: "voidstation-app_default",
      PortBindings: {
        "3000/tcp": [{ HostIp: endpoint.host, HostPort: endpoint.port }],
        "3443/tcp": [{ HostIp: lanEndpoint.host, HostPort: lanEndpoint.port }],
      },
    },
    NetworkSettings: {
      Ports: {
        "3000/tcp": [{ HostIp: endpoint.host, HostPort: endpoint.port }],
        "3443/tcp": [{ HostIp: lanEndpoint.host, HostPort: lanEndpoint.port }],
      },
      Networks: { "voidstation-app_default": {} },
    },
    Mounts: [
      {
        Type: "bind",
        Source: "/proc/stat",
        Destination: "/host/proc/stat",
        RW: false,
      },
      {
        Type: "bind",
        Source: "/proc/uptime",
        Destination: "/host/proc/uptime",
        RW: false,
      },
      {
        Type: "bind",
        Source: "/proc/meminfo",
        Destination: "/host/proc/meminfo",
        RW: false,
      },
      {
        Type: "bind",
        Source: paths.root,
        Destination: "/host/filesystems/root",
        RW: false,
      },
      {
        Type: "bind",
        Source: paths.data,
        Destination: "/host/filesystems/data",
        RW: false,
      },
      {
        Type: "bind",
        Source: paths.auth,
        Destination: "/var/lib/voidstation",
        RW: true,
      },
      {
        Type: "bind",
        Source: paths.tls,
        Destination: "/run/voidstation-tls",
        RW: false,
      },
      {
        Type: "bind",
        Source: paths.lanTls,
        Destination: "/run/voidstation-lan-tls",
        RW: false,
      },
      {
        Type: "bind",
        Source: paths.token,
        Destination: "/run/voidstation-worker/token",
        RW: false,
      },
    ],
    State: { Running: true, Restarting: false },
  };
}

async function runPreflight(
  configuration: (paths: Paths) => object,
  options: PreflightOptions = {},
) {
  const workspace = await mkdtemp(join(tmpdir(), "voidstation-preflight-"));
  workspaces.push(workspace);
  const bin = join(workspace, "bin");
  const root = join(workspace, "root");
  const auth = join(workspace, "auth");
  const tls = join(workspace, "tls");
  const lanTls = join(workspace, "lan-tls");
  const token = join(workspace, "worker-token");
  const conversations = join(workspace, "conversations");
  const credentials = join(workspace, "credentials");
  const data = await mkdtemp(join("/dev/shm", "voidstation-preflight-data-"));
  workspaces.push(data);
  const paths = {
    root,
    data,
    auth,
    tls,
    lanTls,
    token,
    conversations,
    credentials,
  };
  await Promise.all([
    mkdir(bin),
    mkdir(root),
    mkdir(auth, { mode: 0o700 }),
    mkdir(tls, { mode: 0o700 }),
    mkdir(lanTls, { mode: 0o700 }),
    mkdir(conversations, { mode: 0o700 }),
    mkdir(credentials, { mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(auth, 0o700),
    chmod(tls, 0o700),
    chmod(lanTls, 0o700),
    chmod(conversations, 0o700),
    chmod(credentials, 0o700),
    writeFile(token, "a-worker-token-with-at-least-thirty-two-characters", {
      mode: 0o600,
    }),
  ]);
  await writeFile(join(tls, "cert.pem"), "fixture certificate\n");
  await writeFile(join(tls, "key.pem"), "fixture key\n", { mode: 0o600 });
  await writeFile(join(lanTls, "cert.pem"), "fixture certificate\n");
  await writeFile(join(lanTls, "key.pem"), "fixture key\n", { mode: 0o600 });
  await writeFile(join(lanTls, "ca.pem"), "fixture CA\n");
  await chmod(join(tls, "key.pem"), 0o600);
  await chmod(join(lanTls, "key.pem"), 0o600);

  const setupEnvironment = await options.setup?.(paths, workspace);
  const compose = configuration(paths) as Record<string, any>;
  const endpoint = {
    host: compose.services.dashboard.ports[0].host_ip,
    port: String(compose.services.dashboard.ports[0].published),
  };
  const lanEndpoint = {
    host: compose.services.dashboard.ports[1].host_ip,
    port: String(compose.services.dashboard.ports[1].published),
  };
  const inspection =
    options.inspection?.(paths, endpoint) ??
    deployedDashboard(paths, endpoint, lanEndpoint);
  await writeFile(join(workspace, "compose.json"), JSON.stringify(compose));
  await writeFile(
    join(workspace, "ingress.json"),
    JSON.stringify({
      lanInterface: compose["x-voidstation"].lan_interface,
      lanSource: compose["x-voidstation"].lan_source,
      lanAddress: compose["x-voidstation"].lan_bind_address,
      lanPort: Number(compose["x-voidstation"].lan_https_port),
      tailscaleAddress: endpoint.host,
      tailscalePort: Number(endpoint.port),
    }),
  );
  await writeFile(
    join(workspace, "inspect.json"),
    JSON.stringify([inspection]),
  );
  await writeFile(
    join(workspace, "worker-inspect.json"),
    JSON.stringify([
      options.workerInspection?.(paths) ?? deployedWorker(paths),
    ]),
  );
  await writeFile(
    join(workspace, "tailscale.json"),
    JSON.stringify({
      Self: {
        TailscaleIPs: ["100.101.102.103"],
        DNSName: options.dnsName ?? "voidstation.test-tailnet.ts.net.",
      },
    }),
  );
  await writeFile(
    join(workspace, "serve.json"),
    JSON.stringify({ AllowFunnel: options.funnel ? { "443": true } : {} }),
  );
  await writeFile(
    join(workspace, "san.txt"),
    options.san ?? "DNS:voidstation.test-tailnet.ts.net",
  );
  await writeFile(
    join(workspace, "lan-san.txt"),
    options.lanSan ?? "IP Address:192.168.50.10",
  );

  await writeExecutable(
    join(bin, "docker"),
    `#!/usr/bin/env sh
case "$1" in
  context) case "$2" in show) echo default ;; inspect) echo '{"Host":"unix:///var/run/docker.sock"}' ;; *) exit 2 ;; esac ;;
  compose) case "$4 $5 $6" in
    "config --format json") cat "$PREFLIGHT_COMPOSE" ;;
    "ps --quiet dashboard") if [ "$PREFLIGHT_POSTDEPLOY" = true ]; then echo dashboard-id; fi ;;
    "ps --quiet assistant-worker") if [ "$PREFLIGHT_POSTDEPLOY" = true ]; then echo worker-id; fi ;;
    *) exit 2 ;;
  esac ;;
  ps) [ "$2" = --quiet ] || exit 2; if [ "$PREFLIGHT_POSTDEPLOY" = true ]; then echo dashboard-id; fi ;;
  inspect) if [ "$2" = worker-id ]; then cat "$PREFLIGHT_WORKER_INSPECT"; else cat "$PREFLIGHT_INSPECT"; fi ;;
  *) exit 2 ;;
esac
`,
  );
  await writeExecutable(
    join(bin, "tailscale"),
    `#!/usr/bin/env sh
if [ "$1 $2 $3" = "status --json " ]; then cat "$PREFLIGHT_TAILSCALE"; elif [ "$1 $2 $3" = "serve status --json" ]; then cat "$PREFLIGHT_SERVE"; else exit 2; fi
`,
  );
  await writeExecutable(
    join(bin, "findmnt"),
    `#!/usr/bin/env sh
case "$*" in *"/dev/shm/"*) echo '{"filesystems":[{"target":"/dev/shm","uuid":"data-uuid"}]}' ;; *) echo '{"filesystems":[{"target":"/","uuid":"root-uuid"}]}' ;; esac
`,
  );
  await writeExecutable(join(bin, "ss"), "#!/usr/bin/env sh\nexit 0\n");
  await writeExecutable(
    join(bin, "ip"),
    `#!/usr/bin/env sh
if [ "$1" = -details ]; then
  echo '[{"ifname":"enp1s0","operstate":"UP","flags":["BROADCAST","MULTICAST","UP"],"linkinfo":{"info_kind":"${options.ipLinkKind ?? "ether"}"},"addr_info":[{"family":"inet","local":"192.168.50.10","prefixlen":24}]}]'
else
  echo '[{"ifname":"enp1s0","operstate":"UP","flags":["BROADCAST","MULTICAST","UP"],"addr_info":[{"family":"inet","local":"192.168.50.10","prefixlen":24}]}]'
fi
`,
  );
  await writeExecutable(
    join(bin, "stat"),
    '#!/usr/bin/env sh\nif [ "$1" = -c ] && [ "$2" = "%u:%g:%a" ]; then\n  shift 2\n  for path in "$@"; do\n    case "$path" in /etc) echo 0:0:755 ;; /etc/voidstation) echo 0:0:700 ;; /etc/voidstation/ingress.json) echo 0:0:600 ;; *) exit 2 ;; esac\n  done\n  exit 0\nfi\nexec /usr/bin/stat "$@"\n',
  );
  await writeExecutable(
    join(bin, "readlink"),
    '#!/usr/bin/env sh\n[ "$1" = -f ] && [ "$2" = /etc/voidstation/ingress.json ] && { echo /etc/voidstation/ingress.json; exit 0; }\nexec /usr/bin/readlink "$@"\n',
  );
  await writeExecutable(
    join(bin, "systemctl"),
    `#!/usr/bin/env sh
if [ "${options.bootProtection === false}" = true ]; then echo 'ActiveState=inactive'; exit 0; fi
case "$2" in
  voidstation-ingress.service) printf 'ActiveState=active\\nUnitFileState=enabled\\nBefore=docker.service\\nPartOf=docker.service\\nExecStart={ path=/usr/local/libexec/voidstation-ingress ; }\\n' ;;
  docker.service) echo 'voidstation-ingress.service containerd.service' ;;
  voidstation-certificate-renewal.timer) printf 'ActiveState=active\\nUnitFileState=enabled\\nUnit=voidstation-certificate-renewal.service\\n' ;;
  voidstation-certificate-renewal.service) printf 'Environment=PATH=/usr/bin VOIDSTATION_TLS_DIRECTORY=%s VOIDSTATION_HOSTNAME_FILE=/etc/voidstation/hostname\\nExecStart={ path=/usr/local/libexec/voidstation-renew-certificate ; }\\n' "${options.renewalTarget === false ? "/wrong" : "$PREFLIGHT_TLS"}" ;;
  *) exit 1 ;;
esac
`,
  );
  await writeExecutable(
    join(bin, "cat"),
    '#!/usr/bin/env sh\nif [ "$1" = /etc/voidstation/hostname ]; then echo voidstation.test-tailnet.ts.net; elif [ "$1" = /etc/voidstation/ingress.json ]; then exec /bin/cat "$PREFLIGHT_INGRESS"; else exec /bin/cat "$@"; fi\n',
  );
  await writeExecutable(
    join(bin, "sudo"),
    `#!/usr/bin/env sh
shift
if [ "$1" = /usr/local/libexec/voidstation-ingress ]; then
  [ "$2" = --check ] && [ "${options.ingressCheck === false ? "false" : "true"}" = true ]
  exit
fi
exec "$@"
`,
  );
  await writeExecutable(
    join(bin, "setpriv"),
    `#!/usr/bin/env sh
${options.runtimeAccess === false ? "exit 1" : 'shift 3; exec "$@"'}
`,
  );
  const dockerUserRules =
    options.ingressRule === "missing"
      ? ""
      : options.ingressRule === "after-accept"
        ? "echo '-A DOCKER-USER -j ACCEPT'; echo '-A DOCKER-USER -o br-voidstation -j VOIDSTATION'"
        : "echo '-A DOCKER-USER -o br-voidstation -j VOIDSTATION'";
  await writeExecutable(
    join(bin, "iptables"),
    `#!/usr/bin/env sh
case "$2" in
  FORWARD) ${options.forwardRule === false ? "echo '-A FORWARD -j ACCEPT'" : "echo '-A FORWARD -j DOCKER-USER'"} ;;
  DOCKER-USER) ${dockerUserRules} ;;
  VOIDSTATION)
    echo '-A VOIDSTATION -m conntrack --ctstate ${options.ingressStateOrder === "reversed" ? "ESTABLISHED,RELATED" : "RELATED,ESTABLISHED"} --ctdir REPLY -j RETURN'
    echo '-A VOIDSTATION -i br-voidstation -j RETURN'
    echo "-A VOIDSTATION -s 100.64.0.0/10 -i tailscale0 -p tcp -m tcp --dport 3000 -m conntrack --ctstate NEW,ESTABLISHED --ctorigdst 100.101.102.103 --ctorigdstport $PREFLIGHT_TS_PORT --ctdir ORIGINAL -j RETURN"
    echo "-A VOIDSTATION -s 192.168.50.0/24 -i enp1s0 -p tcp -m tcp --dport 3443 -m conntrack --ctstate NEW,ESTABLISHED --ctorigdst 192.168.50.10 --ctorigdstport $PREFLIGHT_LAN_PORT --ctdir ORIGINAL -j RETURN"
    echo '-A VOIDSTATION -j DROP' ;;
esac
`,
  );
  await writeExecutable(
    join(bin, "openssl"),
    `#!/usr/bin/env sh
case "$1" in
  x509) case " $* " in *" -pubkey "*) printf 'fixture-public-key\\n' ;; *" -fingerprint "*) case "$*" in *"/lan-tls/ca.pem"*) echo 'SHA256 Fingerprint=CA' ;; *) echo 'SHA256 Fingerprint=LEAF' ;; esac ;; *" -issuer -subject "*) case "$PREFLIGHT_LAN_SELF_SIGNED" in true) echo 'issuer=CN = LAN'; echo 'subject=CN = LAN' ;; *) echo 'issuer=CN = Voidstation test CA'; echo 'subject=CN = Voidstation LAN' ;; esac ;; *" -ext basicConstraints "*) case "$*" in *"/lan-tls/ca.pem"*) echo 'CA:TRUE' ;; *) case "$PREFLIGHT_LAN_CERTIFICATE_IS_CA" in true) echo 'CA:TRUE' ;; *) echo 'CA:FALSE' ;; esac ;; esac ;; *" -ext subjectAltName "*) printf 'X509v3 Subject Alternative Name: \\n    '; case "$*" in *"/lan-tls/"*) cat "$PREFLIGHT_LAN_SAN" ;; *) cat "$PREFLIGHT_SAN" ;; esac ;; esac ;;
  pkey) printf 'fixture-public-key\\n' ;;
esac
`,
  );

  // Hosted CI users need not have UID 1000. Substitute only ownership metadata
  // at the filesystem boundary; keep real modes, paths, files and devices.
  const ownership = join(workspace, "ownership.mjs");
  await writeFile(
    ownership,
    `import fs from 'node:fs';
const lstat = fs.lstatSync;
fs.lstatSync = function(file, ...args) {
  const stat = lstat.call(this, file, ...args);
  if (String(file).startsWith(${JSON.stringify(workspace + "/")})) Object.assign(stat, { uid: 1000, gid: 1000 });
  return stat;
};`,
  );
  const imports = ["--import", ownership];
  if (options.postDeploy || options.preDeploy || options.preCutover) {
    const redirect = join(workspace, "https-redirect.mjs");
    await writeFile(
      redirect,
      `import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const request = https.request;
https.request = function(input, options, callback) {
  const url = typeof input === "string" ? new URL(input) : input;
  const audit = { hostname: url.hostname, path: url.pathname, port: url.port, rejectUnauthorizedIsFalse: options?.rejectUnauthorized === false };
  let previous = [];
  try { previous = JSON.parse(readFileSync(process.env.PREFLIGHT_HTTPS_AUDIT, "utf8")); } catch { /* first probe */ }
  writeFileSync(process.env.PREFLIGHT_HTTPS_AUDIT, JSON.stringify([...previous, audit]));
  const target = new URL(url);
  const servername = url.hostname === "192.168.50.10" ? url.hostname : undefined;
  if (servername) target.hostname = "lan.fixture.invalid";
  const outgoing = request.call(this, target, { ...options, ...(servername ? { servername } : {}), lookup: (hostname, lookupOptions, done) => {
    options.lookup(hostname, lookupOptions, (error, address, family) => {
      if (lookupOptions.all && !Array.isArray(address)) {
        console.error("Lookup must honor Node's all-addresses contract");
        process.exit(91);
      }
      done(error, Array.isArray(address) ? address.map((entry) => ({ ...entry, address: "127.0.0.1" })) : "127.0.0.1", family);
    });
  } }, callback);
  return outgoing;
};
syncBuiltinESMExports();`,
    );
    imports.push("--import", redirect);
  }
  const audit = join(workspace, "https-audit.json");
  const child = spawn(
    process.execPath,
    [
      ...imports,
      "scripts/deployment-preflight.mjs",
      ...(options.preDeploy
        ? ["--predeploy"]
        : options.preCutover
          ? ["--precutover"]
          : options.postDeploy
            ? ["--postdeploy"]
            : []),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...setupEnvironment,
        PATH: `${bin}:${process.env.PATH}`,
        PREFLIGHT_COMPOSE: join(workspace, "compose.json"),
        PREFLIGHT_INGRESS: join(workspace, "ingress.json"),
        PREFLIGHT_TS_PORT: endpoint.port,
        PREFLIGHT_LAN_PORT: lanEndpoint.port,
        PREFLIGHT_TLS: tls,
        PREFLIGHT_INSPECT: join(workspace, "inspect.json"),
        PREFLIGHT_WORKER_INSPECT: join(workspace, "worker-inspect.json"),
        PREFLIGHT_TAILSCALE: join(workspace, "tailscale.json"),
        PREFLIGHT_SERVE: join(workspace, "serve.json"),
        PREFLIGHT_SAN: join(workspace, "san.txt"),
        PREFLIGHT_LAN_SAN: join(workspace, "lan-san.txt"),
        PREFLIGHT_LAN_CERTIFICATE_IS_CA: String(options.lanCertificateIsCa),
        PREFLIGHT_LAN_SELF_SIGNED: "false",
        PREFLIGHT_POSTDEPLOY: String(options.postDeploy),
        PREFLIGHT_HTTPS_AUDIT: audit,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = await new Promise<string>((resolve, reject) => {
    let result = "";
    child.stdout.on("data", (chunk) => {
      result += chunk;
    });
    child.stderr.on("data", (chunk) => {
      result += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(`${code}\n${result}`));
  });
  return { output, audit };
}

function generateFixtureCa(workspace: string, tls: string, hostname: string) {
  const ca = join(workspace, "fixture-ca.pem");
  const caKey = join(workspace, "fixture-ca-key.pem");
  const key = join(tls, "key.pem");
  const certificate = join(tls, "cert.pem");
  const request = join(workspace, "server.csr");
  const extensions = join(workspace, "server.ext");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      ca,
      "-subj",
      "/CN=Voidstation test CA",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      request,
      "-subj",
      `/CN=${hostname}`,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      request,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      certificate,
      "-days",
      "1",
      "-extfile",
      extensions,
    ],
    { stdio: "ignore" },
  );
  return { ca, certificate, key, extensions };
}

async function startFixtureHttpsServer(paths: Paths, workspace: string) {
  const hostname = "voidstation.test-tailnet.ts.net";
  const fixture = {
    ca: join(workspace, "fixture-ca.pem"),
    certificate: join(paths.tls, "cert.pem"),
    key: join(paths.tls, "key.pem"),
    extensions: join(workspace, "server.ext"),
  };
  await writeFile(
    fixture.extensions,
    `subjectAltName=DNS:${hostname},IP:192.168.50.10\n`,
  );
  generateFixtureCa(workspace, paths.tls, hostname);
  await writeFile(join(paths.lanTls, "ca.pem"), readFileSync(fixture.ca));
  const server = createServer(
    { key: readFileSync(fixture.key), cert: readFileSync(fixture.certificate) },
    (request, response) => {
      if (request.url === "/login") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("Sign in");
        return;
      }
      response.writeHead(404);
      response.end();
    },
  );
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    ca: fixture.ca,
    port: String((server.address() as AddressInfo).port),
  };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

it("accepts the locked-down LAN and Tailscale TLS deployment through its CLI", async () => {
  expect((await runPreflight(lockedDashboard)).output).toContain(
    "0\nDeployment preflight passed.",
  );
});

it("rejects a Docker ingress rule that is not first in DOCKER-USER", async () => {
  expect(
    (await runPreflight(lockedDashboard, { ingressRule: "after-accept" }))
      .output,
  ).toContain("Docker ingress rule");
});

it("rejects a FORWARD chain that does not first jump to DOCKER-USER", async () => {
  expect(
    (await runPreflight(lockedDashboard, { forwardRule: false })).output,
  ).toContain("Docker ingress rule");
});

it("rejects inputs unreadable by the runtime UID even when the invoking user can read them", async () => {
  expect(
    (await runPreflight(lockedDashboard, { runtimeAccess: false })).output,
  ).toContain("UID/GID 1000");
});

it("rejects a LAN address in place of the configured Tailscale publication", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.dashboard.ports[0].host_ip = "192.168.1.10";
    return configuration;
  });
  expect(result.output).toContain(
    "must publish the configured Tailscale TLS binding only",
  );
});

it("rejects a LAN source that does not contain its bind address", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration["x-voidstation"].lan_source = "192.168.51.0/24";
    return configuration;
  });
  expect(result.output).toContain(
    "VOIDSTATION_LAN_SOURCE must contain VOIDSTATION_LAN_BIND_ADDRESS",
  );
});

it("rejects a LAN TLS directory containing a CA signing key", async () => {
  const result = await runPreflight(lockedDashboard, {
    setup: async (paths) => {
      await writeFile(join(paths.lanTls, "ca-key.pem"), "private key");
    },
  });
  expect(result.output).toContain("must not contain a CA signing private key");
});

it("rejects a trust-anchor file that contains private key material", async () => {
  const result = await runPreflight(lockedDashboard, {
    setup: async (paths) => {
      await writeFile(
        join(paths.lanTls, "ca.pem"),
        "-----BEGIN PRIVATE KEY-----\nsecret",
      );
    },
  });
  expect(result.output).toContain("trust anchor must not contain private keys");
});

it("rejects a LAN certificate SAN that only contains the configured IP as a substring", async () => {
  const result = await runPreflight(lockedDashboard, {
    lanSan: "IP Address:192.168.50.100",
  });
  expect(result.output).toContain(
    "LAN TLS certificate SAN does not contain 192.168.50.10",
  );
});

it("rejects a CA-capable LAN leaf certificate", async () => {
  const result = await runPreflight(lockedDashboard, {
    lanCertificateIsCa: true,
  });
  expect(result.output).toContain(
    "LAN TLS certificate must not be a CA certificate",
  );
});

it("rejects a Tailscale SAN that merely extends the configured hostname", async () => {
  const result = await runPreflight(lockedDashboard, {
    san: "DNS:voidstation.test-tailnet.ts.net.evil",
  });
  expect(result.output).toContain(
    "does not contain voidstation.test-tailnet.ts.net",
  );
});

it("rejects a virtual interface even when its name resembles a physical NIC", async () => {
  const result = await runPreflight(lockedDashboard, { ipLinkKind: "bridge" });
  expect(result.output).toContain("not an active physical LAN interface");
});

it("accepts iptables conntrack states in kernel-normalized order", async () => {
  expect(
    (await runPreflight(lockedDashboard, { ingressStateOrder: "reversed" }))
      .output,
  ).toContain("Deployment preflight passed.");
});

it("rejects an RFC1918 source CIDR whose broadcast escapes RFC1918", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration["x-voidstation"].lan_source = "192.168.0.0/15";
    return configuration;
  });
  expect(result.output).toContain("must be a canonical RFC1918 IPv4 CIDR");
});

it("rejects an installed ingress helper that fails its own check", async () => {
  const result = await runPreflight(lockedDashboard, { ingressCheck: false });
  expect(result.output).toContain(
    "Checking installed Voidstation ingress policy failed",
  );
});

it("rejects auth and conversation state sharing one directory", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services["assistant-worker"].volumes[1].source = paths.auth;
    return configuration;
  });
  expect(result.output).toContain("must use separate paths");
});

it("names both failed HTTPS paths in a pre-deployment probe error", async () => {
  const result = await runPreflight(lockedDashboard, { preDeploy: true });
  expect(result.output).toMatch(/^1\n/);
  expect(result.output).toContain("Tailscale");
  expect(result.output).toContain("LAN");
});

it("checks the existing Tailscale login before an initial LAN cutover", async () => {
  const result = await runPreflight(lockedDashboard, { preCutover: true });
  expect(result.output).toMatch(/^1\n/);
  expect(result.output).toContain("Tailscale");
  expect(result.output).not.toContain("LAN:");
});

it("rejects an additional service", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.worker = { image: "busybox" };
    return configuration;
  });
  expect(result.output).toContain(
    "must define exactly dashboard and assistant-worker services",
  );
});

it("rejects a worker host port publication", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services["assistant-worker"].ports = [
      {
        target: 3001,
        published: "3001",
        protocol: "tcp",
        mode: "ingress",
        host_ip: "127.0.0.1",
      },
    ];
    return configuration;
  });
  expect(result.output).toContain(
    "assistant-worker must not publish a host port",
  );
});

it("rejects worker credentials that share conversation storage", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services["assistant-worker"].volumes[2].source =
      paths.conversations;
    return configuration;
  });
  expect(result.output).toContain(
    "conversation and credential storage must use separate host directories",
  );
});

it("rejects a worker token shorter than 32 characters", async () => {
  const result = await runPreflight(lockedDashboard, {
    setup: async (paths) => {
      await writeFile(paths.token, "too-short", { mode: 0o600 });
    },
  });
  expect(result.output).toContain(
    "must contain at least 32 non-whitespace characters",
  );
});

it("rejects a dashboard command override", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.dashboard.command = ["node", "other-server.js"];
    return configuration;
  });
  expect(result.output).toContain(
    "command and entrypoint must use the image defaults",
  );
});

it("rejects an added capability", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.dashboard.cap_add = ["NET_ADMIN"];
    return configuration;
  });
  expect(result.output).toContain("dashboard.cap_add is not allowed");
});

it("rejects an auth database environment override", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.dashboard.environment.VOIDSTATION_AUTH_DB =
      "/tmp/auth.sqlite";
    return configuration;
  });
  expect(result.output).toContain(
    "VOIDSTATION_AUTH_DB must be /var/lib/voidstation/auth.sqlite",
  );
});

it("rejects a replacement Dockerfile", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.dashboard.build.dockerfile = "OtherDockerfile";
    return configuration;
  });
  expect(result.output).toContain(
    "must build this repository's default Dockerfile",
  );
});

it("rejects an external network", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.networks.default = { external: true, name: "shared" };
    return configuration;
  });
  expect(result.output).toContain(
    "must use the dedicated default bridge network",
  );
});

it("rejects a bridge other than br-voidstation", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.networks.default.driver_opts[
      "com.docker.network.bridge.name"
    ] = "br-shared";
    return configuration;
  });
  expect(result.output).toContain(
    "must use the dedicated default bridge network",
  );
});

it("rejects a noncanonical origin", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.dashboard.environment.VOIDSTATION_ORIGIN += "/";
    return configuration;
  });
  expect(result.output).toContain("must be a canonical HTTPS origin");
});

it("rejects a hostname that does not match this server's Tailscale DNS name", async () => {
  expect(
    (
      await runPreflight(lockedDashboard, {
        dnsName: "other.test-tailnet.ts.net.",
      })
    ).output,
  ).toContain("does not match this server's Tailscale DNS name");
});

it("rejects a certificate without the origin hostname", async () => {
  expect(
    (
      await runPreflight(lockedDashboard, {
        san: "DNS:other.test-tailnet.ts.net",
      })
    ).output,
  ).toContain("does not contain voidstation.test-tailnet.ts.net");
});

it("rejects Tailscale Funnel", async () => {
  expect(
    (await runPreflight(lockedDashboard, { funnel: true })).output,
  ).toContain("Tailscale Funnel is enabled");
});

it("rejects deployment without an active persistent ingress dependency and certificate renewal timer", async () => {
  expect(
    (await runPreflight(lockedDashboard, { bootProtection: false })).output,
  ).toContain("persistent ingress protection");
});

it("rejects a renewal service that would update a different certificate directory", async () => {
  expect(
    (await runPreflight(lockedDashboard, { renewalTarget: false })).output,
  ).toContain("renewal configuration must match");
});

it("accepts a healthy deployed dashboard and a certificate-verified HTTPS login response", async () => {
  let fixture: { ca: string; port: string } | undefined;
  const result = await runPreflight(
    (paths) => {
      const configuration = lockedDashboard(paths);
      configuration.services.dashboard.ports[0].published = fixture!.port;
      configuration.services.dashboard.ports[1].published = fixture!.port;
      configuration["x-voidstation"].lan_https_port = fixture!.port;
      configuration.services.dashboard.environment.VOIDSTATION_ORIGIN = `https://voidstation.test-tailnet.ts.net:${fixture!.port}`;
      configuration.services.dashboard.environment.VOIDSTATION_LAN_ORIGIN = `https://192.168.50.10:${fixture!.port}`;
      return configuration;
    },
    {
      postDeploy: true,
      setup: async (paths, workspace) => {
        fixture = await startFixtureHttpsServer(paths, workspace);
        return { NODE_EXTRA_CA_CERTS: fixture.ca };
      },
    },
  );
  expect(result.output).toContain("Deployment post-deploy inspection passed.");
  expect(JSON.parse(readFileSync(result.audit, "utf8"))).toEqual([
    {
      hostname: "voidstation.test-tailnet.ts.net",
      path: "/login",
      port: fixture!.port,
      rejectUnauthorizedIsFalse: false,
    },
    {
      hostname: "192.168.50.10",
      path: "/login",
      port: fixture!.port,
      rejectUnauthorizedIsFalse: false,
    },
  ]);
});

it("rejects a published worker port after deployment", async () => {
  const result = await runPreflight(lockedDashboard, {
    postDeploy: true,
    workerInspection: (paths) => {
      const inspection = deployedWorker(paths);
      inspection.NetworkSettings.Ports["3001/tcp"] = [
        { HostIp: "127.0.0.1", HostPort: "3001" },
      ];
      return inspection;
    },
  });
  expect(result.output).toContain(
    "assistant-worker has a host port publication",
  );
});

it("rejects an extra post-deploy port publication", async () => {
  const result = await runPreflight(lockedDashboard, {
    postDeploy: true,
    inspection: (paths, endpoint) => {
      const inspection = deployedDashboard(paths, endpoint);
      inspection.NetworkSettings.Ports["8080/tcp"] = [
        { HostIp: endpoint.host, HostPort: "8080" },
      ];
      return inspection;
    },
  });
  expect(result.output).toContain(
    "must have exactly the configured Tailscale and LAN publications",
  );
});

it("rejects a LAN publication missing from actual HostConfig", async () => {
  const result = await runPreflight(lockedDashboard, {
    postDeploy: true,
    inspection: (paths, endpoint) => {
      const inspection = deployedDashboard(paths, endpoint);
      delete inspection.HostConfig.PortBindings["3443/tcp"];
      return inspection;
    },
  });
  expect(result.output).toContain(
    "must have exactly the configured Tailscale and LAN publications",
  );
});

it("rejects a privileged dashboard after deployment", async () => {
  const result = await runPreflight(lockedDashboard, {
    postDeploy: true,
    inspection: (paths, endpoint) => {
      const inspection = deployedDashboard(paths, endpoint);
      inspection.HostConfig.Privileged = true;
      return inspection;
    },
  });
  expect(result.output).toContain("dashboard security settings changed");
});

it("rejects NODE_OPTIONS injected into the deployed dashboard", async () => {
  const result = await runPreflight(lockedDashboard, {
    postDeploy: true,
    inspection: (paths, endpoint) => {
      const inspection = deployedDashboard(paths, endpoint);
      inspection.Config.Env.push("NODE_OPTIONS=--require=/tmp/unsafe.js");
      return inspection;
    },
  });
  expect(result.output).toContain("unapproved runtime environment variable");
});

it("rejects a capability added to the deployed dashboard", async () => {
  const result = await runPreflight(lockedDashboard, {
    postDeploy: true,
    inspection: (paths, endpoint) => {
      const inspection = deployedDashboard(paths, endpoint);
      inspection.HostConfig.CapAdd = ["NET_ADMIN"];
      return inspection;
    },
  });
  expect(result.output).toContain("dashboard security settings changed");
});
