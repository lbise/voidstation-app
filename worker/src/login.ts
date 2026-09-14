import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createCodexRuntime } from "./pi.ts";

async function main(): Promise<void> {
  process.umask(0o077);
  if (process.env.VOIDSTATION_TEST_MODEL_FILE) throw new Error("The deterministic model fixture cannot be used for login.");
  const credentialDir = process.env.VOIDSTATION_CREDENTIAL_DIR;
  if (!credentialDir) throw new Error("VOIDSTATION_CREDENTIAL_DIR is required.");
  mkdirSync(resolve(credentialDir), { recursive: true, mode: 0o700 });
  const runtime = await createCodexRuntime(resolve(credentialDir));
  await runtime.login("openai-codex", "oauth", {
    prompt: async (prompt) => {
      if (prompt.type === "select") return "device_code";
      throw new Error("The Codex headless login requested an unsupported interactive prompt.");
    },
    notify: (event) => {
      if (event.type === "device_code") {
        console.log(`Open ${event.verificationUri} and enter code ${event.userCode}.`);
        console.log("Keep this terminal open until login completes.");
      }
    },
  });
  console.log("Codex login saved in the worker credential directory.");
}

void main().catch(() => {
  console.error("Codex login did not complete. Retry the login command.");
  process.exitCode = 1;
});
