import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("passes the explicit owner cutover option through the production entry point", () => {
  const directory = mkdtempSync(join(tmpdir(), "voidstation-deploy-entry-"));
  const log = join(directory, "commands");
  try {
    for (const name of ["git", "npm"]) {
      const command = join(directory, name);
      writeFileSync(command, `#!/usr/bin/env bash\nprintf '%s\\n' '${name}' "$@" >> "$COMMAND_LOG"\n`);
      chmodSync(command, 0o755);
    }
    const result = spawnSync("bash", ["deploy.sh", "--cutover"], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, COMMAND_LOG: log },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("git\nstatus\n--porcelain\ngit\npull\n--ff-only\norigin\nmain\nnpm\nrun\ndocker:up\n--\n--cutover\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses a dirty source tree before pulling or running deployment commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "voidstation-dirty-deploy-"));
  const log = join(directory, "commands");
  try {
    for (const name of ["git", "npm"]) {
      const command = join(directory, name);
      writeFileSync(command, `#!/usr/bin/env bash\nprintf '%s %s\\n' '${name}' "$*" >> "$COMMAND_LOG"\nif [[ "$1" == status ]]; then printf ' M src/unreviewed.ts\\n'; fi\n`);
      chmodSync(command, 0o755);
    }
    const result = spawnSync("bash", ["deploy.sh", "--cutover"], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, COMMAND_LOG: log },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("clean checkout");
    expect(readFileSync(log, "utf8")).toBe("git status --porcelain\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
