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
  funnel?: boolean;
  ingressRule?: "missing" | "after-accept";
  forwardRule?: boolean;
  runtimeAccess?: boolean;
  bootProtection?: boolean;
  renewalTarget?: boolean;
  postDeploy?: boolean;
  inspection?: (paths: Paths, endpoint: Endpoint) => Record<string, any>;
  setup?: (paths: Paths, workspace: string) => Promise<Record<string, string | undefined> | void>;
};

async function writeExecutable(path: string, source: string) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

function lockedDashboard(paths: Paths): Record<string, any> {
  return {
    name: "voidstation-app",
    "x-voidstation": { expected_data_filesystem_uuid: "data-uuid" },
    networks: { default: { name: "voidstation-app_default", driver: "bridge", driver_opts: { "com.docker.network.bridge.name": "br-voidstation" } } },
    services: {
      dashboard: {
        build: { context: process.cwd(), dockerfile: "Dockerfile" },
        command: null,
        entrypoint: null,
        networks: { default: null },
        restart: "unless-stopped",
        user: "1000:1000",
        ports: [{ target: 3000, published: "8443", protocol: "tcp", mode: "ingress", host_ip: "100.101.102.103" }],
        environment: {
          HOSTNAME: "0.0.0.0",
          PORT: "3000",
          VOIDSTATION_ORIGIN: "https://voidstation.test-tailnet.ts.net:8443",
          VOIDSTATION_TLS_CERT: "/run/voidstation-tls/cert.pem",
          VOIDSTATION_TLS_KEY: "/run/voidstation-tls/key.pem",
          VOIDSTATION_AUTH_DB: "/var/lib/voidstation/auth.sqlite",
          VOIDSTATION_HOST_PROC: "/host/proc",
          VOIDSTATION_HOST_ROOT_FS: "/host/filesystems/root",
          VOIDSTATION_HOST_DATA_FS: "/host/filesystems/data",
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
        ],
      },
    },
  };
}

function bind(source: string, target: string, readOnly = true) {
  return { type: "bind", source, target, read_only: readOnly, bind: { create_host_path: false } };
}

function deployedDashboard(paths: Paths, endpoint: Endpoint): Record<string, any> {
  return {
    Config: {
      User: "1000:1000",
      Labels: { "com.docker.compose.project": "voidstation-app", "com.docker.compose.service": "dashboard" },
    },
    HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] },
    NetworkSettings: { Ports: { "3000/tcp": [{ HostIp: endpoint.host, HostPort: endpoint.port }] } },
    Mounts: [
      { Type: "bind", Source: "/proc/stat", Destination: "/host/proc/stat", RW: false },
      { Type: "bind", Source: "/proc/uptime", Destination: "/host/proc/uptime", RW: false },
      { Type: "bind", Source: "/proc/meminfo", Destination: "/host/proc/meminfo", RW: false },
      { Type: "bind", Source: paths.root, Destination: "/host/filesystems/root", RW: false },
      { Type: "bind", Source: paths.data, Destination: "/host/filesystems/data", RW: false },
      { Type: "bind", Source: paths.auth, Destination: "/var/lib/voidstation", RW: true },
      { Type: "bind", Source: paths.tls, Destination: "/run/voidstation-tls", RW: false },
    ],
    State: { Running: true, Restarting: false },
  };
}

