import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const workspaces: string[] = [];

async function executable(path: string, source: string) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

type Options = { wrongPolicy?: boolean; tailscaleOriginPort?: number };

async function runVerification(options: Options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "voidstation-ingress-"));
  workspaces.push(workspace);
  const bin = join(workspace, "bin");
  const log = join(workspace, "commands.log");
  const counter = join(workspace, "counter");
  const config = join(workspace, "ingress.json");
  await mkdir(bin);
  await writeFile(log, "");
  await writeFile(counter, "0\n");
  await writeFile(config, JSON.stringify({
    lanInterface: "enp1s0", lanSource: "192.168.50.0/24", lanAddress: "192.168.50.10", lanPort: 3000,
    tailscaleAddress: "100.101.102.103", tailscalePort: 8443,
  }));
  const rules = [
    "-A VOIDSTATION -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN",
    "-A VOIDSTATION -i br-voidstation -j RETURN",
    "-A VOIDSTATION -s 100.64.0.0/10 -i tailscale0 -p tcp -m tcp --dport 3000 -m conntrack --ctstate ESTABLISHED,NEW --ctorigdst 100.101.102.103 --ctorigdstport 8443 --ctdir ORIGINAL -j RETURN",
    `-A VOIDSTATION -s 192.168.50.0/24 -i ${options.wrongPolicy ? "enp2s0" : "enp1s0"} -p tcp -m tcp --dport 3443 -m conntrack --ctstate ESTABLISHED,NEW --ctorigdst 192.168.50.10 --ctorigdstport 3000 --ctdir ORIGINAL -j RETURN`,
    "-A VOIDSTATION -j DROP",
  ].join("\n");
  await executable(join(bin, "id"), "#!/bin/sh\necho 0\n");
  await executable(join(bin, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$INGRESS_LOG"
if [ "$1 $2 $3 $4 $5" = "compose --project-name voidstation-app ps --quiet" ]; then [ "$6" = dashboard ] && echo 0123456789ab || echo abcdef012345; exit 0; fi
if [ "$1" = inspect ]; then [ "$2" = 0123456789ab ] && echo '{"default":{"IPAddress":"172.18.0.2"}}' || echo '{"default":{"IPAddress":"172.18.0.3"}}'; exit 0; fi
exit 2
`);
  await executable(join(bin, "iptables"), `#!/bin/sh
printf 'iptables %s\\n' "$*" >> "$INGRESS_LOG"
if [ "$3" = -S ]; then
 case "$4" in FORWARD) echo '-A FORWARD -j DOCKER-USER';; DOCKER-USER) echo '-A DOCKER-USER -o br-voidstation -j VOIDSTATION';; VOIDSTATION) printf '%s\\n' "$VOIDSTATION_RULES";; esac
 exit 0
fi
if [ "$3" = -nvx ]; then value=$(cat "$INGRESS_COUNTER"); printf '5 %s 0 DROP all -- * * 0.0.0.0/0 0.0.0.0/0\\n' "$value"; exit 0; fi
exit 2
`);
  await executable(join(bin, "curl"), `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$INGRESS_LOG"
value=$(cat "$INGRESS_COUNTER"); echo $((value + 1)) > "$INGRESS_COUNTER"
exit 28
`);
  await executable(join(bin, "ip"), `#!/bin/sh
printf 'ip %s\\n' "$*" >> "$INGRESS_LOG"
if [ "$1 $2 $3 $4 $5" = "-json route show table all" ]; then echo '[]'; exit 0; fi
if [ "$1 $2" = "netns exec" ]; then shift 3; exec "$@"; fi
exit 0
`);
  const child = spawn("python3", ["scripts/verify-ingress.py", "--test-config", "--config", config,
    "--tailscale-origin", `https://voidstation.tailnet.ts.net:${options.tailscaleOriginPort ?? 8443}`, "--lan-origin", "https://192.168.50.10:3000"], {
    cwd: process.cwd(), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INGRESS_LOG: log, INGRESS_COUNTER: counter, VOIDSTATION_RULES: rules }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { code, output, log: await readFile(log, "utf8") };
}

afterEach(async () => { await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true }))); });

it("proves each untrusted ingress route reaches the terminal DROP rule without calling it a physical-client test", async () => {
  const result = await runVerification();
  expect(result.code).toBe(0);
  expect(result.output).toContain("unauthorized-interface-and-source-to-tailscale");
  expect(result.output).toContain("unauthorized-interface-and-source-to-lan");
  expect(result.output).toContain("direct-dashboard-backend");
  expect(result.output).toContain("direct-LAN-backend");
  expect(result.output).toContain("direct-Assistant-worker");
  expect(result.output).toContain("not a physical LAN or Tailscale client");
  expect(result.log).toContain("--resolve voidstation.tailnet.ts.net:8443:100.101.102.103");
  expect(result.log).toContain("--resolve 192.168.50.10:3000:192.168.50.10");
  expect(result.log).toContain("--resolve 192.168.50.10:3443:172.18.0.2");
  expect(result.log).toContain("https://192.168.50.10:3443/login");
  expect(result.log).toContain("http://172.18.0.3:3001/login");
  expect(result.log).not.toContain("-k");
});

it("fails closed before creating a namespace when any audited policy selector changes", async () => {
  const result = await runVerification({ wrongPolicy: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("does not match the audited dual-ingress policy");
  expect(result.log).not.toContain("ip netns add");
});

it("refuses a Tailscale origin whose port differs from the configured publication before creating a namespace", async () => {
  const result = await runVerification({ tailscaleOriginPort: 8444 });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Tailscale origin port must match the configured Tailscale port");
  expect(result.log).not.toContain("ip netns add");
});
