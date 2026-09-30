import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("pins both Pi packages and the restricted media runtime", async () => {
  const manifest = JSON.parse(await readFile("worker/package.json", "utf8"));
  const lockfile = JSON.parse(await readFile("worker/package-lock.json", "utf8"));
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    const version = manifest.dependencies[name];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lockfile.packages[`node_modules/${name}`].version).toBe(version);
  }
  const requirements = await readFile("worker/media/requirements.txt", "utf8");
  expect(requirements).toMatch(/^requests==\d+\.\d+\.\d+$/m);
  for (const path of ["worker/media/upstream/radarr.py", "worker/media/upstream/sonarr.py", "worker/media/upstream/media_restricted.py"]) {
    const stat = await import("node:fs/promises").then(({ stat }) => stat(path));
    expect(stat.isFile()).toBe(true);
  }
});

it("keeps the worker's copy of the download queue contract identical to the Dashboard's", async () => {
  // The worker is built separately and cannot import from src/, so the contract is duplicated.
  const body = (text: string) => text
    .split("\n")
    .filter((line) => !line.startsWith("//") && !line.startsWith("import "))
    .join("\n")
    .trim();
  const dashboard = await readFile("src/lib/downloads-contract.ts", "utf8");
  const worker = await readFile("worker/src/downloads-contract.ts", "utf8");
  expect(body(worker)).toBe(body(dashboard));
});