async function runPreflight(configuration: (paths: Paths) => object, options: PreflightOptions = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "voidstation-preflight-"));
  workspaces.push(workspace);
  const bin = join(workspace, "bin");
  const root = join(workspace, "root");
  const auth = join(workspace, "auth");
  const tls = join(workspace, "tls");
  const data = await mkdtemp(join("/dev/shm", "voidstation-preflight-data-"));
  workspaces.push(data);
  const paths = { root, data, auth, tls };
  await Promise.all([mkdir(bin), mkdir(root), mkdir(auth, { mode: 0o700 }), mkdir(tls, { mode: 0o700 })]);
  await chmod(auth, 0o700);
  await chmod(tls, 0o700);
  await writeFile(join(tls, "cert.pem"), "fixture certificate\n");
  await writeFile(join(tls, "key.pem"), "fixture key\n", { mode: 0o600 });
  await chmod(join(tls, "key.pem"), 0o600);

  const setupEnvironment = await options.setup?.(paths, workspace);
  const compose = configuration(paths) as Record<string, any>;
  const endpoint = {
    host: compose.services.dashboard.ports[0].host_ip,
    port: String(compose.services.dashboard.ports[0].published),
  };
  const inspection = options.inspection?.(paths, endpoint) ?? deployedDashboard(paths, endpoint);
  await writeFile(join(workspace, "compose.json"), JSON.stringify(compose));
  await writeFile(join(workspace, "inspect.json"), JSON.stringify([inspection]));
  await writeFile(join(workspace, "tailscale.json"), JSON.stringify({
    Self: { TailscaleIPs: ["100.101.102.103"], DNSName: options.dnsName ?? "voidstation.test-tailnet.ts.net." },
  }));
  await writeFile(join(workspace, "serve.json"), JSON.stringify({ AllowFunnel: options.funnel ? { "443": true } : {} }));
  await writeFile(join(workspace, "san.txt"), options.san ?? "DNS:voidstation.test-tailnet.ts.net");

  await writeExecutable(join(bin, "docker"), `#!/usr/bin/env sh
case "$1" in
  context) case "$2" in show) echo default ;; inspect) echo '{"Host":"unix:///var/run/docker.sock"}' ;; *) exit 2 ;; esac ;;
  compose) case "$4 $5 $6" in
    "config --format json") cat "$PREFLIGHT_COMPOSE" ;;
    "ps --quiet dashboard") if [ "$PREFLIGHT_POSTDEPLOY" = true ]; then echo dashboard-id; fi ;;
    *) exit 2 ;;
  esac ;;
  ps) [ "$2" = --quiet ] || exit 2; if [ "$PREFLIGHT_POSTDEPLOY" = true ]; then echo dashboard-id; fi ;;
  inspect) cat "$PREFLIGHT_INSPECT" ;;
  *) exit 2 ;;
esac
`);
  await writeExecutable(join(bin, "tailscale"), `#!/usr/bin/env sh
if [ "$1 $2 $3" = "status --json " ]; then cat "$PREFLIGHT_TAILSCALE"; elif [ "$1 $2 $3" = "serve status --json" ]; then cat "$PREFLIGHT_SERVE"; else exit 2; fi
`);
  await writeExecutable(join(bin, "findmnt"), `#!/usr/bin/env sh
case "$*" in *"/dev/shm/"*) echo '{"filesystems":[{"target":"/dev/shm","uuid":"data-uuid"}]}' ;; *) echo '{"filesystems":[{"target":"/","uuid":"root-uuid"}]}' ;; esac
`);
  await writeExecutable(join(bin, "ss"), "#!/usr/bin/env sh\nexit 0\n");
  await writeExecutable(join(bin, "systemctl"), `#!/usr/bin/env sh
if [ "${options.bootProtection === false}" = true ]; then echo 'ActiveState=inactive'; exit 0; fi
case "$2" in
  voidstation-ingress.service) printf 'ActiveState=active\\nUnitFileState=enabled\\nBefore=docker.service\\nPartOf=docker.service\\nExecStart={ path=/usr/local/libexec/voidstation-ingress ; }\\n' ;;
  docker.service) echo 'voidstation-ingress.service containerd.service' ;;
  voidstation-certificate-renewal.timer) printf 'ActiveState=active\\nUnitFileState=enabled\\nUnit=voidstation-certificate-renewal.service\\n' ;;
  voidstation-certificate-renewal.service) printf 'Environment=PATH=/usr/bin VOIDSTATION_TLS_DIRECTORY=%s VOIDSTATION_HOSTNAME_FILE=/etc/voidstation/hostname\\nExecStart={ path=/usr/local/libexec/voidstation-renew-certificate ; }\\n' "${options.renewalTarget === false ? "/wrong" : "$PREFLIGHT_TLS"}" ;;
  *) exit 1 ;;
esac
`);
  await writeExecutable(join(bin, "cat"), '#!/usr/bin/env sh\nif [ "$1" = /etc/voidstation/hostname ]; then echo voidstation.test-tailnet.ts.net; else exec /bin/cat "$@"; fi\n');
  await writeExecutable(join(bin, "sudo"), "#!/usr/bin/env sh\nshift\nexec \"$@\"\n");
  await writeExecutable(join(bin, "setpriv"), `#!/usr/bin/env sh
${options.runtimeAccess === false ? "exit 1" : "shift 3; exec \"$@\""}
`);
  const dockerUserRules = options.ingressRule === "missing" ? "" : options.ingressRule === "after-accept"
    ? "echo '-A DOCKER-USER -j ACCEPT'; echo '-A DOCKER-USER ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP'"
    : "echo '-A DOCKER-USER ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP'";
  await writeExecutable(join(bin, "iptables"), `#!/usr/bin/env sh
if [ "$2" = FORWARD ]; then
  ${options.forwardRule === false ? "echo '-A FORWARD -j ACCEPT'" : "echo '-A FORWARD -j DOCKER-USER'"}
else
  ${dockerUserRules}
fi
`);
  await writeExecutable(join(bin, "openssl"), `#!/usr/bin/env sh
case "$1" in
  x509) case " $* " in *" -pubkey "*) printf 'fixture-public-key\\n' ;; *" -ext subjectAltName "*) printf 'X509v3 Subject Alternative Name: \\n    ' && cat "$PREFLIGHT_SAN" ;; esac ;;
  pkey) printf 'fixture-public-key\\n' ;;
esac
`);

  // Hosted CI users need not have UID 1000. Substitute only ownership metadata
  // at the filesystem boundary; keep real modes, paths, files and devices.
  const ownership = join(workspace, "ownership.mjs");
  await writeFile(ownership, `import fs from 'node:fs';
const lstat = fs.lstatSync;
fs.lstatSync = function(file, ...args) {
  const stat = lstat.call(this, file, ...args);
  if (String(file).startsWith(${JSON.stringify(workspace + "/")})) Object.assign(stat, { uid: 1000, gid: 1000 });
  return stat;
};`);
  const imports = ["--import", ownership];
  if (options.postDeploy) {
    const redirect = join(workspace, "https-redirect.mjs");
    await writeFile(redirect, `import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
const request = https.request;
https.request = function(input, options, callback) {
  const url = typeof input === "string" ? new URL(input) : input;
  writeFileSync(process.env.PREFLIGHT_HTTPS_AUDIT, JSON.stringify({ hostname: url.hostname, path: url.pathname, port: url.port, rejectUnauthorizedIsFalse: options?.rejectUnauthorized === false }));
  const outgoing = request.call(this, input, { ...options, lookup: (hostname, lookupOptions, done) => {
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
syncBuiltinESMExports();`);
    imports.push("--import", redirect);
  }
  const audit = join(workspace, "https-audit.json");
  const child = spawn(process.execPath, [...imports, "scripts/deployment-preflight.mjs", ...(options.postDeploy ? ["--postdeploy"] : [])], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...setupEnvironment,
      PATH: `${bin}:${process.env.PATH}`,
      PREFLIGHT_COMPOSE: join(workspace, "compose.json"),
      PREFLIGHT_TLS: tls,
      PREFLIGHT_INSPECT: join(workspace, "inspect.json"),
      PREFLIGHT_TAILSCALE: join(workspace, "tailscale.json"),
      PREFLIGHT_SERVE: join(workspace, "serve.json"),
      PREFLIGHT_SAN: join(workspace, "san.txt"),
      PREFLIGHT_POSTDEPLOY: String(options.postDeploy),
      PREFLIGHT_HTTPS_AUDIT: audit,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await new Promise<string>((resolve, reject) => {
    let result = "";
    child.stdout.on("data", (chunk) => { result += chunk; });
    child.stderr.on("data", (chunk) => { result += chunk; });
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
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-subj", "/CN=Voidstation test CA", "-days", "1"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", request, "-subj", `/CN=${hostname}`], { stdio: "ignore" });
  execFileSync("openssl", ["x509", "-req", "-in", request, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", certificate, "-days", "1", "-extfile", extensions], { stdio: "ignore" });
  return { ca, certificate, key, extensions };
}

async function startFixtureHttpsServer(paths: Paths, workspace: string) {
  const hostname = "voidstation.test-tailnet.ts.net";
  const fixture = { ca: join(workspace, "fixture-ca.pem"), certificate: join(paths.tls, "cert.pem"), key: join(paths.tls, "key.pem"), extensions: join(workspace, "server.ext") };
  await writeFile(fixture.extensions, `subjectAltName=DNS:${hostname}\n`);
  generateFixtureCa(workspace, paths.tls, hostname);
  const server = createServer({ key: readFileSync(fixture.key), cert: readFileSync(fixture.certificate) }, (request, response) => {
    if (request.url === "/login") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Sign in");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { ca: fixture.ca, port: String((server.address() as AddressInfo).port) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

it("accepts the locked-down direct Tailscale TLS deployment through its CLI", async () => {
  expect((await runPreflight(lockedDashboard)).output).toContain("0\nDeployment preflight passed.");
});

it("rejects a Docker ingress rule that is not first in DOCKER-USER", async () => {
  expect((await runPreflight(lockedDashboard, { ingressRule: "after-accept" })).output).toContain("Docker ingress rule");
});

it("rejects a FORWARD chain that does not first jump to DOCKER-USER", async () => {
  expect((await runPreflight(lockedDashboard, { forwardRule: false })).output).toContain("Docker ingress rule");
});

it("rejects inputs unreadable by the runtime UID even when the invoking user can read them", async () => {
  expect((await runPreflight(lockedDashboard, { runtimeAccess: false })).output).toContain("UID/GID 1000");
});

it("rejects a LAN publication", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.dashboard.ports[0].host_ip = "192.168.1.10";
    return configuration;
  });
  expect(result.output).toContain("must publish only one 100.64.0.0/10 Tailscale CGNAT binding");
});

it("rejects an additional service", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.worker = { image: "busybox" };
    return configuration;
  });
  expect(result.output).toContain("must define exactly one dashboard service");
});

