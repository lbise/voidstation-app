import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const workspaces: string[] = [];

type Options = {
  routeOverlap?: boolean; wrongRule?: boolean; failVethMove?: boolean; failCleanup?: boolean;
  noDroppedPackets?: boolean; diagnostics?: boolean;
  rawDrop?: "matching" | "unrelated" | "wrong-bridge" | "unchanged" | "duplicate";
  tailscaleNoDrop?: boolean;
  directProbeExit?: number;
};

async function executable(path: string, source: string) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function runVerification(options: Options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "voidstation-ingress-"));
  workspaces.push(workspace);
  const bin = join(workspace, "bin");
  const log = join(workspace, "commands.log");
  const counter = join(workspace, "counter");
  const rawCounter = join(workspace, "raw-counter");
  await writeFile(counter, "0\n");
  await writeFile(rawCounter, "0\n");
  await writeFile(log, "");
  await mkdir(bin);

  await executable(join(bin, "id"), "#!/bin/sh\necho 0\n");
  await executable(join(bin, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$INGRESS_LOG"
if [ "$1 $2 $3 $4 $5" = "compose --project-name voidstation-app ps --quiet" ]; then echo 0123456789ab; exit 0; fi
if [ "$1" = inspect ]; then echo '{"default":{"IPAddress":"172.18.0.2"}}'; exit 0; fi
exit 2
`);
  await executable(join(bin, "iptables"), `#!/bin/sh
printf 'iptables %s\\n' "$*" >> "$INGRESS_LOG"
if [ "$3" = -S ]; then
  ${options.wrongRule ? "echo '-A DOCKER-USER -j ACCEPT'" : "echo '-A DOCKER-USER ! -i tailscale0 -o br-voidstation -m conntrack --ctstate NEW -j DROP'"}
  exit 0
fi
if [ "$3" = -nvx ]; then
  value=$(cat "$INGRESS_COUNTER")
  printf 'Chain DOCKER-USER (1 references)\\nnum   pkts bytes target     prot opt in     out     source               destination\\n1     %s 0 DROP       all  --  !tailscale0 br-voidstation  0.0.0.0/0            0.0.0.0/0\\n' "$value"
  exit 0
fi
exit 2
`);
  await executable(join(bin, "iptables-save"), `#!/bin/sh
if [ "${options.rawDrop ? "1" : "0"}" = 1 ]; then
  value=$(cat "$INGRESS_RAW_COUNTER")
  printf '*raw\\n[%s:120] -A PREROUTING -d ${options.rawDrop === "unrelated" ? "172.18.0.99" : "172.18.0.2"}/32 ! -i ${options.rawDrop === "wrong-bridge" ? "br-other" : "br-voidstation"} -j DROP\\n${options.rawDrop === "duplicate" ? "[99:5940] -A PREROUTING -d 172.18.0.2/32 ! -i br-voidstation -j DROP\\n" : ""}COMMIT\\n' "$value"
else
  printf '*raw\\n[3:180] -A PREROUTING -d 172.18.0.2/32 -j DROP\\nCOMMIT\\n'
fi
`);
  await executable(join(bin, "curl"), `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$INGRESS_LOG"
if [ "\${IN_NETNS:-}" = 1 ]; then
  case "$*" in
    *:3000/login*)
      if [ "${options.rawDrop ? "1" : "0"}" = 1 ]; then
        ${options.rawDrop === "unchanged" ? ":" : 'value=$(cat "$INGRESS_RAW_COUNTER"); echo $((value + 2)) > "$INGRESS_RAW_COUNTER"'}
        exit ${options.directProbeExit ?? 28}
      fi ;;
    *) if [ "${options.tailscaleNoDrop ? "1" : "0"}" = 1 ]; then exit 28; fi ;;
  esac
  ${options.noDroppedPackets ? ":" : 'value=$(cat "$INGRESS_COUNTER"); echo $((value + 1)) > "$INGRESS_COUNTER"'}
  exit 28
fi
printf 200
`);
  await executable(join(bin, "ip"), `#!/bin/sh
printf 'ip %s\\n' "$*" >> "$INGRESS_LOG"
if [ "$1 $2 $3 $4 $5" = "-json route show table all" ]; then
  ${options.routeOverlap ? "echo '[{\"dst\":\"192.0.2.0/24\"}]'" : "echo '[]'"}
  exit 0
