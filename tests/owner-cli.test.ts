import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

async function runOwner(database: string, args: string[], password?: string) {
  const child = spawn(process.execPath, ["scripts/owner.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, VOIDSTATION_AUTH_DB: database },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(password);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stderr };
}

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "voidstation-owner-cli-"));
  directories.push(directory);
  return join(directory, "auth.sqlite");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("owner account command", () => {
  it("rejects a missing password and passwords shorter than twelve characters", async () => {
    const database = await databasePath();

    const missing = await runOwner(database, ["bootstrap"]);
    const weak = await runOwner(database, ["bootstrap", "--password-stdin"], "too-short\n");

    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toMatch(/password/i);
    expect(weak.exitCode).not.toBe(0);
    expect(weak.stderr).toMatch(/password/i);
  });

  it("bootstraps the owner account once and makes the state file private", async () => {
    const database = await databasePath();

    const created = await runOwner(database, ["bootstrap", "--password-stdin"], "a secure owner password\n");

    expect(created.exitCode).toBe(0);
    expect((await stat(database)).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing owner account", async () => {
    const database = await databasePath();
    await runOwner(database, ["bootstrap", "--password-stdin"], "a secure owner password\n");

    const repeated = await runOwner(database, ["bootstrap", "--password-stdin"], "a different secure password\n");

    expect(repeated.exitCode).not.toBe(0);
    expect(repeated.stderr).toMatch(/already exists/i);
  });

  it("refuses recovery before bootstrap and accepts recovery after bootstrap", async () => {
    const absentDatabase = await databasePath();
    const absent = await runOwner(absentDatabase, ["recover", "--password-stdin"], "a secure owner password\n");
    expect(absent.exitCode).not.toBe(0);
    expect(absent.stderr).toMatch(/does not exist/i);

    const database = await databasePath();
    await runOwner(database, ["bootstrap", "--password-stdin"], "a secure owner password\n");
    const recovered = await runOwner(database, ["recover", "--password-stdin"], "a different secure password\n");

    expect(recovered.exitCode).toBe(0);
  });
});