it("rejects a dashboard command override", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.dashboard.command = ["node", "other-server.js"];
    return configuration;
  });
  expect(result.output).toContain("command and entrypoint must use the image defaults");
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
    configuration.services.dashboard.environment.VOIDSTATION_AUTH_DB = "/tmp/auth.sqlite";
    return configuration;
  });
  expect(result.output).toContain("VOIDSTATION_AUTH_DB must be /var/lib/voidstation/auth.sqlite");
});

it("rejects a replacement Dockerfile", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.dashboard.build.dockerfile = "OtherDockerfile";
    return configuration;
  });
  expect(result.output).toContain("must build this repository's default Dockerfile");
});

it("rejects an external network", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.networks.default = { external: true, name: "shared" };
    return configuration;
  });
  expect(result.output).toContain("must use the dedicated default bridge network");
});

it("rejects a bridge other than br-voidstation", async () => {
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.networks.default.driver_opts["com.docker.network.bridge.name"] = "br-shared";
    return configuration;
  });
  expect(result.output).toContain("must use the dedicated default bridge network");
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
  expect((await runPreflight(lockedDashboard, { dnsName: "other.test-tailnet.ts.net." })).output).toContain("does not match this server's Tailscale DNS name");
});

it("rejects a certificate without the origin hostname", async () => {
  expect((await runPreflight(lockedDashboard, { san: "DNS:other.test-tailnet.ts.net" })).output).toContain("does not contain voidstation.test-tailnet.ts.net");
});

