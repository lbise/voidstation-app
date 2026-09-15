import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

function update(args: string[] = [], environment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "voidstation-update-"));
  const log = join(directory, "commands");
  try {
    writeFileSync(log, "");
    const commands = {
      node: `printf 'node %s\n' "$*" >> "$COMMAND_LOG"
if [[ -n "\${FAIL_COMMAND:-}" && "$*" == "$FAIL_COMMAND" ]]; then
  echo 'Synthetic validation failure' >&2
  exit 1
fi`,
      docker: `printf 'docker %s\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == *"images --quiet assistant-worker" ]]; then echo fixture-worker-image; fi`,
    };
    for (const [name, body] of Object.entries(commands)) {
      const command = join(directory, name);
      writeFileSync(command, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
      chmodSync(command, 0o755);
    }
    const result = spawnSync("bash", ["scripts/docker-up.sh", ...args], {
      env: { ...process.env, VOIDSTATION_INITIAL_LAN_CUTOVER: "", ...environment, PATH: `${directory}:${process.env.PATH}`, COMMAND_LOG: log },
      encoding: "utf8",
    });
    return { ...result, commands: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("refuses production changes if either existing HTTPS path fails predeploy validation", () => {
  const result = update([], { FAIL_COMMAND: "scripts/deployment-preflight.mjs --predeploy" });
  expect(result.status).not.toBe(0);
  expect(result.commands).toEqual(["node scripts/deployment-preflight.mjs --predeploy"]);
});

it("checks both paths and reloads certificates without forcing an unchanged worker to restart", () => {
  const result = update();
  expect(result.status, result.stderr).toBe(0);
  expect(result.commands[0]).toBe("node scripts/deployment-preflight.mjs --predeploy");
  expect(result.commands).toContain("docker compose --project-name voidstation-app build dashboard assistant-worker");
  expect(result.commands).toContain("node scripts/worker-runtime-inspect.mjs fixture-worker-image");
  expect(result.commands).toContain("docker compose --project-name voidstation-app up --no-build -d --no-deps assistant-worker");
  expect(result.commands).toContain("docker compose --project-name voidstation-app up --no-build -d --no-deps --force-recreate dashboard");
  expect(result.commands.some((command) => command.includes("--force-recreate") && command.includes("assistant-worker"))).toBe(false);
  expect(result.commands.at(-1)).toBe("node scripts/deployment-preflight.mjs --postdeploy");
});

it("does not restart production when the built worker fails isolation inspection", () => {
  const result = update([], { FAIL_COMMAND: "scripts/worker-runtime-inspect.mjs fixture-worker-image" });
  expect(result.status).not.toBe(0);
  expect(result.commands.some((command) => command.includes(" up "))).toBe(false);
});

it("requires explicit owner acknowledgment before skipping initial LAN readiness", () => {
  const refused = update(["--cutover"]);
  expect(refused.status).not.toBe(0);
  expect(refused.commands).toEqual([]);
  const accepted = update(["--cutover"], { VOIDSTATION_INITIAL_LAN_CUTOVER: "approved" });
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(accepted.commands[0]).toBe("node scripts/deployment-preflight.mjs --precutover");
  expect(accepted.commands.at(-1)).toBe("node scripts/deployment-preflight.mjs --postdeploy");
});

it("does not build during cutover when the existing Tailscale login probe fails", () => {
  const result = update(["--cutover"], {
    VOIDSTATION_INITIAL_LAN_CUTOVER: "approved",
    FAIL_COMMAND: "scripts/deployment-preflight.mjs --precutover",
  });
  expect(result.status).not.toBe(0);
  expect(result.commands).toEqual(["node scripts/deployment-preflight.mjs --precutover"]);
});

it("reports failed postdeploy verification without announcing success", () => {
  const result = update([], { FAIL_COMMAND: "scripts/deployment-preflight.mjs --postdeploy" });
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("passed post-deploy inspection");
});
