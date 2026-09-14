import { afterAll, beforeAll, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assistantServer, type AssistantServer } from "./helpers/assistant-server";

let server: AssistantServer;
let laptop: string;
let phone: string;
const conversations = "/api/assistant/conversations";

type Detail = { id: string; title: string; messages: { id: string; role: string; text: string }[];
  turn: null | { id: string; status: string; error: string | null } };

async function create() {
  const response = await server.mutate(conversations, "POST", {}, laptop);
  expect(response.status).toBe(201);
  return await response.json() as Detail;
}
async function history(id: string, cookie = phone, request = server.lanRequest) {
  const response = await request(`${conversations}/${id}`, {}, cookie);
  expect(response.status).toBe(200);
  return await response.json() as Detail;
}
async function snapshot(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let buffer = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("Stream ended before a snapshot");
    buffer += decoder.decode(value, { stream: true });
    for (const event of buffer.split("\n\n").slice(0, -1)) {
      const data = event.split("\n").find((line) => line.startsWith("data: "));
      if (event.includes("event: snapshot") && data) return JSON.parse(data.slice(6)) as Detail;
    }
    const boundary = buffer.lastIndexOf("\n\n");
    if (boundary >= 0) buffer = buffer.slice(boundary + 2);
  }
}
async function streamEnds(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      (async () => { while (!(await reader.read()).done) { /* Drain snapshots. */ } return true; })(),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2500); }),
    ]);
  } finally { clearTimeout(timer!); }
}
async function settled(id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const detail = await history(id);
    if (detail.turn?.status !== "running") return detail;
    await delay(30);
  }
  throw new Error("Turn did not finish");
}

beforeAll(async () => {
  server = await assistantServer();
  laptop = await server.session();
  phone = await server.lanSession();
}, 40_000);
afterAll(async () => { await server?.close(); });

it("keeps Assistant endpoints private and preserves Dashboard access when the worker is unavailable", async () => {
  expect((await server.request("/assistant")).status).toBe(307);
  for (const path of [conversations, `${conversations}/some-id`, `${conversations}/some-id/events`]) {
    expect((await server.request(path)).status).toBe(401);
  }
  expect((await server.mutate(conversations, "POST", {}, "")).status).toBe(401);
  expect((await server.request(conversations, { method: "POST", headers: { origin: "https://attacker.test" } }, laptop)).status).toBe(403);
  expect((await server.request(conversations, {}, laptop)).status).toBe(503);
  expect((await server.request("/", {}, laptop)).status).toBe(200);
  expect((await server.request("/api/metrics", {}, phone)).status).toBe(200);
});

it("shares Assistant history between Tailscale and LAN HTTPS sessions", async () => {
  await server.startWorker();
  const first = await create();
  const second = await create();
  const lanCreated = await server.lanMutate(conversations, "POST", {}, phone);
  expect(lanCreated.status).toBe(201);
  const lanConversation = await lanCreated.json() as Detail;
  expect(second.id).not.toBe(first.id);
  expect((await history(first.id)).messages).toEqual([]);
  const lanStream = await server.lanStream(`${conversations}/${lanConversation.id}/events`, phone);
  try {
    expect(lanStream.status).toBe(200);
    expect((await snapshot(lanStream.reader)).messages).toEqual([]);
  } finally { lanStream.close(); }
  await server.fixture([{ text: "A saved reply." }]);
  const accepted = await server.mutate(`${conversations}/${first.id}/turns`, "POST", { text: "Remember this conversation" }, laptop);
  expect(accepted.status).toBe(202);
  const turn = await accepted.json();
  const detail = await settled(first.id);
  expect(detail.turn).toMatchObject({ id: turn.id, status: "complete", error: null });
  expect(detail.messages.map(({ role, text }) => ({ role, text }))).toEqual([
    { role: "user", text: "Remember this conversation" }, { role: "assistant", text: "A saved reply." },
  ]);
  expect((await history(second.id)).messages).toEqual([]);
  const list = await (await server.lanRequest(conversations, {}, phone)).json();
  expect(list.conversations.map((item: Detail) => item.id)).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(await history(first.id, laptop, server.request)).toEqual(detail);
});

