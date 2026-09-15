import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([false, true])("transfers only the leaf bundle and installer, with trust and installation approval=%s", (approved) => {
  const workspace = mkdtempSync(join(tmpdir(), "voidstation-certificate-wizard-"));
  const bin = join(workspace, "bin");
  const log = join(workspace, "commands");
  const state = join(workspace, ".local/share/voidstation-lan-ca");
  mkdirSync(bin);
  mkdirSync(join(state, "bundles", "fixture"), { recursive: true });
  mkdirSync(join(state, "public"));
  try {
    const scripts = {
      python3: `if [[ "$1" == *lan-certificates.py ]]; then
  printf 'python3 %s\\n' "$*" >> "$COMMAND_LOG"
  printf '{"bundle":"%s/bundles/fixture","ca_certificate":"%s/public/ca.pem","android_certificate":"%s/public/voidstation-ca.crt","fingerprint":"AA:BB"}\\n' "$TEST_STATE" "$TEST_STATE" "$TEST_STATE"
else exec /usr/bin/python3 "$@"; fi`,
      ssh: `printf 'ssh %s\\n' "$*" >> "$COMMAND_LOG"
printf '/home/test/voidstation-lan-import-fixture\\n'`,
      scp: `printf 'scp %s\\n' "$*" >> "$COMMAND_LOG"`,
    };
    for (const [name, body] of Object.entries(scripts)) {
      const pathname = join(bin, name);
      writeFileSync(pathname, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
      chmodSync(pathname, 0o755);
    }
    const result = spawnSync("bash", ["scripts/setup-lan-certificates.sh", "192.168.50.10"], {
      env: { ...process.env, HOME: workspace, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, TEST_STATE: state },
      input: `\ny\n${approved ? "y" : "n"}\ny\nowner@server\n${approved ? "y" : "n"}\n`, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const commands = readFileSync(log, "utf8");
    expect(commands).toContain("issue --ip 192.168.50.10");
    expect(commands).toContain("/fixture/cert.pem");
    expect(commands).toContain("/fixture/key.pem");
    expect(commands).toContain("/fixture/ca.pem");
    expect(commands).not.toContain("ca-key.pem");
    expect(commands.includes("trust-arch")).toBe(approved);
    expect(commands.includes("sudo python3")).toBe(approved);
    expect(result.stdout).toContain("No application deployment or firewall change");
    const handoff = readFileSync(join(state, "next-steps.txt"), "utf8");
    expect(handoff).toContain("sudo python3 /home/test/voidstation-lan-import-fixture/lan-certificates.py install --ip 192.168.50.10");
    expect(handoff).toContain("trust-arch --ca ca.pem");
    expect(handoff).not.toContain("ca-key.pem");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
