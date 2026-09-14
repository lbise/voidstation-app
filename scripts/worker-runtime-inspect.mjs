#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

function fail(message) {
  throw new Error(message);
}

function docker(arguments_, description) {
  try {
    return execFileSync("docker", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`${description} failed: ${error.stderr?.toString().trim() || error.message}`);
  }
}

function dockerJson(arguments_, description) {
  try {
    return JSON.parse(docker(arguments_, description));
  } catch (error) {
    fail(error instanceof SyntaxError ? `${description} did not return JSON.` : error.message);
  }
}

function inspect(image) {
  const value = dockerJson(["image", "inspect", image], "Worker runtime image inspection");
  if (!Array.isArray(value) || value.length !== 1 || !value[0]) fail("Worker runtime image inspection did not return one image.");
  return value[0];
}

function hardeningArguments() {
  return ["--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:size=16m,noexec,nosuid"];
}

function assertMetadata(image) {
  const runtime = inspect(image);
  const config = runtime.Config ?? {};
  if (config.User !== "node" && config.User !== "1000:1000") fail("Worker runtime image must declare the unprivileged node user.");
  const ports = Object.keys(config.ExposedPorts ?? {}).sort();
  if (JSON.stringify(ports) !== JSON.stringify(["3001/tcp"])) fail("Worker runtime image must expose only 3001/tcp.");
  const command = [...(config.Entrypoint ?? []), ...(config.Cmd ?? [])].join(" ");
  if (!/\bnode\b/.test(command)) fail("Worker runtime image must start through Node.");
  const environment = config.Env ?? [];
  if (!Array.isArray(environment) || environment.some((entry) => /^(VOIDSTATION_WORKER_TOKEN|OPENAI_API_KEY|CODEX_AUTH_TOKEN)=/i.test(entry))) {
    fail("Worker runtime image must not bake a worker token or provider credential into its environment.");
  }
  const history = docker(["image", "history", "--no-trunc", "--format", "{{.CreatedBy}}", image], "Reading worker image history");
  if (/VOIDSTATION_WORKER_TOKEN|OPENAI_API_KEY|CODEX_AUTH_TOKEN/i.test(history)) {
    fail("Worker image history must not contain a worker token or provider credential.");
  }
}

function runNode(image, arguments_, source, description) {
  return docker(["run", "--rm", ...hardeningArguments(), ...arguments_, "--entrypoint", "node", image, "--input-type=module", "-e", source], description);
}

function requireInstalledPackages(image) {
  const expected = JSON.parse(docker(["run", "--rm", "--entrypoint", "node", image, "--input-type=module", "-e", `
    import { readFileSync } from "node:fs";
    const packageInfo = (name) => JSON.parse(readFileSync(\`/app/node_modules/\${name}/package.json\`, "utf8")).version;
    console.log(JSON.stringify({ ai: packageInfo("@earendil-works/pi-ai"), agent: packageInfo("@earendil-works/pi-coding-agent") }));
  `], "Reading installed Pi package versions"));
  const manifest = JSON.parse(docker(["run", "--rm", "--entrypoint", "node", image, "--input-type=module", "-e", `
    import { readFileSync } from "node:fs";
    const value = JSON.parse(readFileSync("/app/package.json", "utf8"));
    console.log(JSON.stringify(value.dependencies));
  `], "Reading packaged worker manifest"));
  if (!/^\d+\.\d+\.\d+$/.test(manifest["@earendil-works/pi-ai"] ?? "") || !/^\d+\.\d+\.\d+$/.test(manifest["@earendil-works/pi-coding-agent"] ?? "")) {
    fail("Packaged Pi dependencies must use exact versions.");
  }
  if (expected.ai !== manifest["@earendil-works/pi-ai"] || expected.agent !== manifest["@earendil-works/pi-coding-agent"]) {
    fail("Installed Pi package versions do not match the packaged worker manifest.");
  }
}

function requireProductionAdapterAbsent(image) {
  runNode(image, ["--network", "none"], `
    import { existsSync } from "node:fs";
    if (existsSync("/app/dist/test-fixture.js")) throw new Error("test adapter is present in the runtime image");
  `, "Checking the production image for its test adapter");
}

