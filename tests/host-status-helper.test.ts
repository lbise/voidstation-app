import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { collectHostMetrics, type HostInput } from "../src/lib/host-metrics";

it("writes a host-status file that the Dashboard collector accepts", async () => {
  const { stdout } = await promisify(execFile)("python3", ["-B", "tests/host-status-helper.test.py"], {
    timeout: 25_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(stdout).toContain("PASS: host-status helper");
  const text = /^STATUS (.+)$/m.exec(stdout)?.[1];
  expect(text).toBeDefined();
  const written = JSON.parse(text!);

  const observedAt = new Date().toISOString();
  const sample = async () => ({ text: "", observedAt });
  const input: HostInput = {
    cpu: sample, uptime: sample, memory: sample, load: sample, pressure: sample,
    hostStatus: async () => ({ text: text!, observedAt }),
    rootFilesystem: async () => { throw new Error("unused"); },
    dataFilesystem: async () => { throw new Error("unused"); },
  };
  const { version: _version, checkedAt, ...value } = written;
  expect((await collectHostMetrics(input)).hostStatus).toEqual({
    status: "available", value, unit: "status", observedAt: checkedAt,
  });
}, 30_000);