it("rejects competing device turns and active deletion while work survives stream disconnection", async () => {
  const conversation = await create();
  await server.fixture([{ text: "Finished after the browser disconnected.", delayMs: 600 }]);
  const responses = await Promise.all([laptop, phone].map((cookie) =>
    server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Continue without my browser" }, cookie)));
  expect(responses.map(({ status }) => status).sort()).toEqual([202, 409]);
  expect((await server.mutate(`${conversations}/${conversation.id}`, "DELETE", undefined, phone)).status).toBe(409);
  const stream = await server.stream(`${conversations}/${conversation.id}/events`, laptop);
  try {
    expect(stream.status).toBe(200);
    expect((await snapshot(stream.reader)).turn?.status).toBe("running");
  } finally { stream.close(); }
  const complete = await settled(conversation.id);
  expect(complete.turn?.status).toBe("complete");
  expect(complete.messages.filter(({ role }) => role === "user")).toHaveLength(1);
  const reconnect = await server.stream(`${conversations}/${conversation.id}/events`, phone);
  try { expect(await snapshot(reconnect.reader)).toEqual(complete); }
  finally { reconnect.close(); }
});

it("streams partial Pi text and reconnects to current live state before completion", async () => {
  const conversation = await create();
  await server.fixture([{ chunks: [{ text: "First part", delayMs: 30 }, { text: " and the rest.", delayMs: 600 }] }]);
  expect((await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Stream this reply" }, laptop)).status).toBe(202);
  const stream = await server.stream(`${conversations}/${conversation.id}/events`, laptop);
  let partial: Detail;
  try {
    do { partial = await snapshot(stream.reader); }
    while (!partial.messages.some(({ text }) => text === "First part"));
    expect(partial.turn?.status).toBe("running");
  } finally { stream.close(); }
  const phoneStream = await server.stream(`${conversations}/${conversation.id}/events`, phone);
  try { expect(await snapshot(phoneStream.reader)).toEqual(partial!); }
  finally { phoneStream.close(); }
  const complete = await settled(conversation.id);
  expect(complete.turn?.status).toBe("complete");
  expect(complete.messages.at(-1)).toEqual({ ...partial!.messages.at(-1), text: "First part and the rest." });
});

it("retains history after a worker crash, marks interrupted turns, and never restarts old work", async () => {
  const conversation = await create();
  await server.fixture([{ text: "The first saved answer." }]);
  expect((await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Save this" }, laptop)).status).toBe(202);
  const saved = await settled(conversation.id);
  await server.fixture([{ text: "This must never complete.", delayMs: 5000 }]);
  const response = await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Interrupted request" }, phone);
  expect(response.status).toBe(202);
  const interruptedTurn = await response.json();
  await server.stopWorker("SIGKILL");
  await server.startWorker();
  const restored = await history(conversation.id);
  expect(restored.turn).toMatchObject({ id: interruptedTurn.id, status: "interrupted" });
  expect(restored.messages.slice(0, saved.messages.length)).toEqual(saved.messages);
  expect(restored.messages.filter(({ text }) => text === "Interrupted request")).toHaveLength(1);
  expect(restored.messages.some(({ text }) => text === "This must never complete.")).toBe(false);
  await server.fixture([{ text: "A new, explicit turn." }]);
  expect((await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Start new work" }, laptop)).status).toBe(202);
  const resumed = await settled(conversation.id);
  expect(resumed.turn?.status).toBe("complete");
  expect(resumed.messages.filter(({ text }) => text === "Interrupted request")).toHaveLength(1);
  expect(resumed.messages.at(-1)?.text).toBe("A new, explicit turn.");
});

it("deletes idle history across devices and keeps it deleted after restart", async () => {
  const conversation = await create();
  await server.fixture([{ text: "Delete this saved reply." }]);
  expect((await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "An idle conversation" }, laptop)).status).toBe(202);
  await settled(conversation.id);
  const stream = await server.stream(`${conversations}/${conversation.id}/events`, laptop);
  try {
    await snapshot(stream.reader);
    expect((await server.mutate(`${conversations}/${conversation.id}`, "DELETE", undefined, phone)).status).toBe(204);
    expect(await streamEnds(stream.reader)).toBe(true);
  } finally { stream.close(); }
  for (const suffix of ["", "/events"]) {
    expect((await server.request(`${conversations}/${conversation.id}${suffix}`, {}, laptop)).status).toBe(404);
  }
  await server.stopWorker();
  await server.startWorker();
  expect((await server.request(`${conversations}/${conversation.id}`, {}, phone)).status).toBe(404);
  const list = await (await server.request(conversations, {}, phone)).json();
  expect(list.conversations.map((item: Detail) => item.id)).not.toContain(conversation.id);
  expect((await server.request("/api/metrics", {}, phone)).status).toBe(200);
});

it("protects every history, stream, and mutation route and rejects browser-controlled model configuration", async () => {
  const conversation = await create();
  const item = `${conversations}/${conversation.id}`;
  for (const path of [conversations, item, `${item}/events`]) {
    expect((await server.request(path)).status).toBe(401);
    expect((await server.request(path, {}, "__Host-voidstation-session=forged")).status).toBe(401);
  }
  for (const [path, method, body] of [[conversations, "POST", {}], [item, "DELETE", undefined], [`${item}/turns`, "POST", { text: "No CSRF" }]] as const) {
    expect((await server.mutate(path, method, body, "")).status).toBe(401);
    expect((await server.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, laptop)).status).toBe(403);
    expect((await server.request(path, { method, headers: { origin: "https://attacker.test" }, body: JSON.stringify(body) }, laptop)).status).toBe(403);
  }
  for (const body of [{ text: "Hello", model: "fixture" }, { text: "Hello", provider: "paid" }, { text: "Hello", fixture: { text: "injected" } }, { text: "x".repeat(8001) }, { text: " " }]) {
    expect((await server.mutate(`${item}/turns`, "POST", body, laptop)).status).toBe(400);
  }
  expect((await history(conversation.id)).messages).toEqual([]);
  for (const path of ["/health", "/conversations", `/conversations/${conversation.id}/events`]) {
    expect((await server.internal(path)).status).toBe(401);
    expect((await server.internal(path, { authorization: "Bearer forged" })).status).toBe(401);
  }
  expect((await server.internal("/health", { authorization: `Bearer ${server.token}` })).status).toBe(200);
  expect((await server.internal("/health", { authorization: `Bearer ${server.token}`, origin: server.origin })).status).toBe(401);
  expect((await server.internal("/health", { authorization: `Bearer ${server.token}`, "sec-fetch-site": "cross-site" })).status).toBe(401);
  expect(server.output).not.toContain(server.token);
});

it("bounds hung model work and interrupts active work on graceful worker shutdown", async () => {
  await server.stopWorker();
  await server.startWorker({ VOIDSTATION_TURN_TIMEOUT_MS: "1000" });
  const conversation = await create();
  await server.fixture([{ error: "hang" }]);
  expect((await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "A bounded request" }, laptop)).status).toBe(202);
  const failed = await settled(conversation.id);
  expect(failed.turn?.status).toBe("failure");
  expect(failed.turn?.error).toMatch(/too long/i);
  expect((await server.mutate(`${conversations}/${conversation.id}`, "DELETE", undefined, phone)).status).toBe(204);
  await server.stopWorker();
  await server.startWorker();
  const active = await create();
  expect((await server.mutate(`${conversations}/${active.id}/turns`, "POST", { text: "Stop the worker, not my browser" }, laptop)).status).toBe(202);
  const stream = await server.stream(`${conversations}/${active.id}/events`, phone);
  try {
    expect((await snapshot(stream.reader)).turn?.status).toBe("running");
    await server.stopWorker();
    expect(await streamEnds(stream.reader)).toBe(true);
  } finally { stream.close(); }
  await server.startWorker();
  const restored = await history(active.id);
  expect(restored.turn?.status).toBe("interrupted");
  expect(restored.messages[0].text).toBe("Stop the worker, not my browser");
});

it.each([
  ["authentication", /authentication|login/i],
  ["limits", /limits|exhausted/i],
  ["unavailable", /provider.*unavailable/i],
] as const)("explains provider %s failures and stops new model work without hiding saved history", async (failure, explanation) => {
  await server.stopWorker();
  await server.startWorker();
  const conversation = await create();
  await server.fixture([{ error: failure }]);
  expect((await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Keep this during an outage" }, laptop)).status).toBe(202);
  const failed = await settled(conversation.id);
  expect(failed.turn?.status).toBe("failure");
  expect(failed.turn?.error).toMatch(explanation);
  expect(failed.messages[0].text).toBe("Keep this during an outage");
  // A changed model fixture cannot silently restore access or choose a paid fallback.
  await server.fixture([{ text: "This should not run while access is blocked." }]);
  const blocked = await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Do not start" }, phone);
  expect(blocked.status).toBe(503);
  expect((await blocked.json()).error).toMatch(explanation);
  expect(await history(conversation.id)).toEqual(failed);
  expect((await server.request(conversations, {}, phone)).status).toBe(200);
  expect((await server.request("/", {}, phone)).status).toBe(200);
});

it("keeps synthetic provider errors and internal secrets out of history, Pi transcripts, model context, and logs", async () => {
  await server.stopWorker();
  const assertions = join(server.directory, "model-assertions.jsonl");
  await server.startWorker({ VOIDSTATION_TEST_ASSERTIONS_FILE: assertions });
  const conversation = await create();
  const canary = "synthetic-provider-secret-canary-do-not-disclose";
  await server.fixture([{ error: "unavailable", rawError: canary }]);
  expect((await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Return a safe failure" }, laptop)).status).toBe(202);
  const failed = await settled(conversation.id);
  expect(failed.turn?.status).toBe("failure");
  const context = await readFile(assertions, "utf8");
  expect(JSON.parse(context.trim()).tools).toEqual([]);
  const transcriptRoot = join(server.directory, "conversations", "transcripts");
  const transcripts = await readdir(transcriptRoot, { recursive: true });
  const content = await Promise.all(transcripts.filter((path) => path.endsWith(".jsonl")).map((path) => readFile(join(transcriptRoot, path), "utf8")));
  expect(content.length).toBeGreaterThan(0);
  for (const value of [JSON.stringify(failed), await (await server.request(conversations, {}, phone)).text(), context, server.output, ...content]) {
    expect(value).not.toContain(canary);
    expect(value).not.toContain(server.token);
  }
});

it("keeps timed-out work locked until an uncooperative provider is gone", async () => {
  await server.stopWorker();
  await server.startWorker({ VOIDSTATION_TURN_TIMEOUT_MS: "1000", VOIDSTATION_SHUTDOWN_TIMEOUT_MS: "1200" });
  const conversation = await create();
  await server.fixture([{ error: "hang", ignoreAbort: true }]);
  expect((await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "A provider that ignores cancellation" }, laptop)).status).toBe(202);
  expect((await settled(conversation.id)).turn?.status).toBe("failure");
  expect((await server.mutate(`${conversations}/${conversation.id}`, "DELETE", undefined, phone)).status).toBe(409);
  expect((await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Do not overlap" }, phone)).status).toBe(409);
  const deadline = Date.now() + 5000;
  let stopped = false;
  while (Date.now() < deadline) {
    if ((await server.request(`${conversations}/${conversation.id}`, {}, phone)).status === 503) { stopped = true; break; }
    await delay(50);
  }
  expect(stopped).toBe(true);
  await server.stopWorker();
  await server.startWorker();
  expect((await history(conversation.id)).messages.map(({ text }) => text)).toEqual(["A provider that ignores cancellation"]);
  expect((await server.mutate(`${conversations}/${conversation.id}`, "DELETE", undefined, phone)).status).toBe(204);
});

it.each(["construct", "iterator"])("contains provider %s exceptions without leaking raw errors or crashing the worker", async (fault) => {
  await server.stopWorker();
  await server.startWorker();
  const conversation = await create();
  const canary = "synthetic-stream-exception-secret-canary";
  await server.fixture([{ fault, rawError: canary }]);
  expect((await server.mutate(`${conversations}/${conversation.id}/turns`, "POST", { text: "Handle a broken provider stream" }, laptop)).status).toBe(202);
  const failed = await settled(conversation.id);
  expect(failed.turn?.status).toBe("failure");
  expect(JSON.stringify(failed)).not.toContain(canary);
  expect(server.output).not.toContain(canary);
  expect((await server.request(conversations, {}, phone)).status).toBe(200);
});

it("revokes an already-open conversation stream when its device signs out", async () => {
  const signedOutDevice = await server.session();
  const conversation = await create();
  const stream = await server.stream(`${conversations}/${conversation.id}/events`, signedOutDevice);
  try {
    await snapshot(stream.reader);
    expect((await server.mutate("/api/auth/logout", "POST", {}, signedOutDevice)).status).toBe(200);
    expect(await streamEnds(stream.reader)).toBe(true);
    expect((await server.request(`${conversations}/${conversation.id}/events`, {}, signedOutDevice)).status).toBe(401);
    expect((await server.request(`${conversations}/${conversation.id}`, {}, phone)).status).toBe(200);
  } finally { stream.close(); }
});