function inspectContainer(id, fixture) {
  const container = dockerJson(["inspect", id], "Inspecting the isolated worker container")[0];
  if (!container) fail("Docker did not return the isolated worker container.");
  if (container.Config?.User !== "1000:1000" || container.HostConfig?.ReadonlyRootfs !== true || !container.State?.Running) {
    fail("The isolated worker container is not running as UID/GID 1000 with a read-only root filesystem.");
  }
  if (JSON.stringify(container.HostConfig?.CapDrop) !== JSON.stringify(["ALL"]) || !container.HostConfig?.SecurityOpt?.includes("no-new-privileges:true")) {
    fail("The isolated worker container hardening changed.");
  }
  if (Object.values(container.NetworkSettings?.Ports ?? {}).some((bindings) => bindings !== null)) {
    fail("The isolated worker container has a host port publication.");
  }
  const expectedMounts = new Map([
    ["/run/voidstation-worker/token", [fixture.token, false]],
    ["/var/lib/voidstation/conversations", [fixture.conversations, true]],
    ["/var/lib/voidstation/credentials", [fixture.credentials, true]],
  ]);
  if (container.Mounts?.length !== expectedMounts.size) fail("The isolated worker container mount count changed.");
  for (const [target, [source, writable]] of expectedMounts) {
    const mount = container.Mounts.find((candidate) => candidate.Destination === target);
    if (!mount || mount.Type !== "bind" || mount.Source !== source || mount.RW !== writable) {
      fail(`The isolated worker mount at ${target} changed or is unsafe.`);
    }
  }
}

function healthCheck(id, token) {
  const source = `
    import { request } from "node:http";
    const check = (authorization, expected) => new Promise((resolve, reject) => {
      const request_ = request({ hostname: "127.0.0.1", port: 3001, path: "/health", headers: authorization ? { authorization } : {} }, (response) => {
        response.resume();
        response.on("end", () => response.statusCode === expected ? resolve() : reject(new Error(\`expected health status \${expected}, got \${response.statusCode}\`)));
      });
      request_.on("error", reject); request_.end();
    });
    await check(undefined, 401);
    await check("Bearer wrong-token", 401);
    await check("Bearer ${token}", 200);
  `;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      docker(["exec", id, "node", "--input-type=module", "-e", source], "Checking authenticated worker health");
      return;
    } catch { /* The worker initializes its independent Pi runtime before listening. */ }
  }
  fail("The isolated worker did not become healthy with its configured token.");
}

function startWorker(image, name, fixture, state, extraEnvironment = [], testImage = false) {
  const command = ["--entrypoint", "node", image, "/app/dist/server.js"];
  const testFixture = testImage ? [
    "--env", "NODE_ENV=test", "--env", "VOIDSTATION_TEST_MODEL_FILE=/tmp/model.json", "--env", "VOIDSTATION_TEST_ASSERTIONS_FILE=/tmp/assertions.jsonl",
    "--volume", `${fixture.model}:/tmp/model.json:ro`, "--volume", `${fixture.assertions}:/tmp/assertions.jsonl`,
  ] : [];
  docker(["run", "--detach", "--name", name, "--network", "none", ...hardeningArguments(),
    "--env", "HOME=/home/node", "--env", "PATH=/home/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "--workdir", "/voidstation",
    "--env", "VOIDSTATION_WORKER_TOKEN_FILE=/run/voidstation-worker/token",
    "--env", "VOIDSTATION_CONVERSATION_DIR=/var/lib/voidstation/conversations",
    "--env", "VOIDSTATION_CREDENTIAL_DIR=/var/lib/voidstation/credentials",
    ...extraEnvironment, ...testFixture,
    "--volume", `${fixture.home}:/home/node:ro`, "--volume", `${fixture.cwd}:/voidstation:ro`,
    "--volume", `${fixture.token}:/run/voidstation-worker/token:ro`,
    "--volume", `${state.conversations}:/var/lib/voidstation/conversations`,
    "--volume", `${state.credentials}:/var/lib/voidstation/credentials`,
    ...command], "Starting an isolated worker runtime");
}

