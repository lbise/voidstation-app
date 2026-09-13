import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("diagnoses terminal/login failures without secrets and carries the secure session through metrics and logout", async () => {
  const { stdout } = await promisify(execFile)("python3", ["tests/verify-owner-metrics.test.py"], {
    timeout: 25_000,
  });
  expect(stdout).toContain("PASS: host-only owner cookie reaches metrics and logout");
}, 30_000);