it("rejects Tailscale Funnel", async () => {
  expect((await runPreflight(lockedDashboard, { funnel: true })).output).toContain("Tailscale Funnel is enabled");
});

it("rejects deployment without an active persistent ingress dependency and certificate renewal timer", async () => {
  expect((await runPreflight(lockedDashboard, { bootProtection: false })).output).toContain("persistent ingress protection");
});

it("rejects a renewal service that would update a different certificate directory", async () => {
  expect((await runPreflight(lockedDashboard, { renewalTarget: false })).output).toContain("renewal configuration must match");
});

it("accepts a healthy deployed dashboard and a certificate-verified HTTPS login response", async () => {
  let fixture: { ca: string; port: string } | undefined;
  const result = await runPreflight((paths) => {
    const configuration = lockedDashboard(paths);
    configuration.services.dashboard.ports[0].published = fixture!.port;
    configuration.services.dashboard.environment.VOIDSTATION_ORIGIN = `https://voidstation.test-tailnet.ts.net:${fixture!.port}`;
    return configuration;
  }, {
    postDeploy: true,
    setup: async (paths, workspace) => {
      fixture = await startFixtureHttpsServer(paths, workspace);
      return { NODE_EXTRA_CA_CERTS: fixture.ca };
    },
  });
  expect(result.output).toContain("0\nDeployment post-deploy inspection passed.");
  expect(JSON.parse(readFileSync(result.audit, "utf8"))).toEqual({
    hostname: "voidstation.test-tailnet.ts.net",
    path: "/login",
    port: fixture!.port,
    rejectUnauthorizedIsFalse: false,
  });
});

it("rejects an extra post-deploy port publication", async () => {
  const result = await runPreflight(lockedDashboard, {
    postDeploy: true,
    inspection: (paths, endpoint) => {
      const inspection = deployedDashboard(paths, endpoint);
      inspection.NetworkSettings.Ports["8080/tcp"] = [{ HostIp: endpoint.host, HostPort: "8080" }];
      return inspection;
    },
  });
  expect(result.output).toContain("The deployed dashboard has an extra publication");
});
