import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("pins both Pi packages and the read-only media runtime inputs", async () => {
  const manifest = JSON.parse(await readFile("worker/package.json", "utf8"));
  const lockfile = JSON.parse(await readFile("worker/package-lock.json", "utf8"));
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    const version = manifest.dependencies[name];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lockfile.packages[`node_modules/${name}`].version).toBe(version);
  }
  const requirements = await readFile("worker/media/requirements.txt", "utf8");
  expect(requirements).toMatch(/^requests==\d+\.\d+\.\d+$/m);
  for (const path of ["worker/skills/radarr/SKILL.md", "worker/skills/sonarr/SKILL.md", "worker/media/upstream/radarr.py", "worker/media/upstream/sonarr.py", "worker/media/upstream/media_restricted.py"]) {
    const stat = await import("node:fs/promises").then(({ stat }) => stat(path));
    expect(stat.isFile()).toBe(true);
  }
});