function requireFixtureTurnIsolation(image, fixture) {
  const name = `voidstation-worker-fixture-${randomUUID()}`;
  try {
    startWorker(image, name, fixture, fixture, [], true);
    healthCheck(name, fixture.tokenValue);
    docker(["exec", name, "node", "--input-type=module", "-e", `
      import { request } from "node:http";
      const call = (path, body) => new Promise((resolve, reject) => {
        const encoded = JSON.stringify(body);
        const request_ = request({ hostname: "127.0.0.1", port: 3001, path, method: "POST", headers: {
          authorization: "Bearer ${fixture.tokenValue}", "content-type": "application/json", "content-length": Buffer.byteLength(encoded),
        } }, (response) => {
          let text = ""; response.on("data", (chunk) => { text += chunk; });
          response.on("end", () => resolve({ status: response.statusCode, body: text }));
        });
        request_.on("error", reject); request_.end(encoded);
      });
      const created = await call("/conversations", {});
      if (created.status !== 201) throw new Error(\`conversation creation returned \${created.status}\`);
      const conversation = JSON.parse(created.body);
      const submitted = await call(\`/conversations/\${conversation.id}/turns\`, { text: "fixture isolation request" });
      if (submitted.status !== 202) throw new Error(\`turn submission returned \${submitted.status}\`);
    `], "Submitting a deterministic fixture turn");
    const deadline = Date.now() + 10_000;
    let captures = [];
    while (Date.now() < deadline) {
      const content = readFileSync(fixture.assertions, "utf8").trim();
      if (content) {
        captures = content.split("\n").map((line) => JSON.parse(line));
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (captures.length === 0) fail("The deterministic fixture did not capture a real Pi model context.");
    const capture = captures.at(-1);
    if (!Array.isArray(capture.tools) || capture.tools.length !== 0) fail("The real Pi model context exposed tools.");
    if (typeof capture.systemPrompt !== "string") fail("The model capture omitted its system prompt.");
    const serialized = JSON.stringify(capture);
    for (const canary of ["HOST_PI_SKILL_CANARY", "HOST_AGENTS_SKILL_CANARY", "CWD_SKILL_CANARY", "CWD_AGENTS_CANARY", "synthetic-host-auth", "HOST_PI_EXECUTABLE_CANARY"]) {
      if (serialized.includes(canary)) fail(`The real Pi model context discovered synthetic resource ${canary}.`);
    }
  } finally {
    try { docker(["rm", "--force", name], "Removing deterministic fixture worker"); } catch { /* The container may not have started. */ }
  }
}

function requireProductionFixtureRefusal(image, fixture) {
  const control = `voidstation-worker-fixture-control-${randomUUID()}`;
  const refusal = `voidstation-worker-fixture-refusal-${randomUUID()}`;
  const state = { conversations: fixture.refusalConversations, credentials: fixture.refusalCredentials };
  try {
    // This exact synthetic token and state must start without the fixture first.
    startWorker(image, control, fixture, state);
    healthCheck(control, fixture.tokenValue);
    docker(["rm", "--force", control], "Stopping the fixture-free production worker");
    startWorker(image, refusal, fixture, state, ["--env", "VOIDSTATION_TEST_MODEL_FILE=/tmp/model.json"]);
    const deadline = Date.now() + 10_000;
    let container;
    do {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      container = dockerJson(["inspect", refusal], "Inspecting production fixture refusal")[0];
    } while (container?.State?.Running && Date.now() < deadline);
    if (container?.State?.Running || container?.State?.ExitCode === 0) fail("Production worker accepted VOIDSTATION_TEST_MODEL_FILE.");
  } finally {
    for (const name of [control, refusal]) {
      try { docker(["rm", "--force", name], "Removing production fixture container"); } catch { /* The container may not have started. */ }
    }
  }
}

function createFixtures() {
  const root = mkdtempSync(path.join(tmpdir(), "voidstation-worker-runtime-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  const conversations = path.join(root, "conversations");
  const credentials = path.join(root, "credentials");
  const refusalConversations = path.join(root, "refusal-conversations");
  const refusalCredentials = path.join(root, "refusal-credentials");
  const token = path.join(root, "worker-token");
  const model = path.join(root, "model.json");
  const assertions = path.join(root, "assertions.jsonl");
  mkdirSync(path.join(home, ".pi", "agent", "sessions"), { recursive: true });
  mkdirSync(path.join(home, ".pi", "agent", "extensions"), { recursive: true });
  mkdirSync(path.join(home, ".pi", "agent", "skills", "host-canary"), { recursive: true });
  mkdirSync(path.join(home, ".agents", "skills", "host-canary"), { recursive: true });
  mkdirSync(path.join(home, "bin"), { recursive: true });
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  mkdirSync(conversations, { recursive: true });
  mkdirSync(credentials, { recursive: true });
  mkdirSync(refusalConversations, { recursive: true });
  mkdirSync(refusalCredentials, { recursive: true });
  writeFileSync(path.join(home, ".pi", "agent", "settings.json"), '{"extensions":["./extensions/unsafe.mjs"]}');
  writeFileSync(path.join(home, ".pi", "agent", "auth.json"), '{"token":"synthetic-host-auth"}');
  writeFileSync(path.join(home, ".pi", "agent", "sessions", "history.jsonl"), '{"synthetic":true}\n');
  writeFileSync(path.join(home, ".pi", "agent", "extensions", "unsafe.mjs"), "throw new Error('synthetic extension loaded');\n");
  writeFileSync(path.join(home, ".pi", "agent", "skills", "host-canary", "SKILL.md"), "---\nname: host-canary\ndescription: HOST_PI_SKILL_CANARY\n---\nHOST_PI_SKILL_CANARY\n");
  writeFileSync(path.join(home, ".agents", "skills", "host-canary", "SKILL.md"), "---\nname: host-canary\ndescription: HOST_AGENTS_SKILL_CANARY\n---\nHOST_AGENTS_SKILL_CANARY\n");
  writeFileSync(path.join(home, "bin", "pi"), "#!/bin/sh\necho HOST_PI_EXECUTABLE_CANARY >&2\nexit 91\n");
  writeFileSync(path.join(cwd, ".pi", "settings.json"), '{"extensions":["cwd-canary"]}');
  writeFileSync(path.join(cwd, "SKILL.md"), "CWD_SKILL_CANARY\n");
  writeFileSync(path.join(cwd, "AGENTS.md"), "CWD_AGENTS_CANARY\n");
  const tokenValue = "synthetic-worker-secret-canary-123456789";
  writeFileSync(token, tokenValue);
  writeFileSync(model, '{"steps":[{"text":"test reply"}]}');
  writeFileSync(assertions, "");
  chmodSync(path.join(home, "bin", "pi"), 0o755);
  for (const directory of [root, home, cwd, conversations, credentials, refusalConversations, refusalCredentials]) chmodSync(directory, 0o777);
  chmodSync(token, 0o644);
  chmodSync(assertions, 0o666);
  return { root, home, cwd, conversations, credentials, refusalConversations, refusalCredentials, token, model, assertions, tokenValue };
}

function requireRuntimeIsolation(image, testImage) {
  const fixture = createFixtures();
  const containerName = `voidstation-worker-inspect-${randomUUID()}`;
  try {
    requireInstalledPackages(image);
    requireProductionAdapterAbsent(image);
    if (testImage) requireFixtureTurnIsolation(testImage, fixture);
    docker(["run", "--detach", "--name", containerName, "--network", "none", ...hardeningArguments(),
      "--env", "VOIDSTATION_WORKER_TOKEN_FILE=/run/voidstation-worker/token",
      "--env", "VOIDSTATION_CONVERSATION_DIR=/var/lib/voidstation/conversations",
      "--env", "VOIDSTATION_CREDENTIAL_DIR=/var/lib/voidstation/credentials",
      "--volume", `${fixture.token}:/run/voidstation-worker/token:ro`,
      "--volume", `${fixture.conversations}:/var/lib/voidstation/conversations`,
      "--volume", `${fixture.credentials}:/var/lib/voidstation/credentials`, image], "Starting the isolated worker runtime");
    inspectContainer(containerName, fixture);
    healthCheck(containerName, fixture.tokenValue);
    // A new container process commonly reuses PID 1. Its predecessor's lock
    // must be released by the kernel, not guessed from a persisted PID file.
    docker(["restart", "--time", "5", containerName], "Restarting the isolated worker container");
    healthCheck(containerName, fixture.tokenValue);
    requireProductionFixtureRefusal(image, fixture);
  } finally {
    try { docker(["rm", "--force", containerName], "Removing the isolated worker container"); } catch { /* The container may not have started. */ }
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function main() {
  const [image, testImage] = process.argv.slice(2);
  if (!image || process.argv.length > 4) fail("Usage: worker-runtime-inspect.mjs RUNTIME_IMAGE [TEST_IMAGE]");
  assertMetadata(image);
  requireRuntimeIsolation(image, testImage);
  console.log("Worker runtime image and isolation inspection passed.");
}

try {
  main();
} catch (error) {
  console.error(`Worker runtime image inspection failed: ${error.message}`);
  process.exitCode = 1;
}
