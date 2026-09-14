import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("pins both Pi packages in the worker manifest and lockfile", async () => {
  const manifest = JSON.parse(await readFile("worker/package.json", "utf8"));
  const lockfile = JSON.parse(await readFile("worker/package-lock.json", "utf8"));
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    const version = manifest.dependencies[name];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lockfile.packages[`node_modules/${name}`].version).toBe(version);
  }
});
