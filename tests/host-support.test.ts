import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const workspaces: string[] = [];

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "voidstation-host-support-"));
  workspaces.push(directory);
  const bin = join(directory, "bin");
  await mkdir(bin);
  return { directory, bin, log: join(directory, "commands.log") };
}

async function fake(bin: string, name: string, body: string) {
  const file = join(bin, name);
  await writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  await chmod(file, 0o755);
}

async function run(script: string, args: string[], environment: Record<string, string>) {
  const child = spawn("bash", [script, ...args], {
    cwd: process.cwd(), env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("exit", resolve);
  });
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const policyRules = [
  "-A VOIDSTATION -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j RETURN",
  "-A VOIDSTATION -i br-voidstation -j RETURN",
  "-A VOIDSTATION -s 100.64.0.0/10 -i tailscale0 -p tcp -m tcp --dport 3000 -m conntrack --ctstate NEW,ESTABLISHED --ctorigdst 100.101.102.103 --ctorigdstport 8443 --ctdir ORIGINAL -j RETURN",
  "-A VOIDSTATION -s 192.168.50.0/24 -i enp1s0 -p tcp -m tcp --dport 3443 -m conntrack --ctstate NEW,ESTABLISHED --ctorigdst 192.168.50.10 --ctorigdstport 3000 --ctdir ORIGINAL -j RETURN",
  "-A VOIDSTATION -j DROP",
];
const ingressHook = "-A DOCKER-USER -o br-voidstation -j VOIDSTATION";
const legacyRule = "-A DOCKER-USER ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP";

async function ingressFixtures(bin: string) {
  await fake(bin, "id", "echo 0");
  await fake(bin, "python3", "if [[ $# == 2 ]]; then if [[ -v PYTHON_SOURCE ]]; then cat > \"$PYTHON_SOURCE\"; else cat > /dev/null; fi; printf '%s\\n' enp1s0 192.168.50.0/24 192.168.50.10 3000 100.101.102.103 8443; fi");
  await fake(bin, "iptables", `
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  "-w -S FORWARD") printf '%s\n' "$IPTABLES_FORWARD"; exit 0 ;;
  "-w -S DOCKER-USER") printf '%s\n' "$IPTABLES_DOCKER_USER"; exit "\${IPTABLES_DOCKER_USER_STATUS:-0}" ;;
  "-w -S VOIDSTATION") printf '%s\n' "$IPTABLES_VOIDSTATION"; exit "\${IPTABLES_VOIDSTATION_STATUS:-1}" ;;
esac
`);
}

describe("host ingress deployment command", () => {
  it("asks iproute2 for detailed link data before accepting a LAN interface", async () => {
    const { bin, directory, log } = await workspace();
    const parser = join(directory, "ingress-parser.py");
    await ingressFixtures(bin);
    const result = await run("scripts/host/voidstation-ingress.sh", [], {
      PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, PYTHON_SOURCE: parser,
      IPTABLES_FORWARD: "-P FORWARD DROP\n-A FORWARD -j DOCKER-FORWARD",
      IPTABLES_DOCKER_USER: "-N DOCKER-USER", IPTABLES_DOCKER_USER_STATUS: "0",
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(parser, "utf8")).toContain('["ip", "-details", "-j", "link", "show", "dev", interface]');
  });

  it("installs the complete restrictive chain before it hooks Docker without flushing other rules", async () => {
    const { bin, log } = await workspace();
    await ingressFixtures(bin);
    const result = await run("scripts/host/voidstation-ingress.sh", [], {
      PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log,
      IPTABLES_FORWARD: "-P FORWARD DROP\n-A FORWARD -j DOCKER-FORWARD",
      IPTABLES_DOCKER_USER: "-N DOCKER-USER", IPTABLES_DOCKER_USER_STATUS: "0",
    });

    expect(result.exitCode).toBe(0);
    const commands = await readFile(log, "utf8");
    for (const rule of policyRules) expect(commands).toContain(`-w ${rule}`);
    expect(commands).toContain("-w -I DOCKER-USER 1 -o br-voidstation -j VOIDSTATION");
    expect(commands).toContain("-w -I FORWARD 1 -j DOCKER-USER");
    expect(commands.indexOf("-A VOIDSTATION -j DROP")).toBeLessThan(commands.indexOf("-I DOCKER-USER 1 -o br-voidstation -j VOIDSTATION"));
    expect(commands).not.toContain("-F");
  });

  it("refuses the legacy broad drop until the owner explicitly requests migration", async () => {
    const { bin, log } = await workspace();
    await ingressFixtures(bin);
    const result = await run("scripts/host/voidstation-ingress.sh", [], {
      PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log,
      IPTABLES_FORWARD: "-P FORWARD DROP\n-A FORWARD -j DOCKER-USER",
      IPTABLES_DOCKER_USER: legacyRule,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--migrate/);
    expect(await readFile(log, "utf8")).not.toContain(" -I ");
  });

  it("migrates by adding the restrictive hook before removing the legacy rule", async () => {
    const { bin, log } = await workspace();
    await ingressFixtures(bin);
    const result = await run("scripts/host/voidstation-ingress.sh", ["--migrate"], {
      PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log,
      IPTABLES_FORWARD: "-P FORWARD DROP\n-A FORWARD -j DOCKER-USER",
      IPTABLES_DOCKER_USER: legacyRule,
    });

    expect(result.exitCode).toBe(0);
    const commands = await readFile(log, "utf8");
    expect(commands.indexOf("-I DOCKER-USER 1 -o br-voidstation -j VOIDSTATION")).toBeLessThan(
      commands.indexOf("-D DOCKER-USER ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP"),
    );
  });

  it("checks a normalized existing chain without changing firewall state", async () => {
    const { bin, log } = await workspace();
    await ingressFixtures(bin);
    const normalized = policyRules.map((rule) => rule.replace("NEW,ESTABLISHED", "ESTABLISHED,NEW")).join("\n");
    const result = await run("scripts/host/voidstation-ingress.sh", ["--check"], {
      PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log,
      IPTABLES_FORWARD: "-P FORWARD DROP\n-A FORWARD -j DOCKER-USER",
      IPTABLES_DOCKER_USER: ingressHook,
      IPTABLES_VOIDSTATION: normalized, IPTABLES_VOIDSTATION_STATUS: "0",
    });

    expect(result.exitCode).toBe(0);
    const commands = await readFile(log, "utf8");
    expect(commands).not.toMatch(/ -[INADF] /);
  });

  it("refuses a non-first existing DOCKER-USER forward jump instead of reordering rules", async () => {
    const { bin, log } = await workspace();
    await ingressFixtures(bin);
    const result = await run("scripts/host/voidstation-ingress.sh", [], {
      PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log,
      IPTABLES_FORWARD: "-P FORWARD DROP\n-A FORWARD -j DOCKER-FORWARD\n-A FORWARD -j DOCKER-USER",
      IPTABLES_DOCKER_USER: ingressHook,
      IPTABLES_VOIDSTATION: policyRules.join("\n"), IPTABLES_VOIDSTATION_STATUS: "0",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/first/i);
    expect(await readFile(log, "utf8")).not.toContain("-I FORWARD");
  });
});

describe("host certificate deployment command", () => {
  it("skips a certificate that remains valid for more than thirty days", async () => {
    const { bin, directory, log } = await workspace();
    const hostname = join(directory, "hostname");
    const tls = join(directory, "tls");
    await writeFile(hostname, "dashboard.example.ts.net\n");
    await mkdir(tls);
    await writeFile(join(tls, "cert.pem"), "fixture");
    await writeFile(join(tls, "key.pem"), "fixture key");
    await fake(bin, "install", "exit 0");
    await fake(bin, "id", "echo 0");
    await fake(bin, "stat", String.raw`if [[ "$*" == *"%u"* ]]; then echo 0; else echo 600; fi`);
    await fake(bin, "openssl", String.raw`
printf '%s\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  *"-checkend"*) exit 0 ;;
  *"-ext subjectAltName"*) echo 'DNS:dashboard.example.ts.net' ;;
  *"-pubkey"*|pkey*) echo matching-public-key ;;
  *) exit 99 ;;
esac`);
    for (const command of ["tailscale", "docker", "systemctl"]) await fake(bin, command, `printf '%s\n' "$*" >> "$COMMAND_LOG"; exit 99`);
    const result = await run("scripts/host/voidstation-renew-certificate.sh", [], {
      PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, VOIDSTATION_HOSTNAME_FILE: hostname, VOIDSTATION_TLS_DIRECTORY: tls,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(log, "utf8")).not.toMatch(/tailscale|docker/);
  });

  it("does not report a healthy certificate when its private key is missing", async () => {
    const { bin, directory } = await workspace();
    const hostname = join(directory, "hostname");
    const tls = join(directory, "tls");
    await writeFile(hostname, "dashboard.example.ts.net\n");
    await mkdir(tls);
    await writeFile(join(tls, "cert.pem"), "long-lived certificate");
    await fake(bin, "id", "echo 0");
    await fake(bin, "stat", String.raw`if [[ "$*" == *"%u"* ]]; then echo 0; else echo 600; fi`);
    await fake(bin, "install", "exit 0");
    await fake(bin, "openssl", String.raw`[[ "$*" == *"-checkend 2592000"* ]] && exit 0; exit 1`);
    await fake(bin, "tailscale", "exit 1");
    const result = await run("scripts/host/voidstation-renew-certificate.sh", [], {
      PATH: `${bin}:${process.env.PATH}`, VOIDSTATION_HOSTNAME_FILE: hostname, VOIDSTATION_TLS_DIRECTORY: tls,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("remains valid");
    expect(await readFile(join(tls, "cert.pem"), "utf8")).toBe("long-lived certificate");
  });

  it("keeps the current certificate when Tailscale renewal fails", async () => {
    const { bin, directory } = await workspace();
    const hostname = join(directory, "hostname");
    const tls = join(directory, "tls");
    await writeFile(hostname, "dashboard.example.ts.net\n");
    await mkdir(tls);
    await writeFile(join(tls, "cert.pem"), "current certificate");
    await fake(bin, "id", "echo 0");
    await fake(bin, "stat", String.raw`if [[ "$*" == *"%u"* ]]; then echo 0; else echo 600; fi`);
    await fake(bin, "install", "exit 0");
    await fake(bin, "openssl", String.raw`[[ "$*" == *"-checkend 2592000"* ]] && exit 1; exit 99`);
    await fake(bin, "tailscale", "exit 1");
    await fake(bin, "docker", "exit 99");
    await fake(bin, "systemctl", "exit 99");
    const result = await run("scripts/host/voidstation-renew-certificate.sh", [], {
      PATH: `${bin}:${process.env.PATH}`, VOIDSTATION_HOSTNAME_FILE: hostname, VOIDSTATION_TLS_DIRECTORY: tls,
    });

    expect(result.exitCode).not.toBe(0);
    expect(await readFile(join(tls, "cert.pem"), "utf8")).toBe("current certificate");
  });

  it("keeps the current certificate when public-key extraction fails instead of comparing empty output", async () => {
    const { bin, directory } = await workspace();
    const hostname = join(directory, "hostname");
    const tls = join(directory, "tls");
    await writeFile(hostname, "dashboard.example.ts.net\n");
    await mkdir(tls);
    await writeFile(join(tls, "cert.pem"), "current certificate");
    await fake(bin, "id", "echo 0");
    await fake(bin, "stat", String.raw`if [[ "$*" == *"%u"* ]]; then echo 0; else echo 600; fi`);
    await fake(bin, "install", "exit 0");
    await fake(bin, "tailscale", "exit 0");
    await fake(bin, "openssl", String.raw`
case "$*" in
  *"-checkend 2592000"*) exit 1 ;;
  *"-ext subjectAltName"*) echo 'DNS:dashboard.example.ts.net' ;;
  *"-checkend 0"*) exit 0 ;;
  *"-pubkey"*|pkey*) exit 1 ;;
esac`);
    await fake(bin, "docker", "exit 0");
    const result = await run("scripts/host/voidstation-renew-certificate.sh", [], {
      PATH: `${bin}:${process.env.PATH}`, VOIDSTATION_HOSTNAME_FILE: hostname, VOIDSTATION_TLS_DIRECTORY: tls,
    });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(join(tls, "cert.pem"), "utf8")).toBe("current certificate");
  });

  it.each([
    { mode: "renewal", args: [] as string[], restartCount: 1, failFirstRestart: false },
    { mode: "initial provisioning without a live cutover", args: ["--provision", "dashboard.example.ts.net"], restartCount: 0, failFirstRestart: false },
    { mode: "retry after a failed Dashboard restart", args: [] as string[], restartCount: 2, failFirstRestart: true },
  ])("validates and installs a certificate during $mode", async ({ args, restartCount, failFirstRestart }) => {
    const { bin, directory, log } = await workspace();
    const hostname = join(directory, "hostname");
    const tls = join(directory, "tls");
    await writeFile(hostname, "dashboard.example.ts.net\n");
    await mkdir(tls);
    await fake(bin, "id", "echo 0");
    await fake(bin, "stat", String.raw`if [[ "$*" == *"%u"* ]]; then echo 0; else echo 600; fi`);
    await fake(bin, "chown", "exit 0");
    await fake(bin, "install", "if [[ \"$1\" == -d ]]; then exit 0; fi\nwhile (($# > 2)); do shift; done; cp \"$1\" \"$2\"");
    await fake(bin, "tailscale", String.raw`
printf '%s\n' "tailscale $*" >> "$COMMAND_LOG"
for argument in "$@"; do
  case "$argument" in
    --cert-file=*) certificate="$(printf '%s' "$argument" | cut -d= -f2-)" ;;
    --key-file=*) key="$(printf '%s' "$argument" | cut -d= -f2-)" ;;
  esac
done
printf 'certificate' > "$certificate"
printf 'key' > "$key"`);
    await fake(bin, "openssl", String.raw`
printf '%s\n' "openssl $*" >> "$COMMAND_LOG"
case "$*" in
  *"-checkend 2592000"*) exit 0 ;;
  *"-ext subjectAltName"*) printf 'X509v3 Subject Alternative Name: DNS:dashboard.example.ts.net\n' ;;
  *"-checkend 0"*) exit 0 ;;
  *"-pubkey"*|pkey*) printf 'matching-public-key\n' ;;
esac`);
    await fake(bin, "docker", String.raw`
printf '%s\n' "docker $*" >> "$COMMAND_LOG"
if [[ "$1" == "ps" ]]; then printf 'dashboard-id\n'; fi
if [[ "$1" == "restart" && "$(printenv FAIL_RESTART || echo 0)" == 1 ]]; then exit 1; fi`);
    await fake(bin, "systemctl", "exit 99");
    const environment = {
      PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, VOIDSTATION_HOSTNAME_FILE: hostname, VOIDSTATION_TLS_DIRECTORY: tls,
    };
    let result = await run("scripts/host/voidstation-renew-certificate.sh", args, {
      ...environment, FAIL_RESTART: failFirstRestart ? "1" : "0",
    });
    if (failFirstRestart) {
      expect(result.exitCode).not.toBe(0);
      result = await run("scripts/host/voidstation-renew-certificate.sh", args, {
        ...environment, FAIL_RESTART: "0",
      });
    }

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(tls, "cert.pem"), "utf8")).toBe("certificate");
    expect(await readFile(join(tls, "key.pem"), "utf8")).toBe("key");
    const commands = await readFile(log, "utf8");
    expect(commands).toContain("--min-validity=720h");
    if (restartCount) {
      expect(commands).toContain("docker ps --quiet --filter label=com.docker.compose.project=voidstation-app --filter label=com.docker.compose.service=dashboard");
    } else {
      expect(commands).not.toContain("docker ");
    }
    expect(commands.match(/docker restart dashboard-id/g) ?? []).toHaveLength(restartCount);
    expect(commands.match(/tailscale cert /g) ?? []).toHaveLength(1);
  });
});

describe("host support units", () => {
  it("makes ingress a Docker prerequisite without an ExecStop teardown", async () => {
    const unit = await readFile("deploy/voidstation-ingress.service", "utf8");
    expect(unit).toContain("Before=docker.service");
    expect(unit).toContain("PartOf=docker.service");
    expect(unit).toContain("RequiredBy=docker.service");
    expect(unit).toContain("After=local-fs.target network-online.target");
    expect(unit).not.toContain("tailscaled");
    expect(unit).not.toContain("ExecStop=");
  });

  it("runs certificate renewal daily with the restricted production PATH", async () => {
    const service = await readFile("deploy/voidstation-certificate-renewal.service", "utf8");
    const timer = await readFile("deploy/voidstation-certificate-renewal.timer", "utf8");
    expect(service).toContain("ExecStart=/usr/local/libexec/voidstation-renew-certificate");
    expect(service).toContain("PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    expect(timer).toContain("OnCalendar=daily");
    expect(timer).toContain("Persistent=true");
  });
});