fi
if [ "$1 $2" = "netns exec" ]; then shift 3; IN_NETNS=1 exec "$@"; fi
if [ "$1 $2" = "link set" ] && [ "${options.failVethMove ? "1" : "0"}" = 1 ]; then case "$3" in vscn*) exit 1 ;; esac; fi
if [ "$1 $2" = "link del" ] && [ "${options.failCleanup ? "1" : "0"}" = 1 ]; then exit 1; fi
exit 0
`);

  const child = spawn("python3", ["scripts/verify-ingress.py", "--origin", "https://voidstation.tailnet.ts.net", "--tailscale-ip", "100.101.102.103", "--container-ip", "172.18.0.2", "--report-results", ...(options.diagnostics ? ["--diagnostics"] : [])], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INGRESS_LOG: log, INGRESS_COUNTER: counter, INGRESS_RAW_COUNTER: rawCounter },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, output, log: await readFile(log, "utf8") };
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

it("verifies readiness and both refused ingress paths through its CLI", async () => {
  const result = await runVerification();

  expect(result.output).toMatch(/PASS: readiness=200, tailscale-blocked=yes, container-blocked=yes, rule-packets=\d+/);
  expect(result.code).toBe(0);
  expect(result.log).toContain("docker compose --project-name voidstation-app ps --quiet dashboard");
  expect(result.log).toContain("curl --noproxy *");
  expect(result.log).toContain("--resolve voidstation.tailnet.ts.net:443:100.101.102.103");
  expect(result.log).toContain("https://voidstation.tailnet.ts.net:3000/login");
  expect(result.log).toContain("route add default via 192.0.2.1 dev");
  expect(result.log).not.toContain("-k");
  expect(result.output).not.toContain("100.101.102.103");
  expect(result.output).not.toContain("172.18.0.2");
  expect(result.log).toMatch(/ip netns add vs-check-[a-f0-9]{6}/);
  expect(result.log).toMatch(/ip link del dev vsch[a-f0-9]{6}/);
  expect(result.log).toMatch(/ip netns del vs-check-[a-f0-9]{6}/);
});

it("recognizes Docker's earlier direct-container drop while retaining DOCKER-USER proof for the publication", async () => {
  const result = await runVerification({ rawDrop: "matching" });
  expect(result.code).toBe(0);
  expect(result.output).toContain("PASS: tailscale-publication: timeout confirmed, ingress packets 0 -> 1");
  expect(result.output).toContain("PASS: container-address: timeout confirmed, Docker raw PREROUTING packets 0 -> 2");
  expect(result.output).toContain("tailscale-blocked=yes, container-blocked=yes");
});

it.each(["unrelated", "wrong-bridge", "unchanged", "duplicate"] as const)("rejects %s raw-table evidence for the direct-container probe", async (rawDrop) => {
  const result = await runVerification({ rawDrop });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("container-address: Docker ingress counter did not increase");
  expect(result.output).not.toContain("tailscale-blocked=yes, container-blocked=yes");
});

it("does not substitute a container raw-drop counter for the published-address ingress proof", async () => {
  const result = await runVerification({ rawDrop: "matching", tailscaleNoDrop: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("tailscale-publication: Docker ingress counter did not increase");
  expect(result.output).toContain("PASS: container-address:");
});

it.each([0, 7])("rejects curl exit %i even if the matching raw-drop counter increases", async (directProbeExit) => {
  const result = await runVerification({ rawDrop: "matching", directProbeExit });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("container-address: Blocked ingress probe did not time out");
});

it("refuses the documented test subnet when an existing route overlaps it", async () => {
  const result = await runVerification({ routeOverlap: true });

  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Existing route overlaps the reserved test subnet");
  expect(result.log).not.toMatch(/ip netns add/);
});

it("refuses a DOCKER-USER rule that is not first", async () => {
  const result = await runVerification({ wrongRule: true });

  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Docker ingress rule is not the first DOCKER-USER rule");
  expect(result.log).not.toMatch(/ip netns add/);
});

it("does not claim a timeout proves ingress protection without matching dropped packets", async () => {
  const result = await runVerification({ noDroppedPackets: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Docker ingress counter did not increase");
});

it("identifies both failing probe paths and captures earlier firewall counters without weakening verification", async () => {
  const result = await runVerification({ noDroppedPackets: true, diagnostics: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("tailscale-publication: Docker ingress counter did not increase");
  expect(result.output).toContain("container-address: Docker ingress counter did not increase");
  expect(result.output).toContain('"probe": "container-address"');
  expect(result.output).toContain("[3:180] -A PREROUTING");
  expect(result.log).toMatch(/ip link del dev vsch[a-f0-9]{6}/);
  expect(result.log).toMatch(/ip netns del vs-check-[a-f0-9]{6}/);
});

it("reports cleanup failure and still attempts to remove the namespace", async () => {
  const result = await runVerification({ failCleanup: true });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Cleanup failed");
  expect(result.log).toMatch(/ip netns del vs-check-[a-f0-9]{6}/);
});

it("removes only its veth and namespace when setup fails", async () => {
  const result = await runVerification({ failVethMove: true });

  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Moving test veth failed");
  expect(result.log).toMatch(/ip link del dev vsch[a-f0-9]{6}/);
  expect(result.log).toMatch(/ip netns del vs-check-[a-f0-9]{6}/);
});
