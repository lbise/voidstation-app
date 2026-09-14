import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createAgentSession, SessionManager, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Conversation, ConversationDetail, ErrorResponse, Message, Turn } from "./contract.ts";
import { EmptyResourceLoader, codexModel, createCodexRuntime, emptySettings, installSanitizedProvider, providerFailure, type ProviderFailureKind } from "./pi.ts";
import { ConversationStore } from "./store.ts";

const MAX_BODY_BYTES = 20_000;
const MAX_TEXT_LENGTH = 8_000;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PROVIDER_COOLDOWN_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4_000;

type ProviderGate = { kind: Exclude<ProviderFailureKind, "unknown">; error: string; until: number | null };
type Submission = Turn | "missing" | "running" | { kind: "provider"; error: string };

interface Config {
  token: string;
  host: string;
  port: number;
  conversationDir: string;
  credentialDir: string;
  turnTimeoutMs: number;
  providerCooldownMs: number;
  shutdownTimeoutMs: number;
}

interface ActiveTurn {
  conversationId: string;
  turnId: string;
  live: Message;
  abort: AbortController;
  settled: boolean;
  session?: AgentSession;
  promise?: Promise<void>;
  forceExitTimer?: ReturnType<typeof setTimeout>;
}

class Worker {
  private readonly changes = new EventEmitter();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly sseResponses = new Set<ServerResponse>();
  private stopping = false;
  private closed = false;
  private fixture = false;
  private gate?: ProviderGate;
  private model!: Model<any>;
  private runtime!: ModelRuntime;
  readonly store: ConversationStore;

  constructor(privateConfig: Config) {
    this.config = privateConfig;
    this.store = new ConversationStore(privateConfig.conversationDir);
  }

  private readonly config: Config;

  async initialize(): Promise<void> {
    this.runtime = await createCodexRuntime(this.config.credentialDir);
    this.fixture = Boolean(process.env.VOIDSTATION_TEST_MODEL_FILE);
    if (this.fixture) {
      if (process.env.NODE_ENV !== "test") throw new Error("The deterministic model fixture is test-only.");
      const { installFixtureModel } = await import("./test-fixture.ts");
      this.model = installFixtureModel(this.runtime);
      installSanitizedProvider(this.runtime, "voidstation-test");
      return;
    }
    if (process.env.OPENAI_API_KEY) throw new Error("API-key provider configuration is not allowed.");
    const credentials = await this.runtime.listCredentials();
    if (credentials.some((credential) => credential.providerId === "openai-codex" && credential.type !== "oauth")) {
      throw new Error("Only OpenAI Codex OAuth credentials are allowed.");
    }
    installSanitizedProvider(this.runtime, "openai-codex");
    this.model = codexModel(this.runtime);
  }

  createConversation(): Conversation {
    const manager = SessionManager.create("/voidstation", join(this.config.conversationDir, "transcripts"));
    const transcriptPath = manager.getSessionFile();
    if (!transcriptPath) throw new Error("Could not create the durable Pi transcript.");
    const conversation = this.store.createConversation(transcriptPath);
    this.emit(conversation.id);
    return conversation;
  }

  async submitTurn(conversationId: string, text: string): Promise<Submission> {
    if (this.hasActiveTurn(conversationId)) return "running";
    const blocked = await this.providerBlocked();
    if (blocked) return { kind: "provider", error: blocked };
    const turn = this.store.startTurn(conversationId, text);
    if (typeof turn === "string") return turn;
    const task: ActiveTurn = {
      conversationId,
      turnId: turn.id,
      live: { id: randomUUID(), role: "assistant", text: "" },
      abort: new AbortController(),
      settled: false,
    };
    this.activeTurns.set(turn.id, task);
    task.promise = this.runTurn(task, text);
    void task.promise;
    this.emit(conversationId);
    return turn;
  }

  deleteConversation(conversationId: string): "missing" | "running" | "deleted" {
    return this.hasActiveTurn(conversationId) ? "running" : this.store.deleteConversation(conversationId);
  }

  private hasActiveTurn(conversationId: string): boolean {
    return [...this.activeTurns.values()].some((task) => task.conversationId === conversationId);
  }

  detail(conversationId: string): ConversationDetail | undefined {
    const detail = this.store.getDetail(conversationId);
    if (!detail || detail.turn?.status !== "running") return detail;
    const task = this.activeTurns.get(detail.turn.id);
    return task ? { ...detail, messages: [...detail.messages, task.live] } : detail;
  }

  closeSse(response: ServerResponse): () => void {
    this.sseResponses.add(response);
    return () => this.sseResponses.delete(response);
  }

  async shutdown(): Promise<boolean> {
    if (this.closed) return true;
    this.stopping = true;
    for (const response of this.sseResponses) response.end();
    this.sseResponses.clear();
    for (const task of this.activeTurns.values()) {
      task.abort.abort();
      void task.session?.abort().catch(() => {});
      this.settle(task, "interrupted", "The worker stopped before this reply finished.");
    }
    const tasks = [...this.activeTurns.values()].map((task) => task.promise).filter((promise): promise is Promise<void> => Boolean(promise));
    let deadline: ReturnType<typeof setTimeout>;
    const completed = await Promise.race([
      Promise.allSettled(tasks).then(() => true),
      new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), this.config.shutdownTimeoutMs); }),
    ]);
    clearTimeout(deadline!);
    if (completed) {
      this.store.close();
      this.closed = true;
    }
    return completed;
  }

  private async providerBlocked(): Promise<string | undefined> {
    if (this.gate && (this.gate.until === null || this.gate.until > Date.now())) return this.gate.error;
    this.gate = undefined;
    if (this.fixture) return undefined;
    const auth = await this.runtime.checkAuth("openai-codex");
    if (auth?.type === "oauth") return undefined;
    const failure = providerFailure("authentication");
    this.setGate(failure.kind, failure.message);
    return failure.message;
  }

  private setGate(kind: ProviderFailureKind, error: string): void {
    if (kind === "unknown") return;
    this.gate = {
      kind,
      error,
      until: kind === "authentication" ? null : Date.now() + this.config.providerCooldownMs,
    };
  }

  private async runTurn(task: ActiveTurn, text: string): Promise<void> {
    const timeout = setTimeout(() => {
      task.abort.abort();
      void task.session?.abort().catch(() => {});
      const failure = providerFailure("timeout");
      this.setGate(failure.kind, failure.message);
      this.settle(task, "failure", "The assistant took too long to reply.");
      // Do not release this conversation while Pi may still append its transcript.
      task.forceExitTimer = setTimeout(() => {
        if (this.activeTurns.has(task.turnId)) process.exit(1);
      }, this.config.shutdownTimeoutMs);
    }, this.config.turnTimeoutMs);
    let unsubscribe: (() => void) | undefined;
    try {
      const transcriptPath = this.store.getTranscriptPath(task.conversationId);
      if (!transcriptPath || task.settled || this.stopping) return;
      const sessionManager = SessionManager.open(transcriptPath, join(this.config.conversationDir, "transcripts"), "/voidstation");
      const created = await createAgentSession({
        cwd: "/voidstation",
        agentDir: this.config.credentialDir,
        modelRuntime: this.runtime,
        model: this.model,
        thinkingLevel: "medium",
        noTools: "all",
        tools: [],
        resourceLoader: new EmptyResourceLoader(),
        settingsManager: emptySettings(),
        sessionManager,
      });
      task.session = created.session;
      unsubscribe = task.session.subscribe((event) => {
        if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta" || task.settled) return;
        task.live.text += event.assistantMessageEvent.delta;
        this.emit(task.conversationId);
      });
      if (task.settled || this.stopping || task.abort.signal.aborted) {
        await task.session.abort();
        return;
      }
      await task.session.prompt(text);
      if (task.settled) return;
      if (this.stopping) {
        this.settle(task, "interrupted", "The worker stopped before this reply finished.");
        return;
      }
      const rawError = assistantError(task.session);
      if (rawError) {
        const failure = providerFailure(rawError);
        this.setGate(failure.kind, failure.message);
        this.settle(task, "failure", failure.message);
      } else {
        this.settle(task, "complete", null, assistantText(task.session), task.live.id);
      }
    } catch (error) {
      if (!task.settled) {
        const failure = providerFailure(error);
        this.setGate(failure.kind, failure.message);
        this.settle(task, this.stopping ? "interrupted" : "failure", this.stopping ? "The worker stopped before this reply finished." : failure.message);
      }
    } finally {
      clearTimeout(timeout);
      if (task.forceExitTimer) clearTimeout(task.forceExitTimer);
      unsubscribe?.();
      task.session?.dispose();
      this.activeTurns.delete(task.turnId);
      this.emit(task.conversationId);
    }
  }

  private settle(task: ActiveTurn, status: "complete" | "interrupted" | "failure", error: string | null, text?: string, messageId?: string): void {
    if (task.settled) return;
    task.settled = true;
    this.store.finishTurn(task.conversationId, task.turnId, status, error, text, messageId);
    this.emit(task.conversationId);
  }

  private emit(conversationId: string): void { this.changes.emit(conversationId); }

  onChange(conversationId: string, listener: () => void): () => void {
    this.changes.on(conversationId, listener);
    return () => this.changes.off(conversationId, listener);
  }
}

function assistantText(session: AgentSession): string {
  const message = [...session.messages].reverse().find((candidate) => candidate.role === "assistant");
  return message?.role === "assistant" ? message.content.filter((content) => content.type === "text").map((content) => content.text).join("") : "";
}

function assistantError(session: AgentSession): string | undefined {
  const message = [...session.messages].reverse().find((candidate) => candidate.role === "assistant");
  if (message?.role === "assistant" && message.stopReason === "error") return message.errorMessage ?? "provider failure";
  return session.agent.state.errorMessage;
}

function parseConfig(): Config {
  const tokenFile = process.env.VOIDSTATION_WORKER_TOKEN_FILE;
  const conversationDir = process.env.VOIDSTATION_CONVERSATION_DIR;
  const credentialDir = process.env.VOIDSTATION_CREDENTIAL_DIR;
  if (!tokenFile || !conversationDir || !credentialDir || !isAbsolute(tokenFile) || !isAbsolute(conversationDir) || !isAbsolute(credentialDir)) {
    throw new Error("Worker state and token paths must be absolute and configured.");
  }
  const rawToken = readFileSync(tokenFile, "utf8");
  const token = rawToken.trim();
  if (rawToken !== token && rawToken !== `${token}\n`) throw new Error("Worker token is invalid.");
  if (token.length < 32 || /\s/.test(token)) throw new Error("Worker token is invalid.");
  const conversationRoot = resolve(conversationDir);
  const credentialRoot = resolve(credentialDir);
  if (conversationRoot === credentialRoot || containsPath(conversationRoot, credentialRoot) || containsPath(credentialRoot, conversationRoot)) {
    throw new Error("Conversation and credential directories must be disjoint.");
  }
  const port = Number(process.env.VOIDSTATION_WORKER_PORT ?? "3001");
  const turnTimeoutMs = Number(process.env.VOIDSTATION_TURN_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS);
  const providerCooldownMs = Number(process.env.VOIDSTATION_PROVIDER_COOLDOWN_MS ?? DEFAULT_PROVIDER_COOLDOWN_MS);
  const shutdownTimeoutMs = Number(process.env.VOIDSTATION_SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !validDuration(turnTimeoutMs, 1_000) || !validDuration(providerCooldownMs, 1_000) || !validDuration(shutdownTimeoutMs, 100)) {
    throw new Error("Worker network or timeout configuration is invalid.");
  }
  mkdirSync(conversationRoot, { recursive: true, mode: 0o700 });
  mkdirSync(credentialRoot, { recursive: true, mode: 0o700 });
  return { token, host: process.env.VOIDSTATION_WORKER_HOST ?? "0.0.0.0", port, conversationDir: conversationRoot, credentialDir: credentialRoot, turnTimeoutMs, providerCooldownMs, shutdownTimeoutMs };
}

function validDuration(value: number, minimum: number): boolean { return Number.isFinite(value) && value >= minimum; }
function containsPath(parent: string, child: string): boolean { const path = relative(parent, child); return path !== "" && !path.startsWith("..") && !isAbsolute(path); }

function authorized(request: IncomingMessage, token: string): boolean {
  // Node's internal fetch sends Sec-Fetch-Mode without browser provenance. Browsers also send Origin or Sec-Fetch-Site.
  if (request.headers.origin || request.headers["sec-fetch-site"] || request.headers["sec-fetch-dest"] || request.headers["sec-fetch-user"]) return false;
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("invalid request body");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw) as unknown; } catch { throw new Error("invalid request body"); }
}

function send(response: ServerResponse, status: number, payload?: unknown): void {
  if (status === 204) { response.writeHead(status); response.end(); return; }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function error(response: ServerResponse, status: number, message: string): void { send(response, status, { error: message } satisfies ErrorResponse); }
function validId(value: string | undefined): value is string { return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value); }

function streamSnapshots(response: ServerResponse, worker: Worker, id: string): void {
  const snapshot = () => {
    if (response.writableEnded) return;
    const detail = worker.detail(id);
    if (!detail) { response.end(); return; }
    response.write(`event: snapshot\ndata: ${JSON.stringify(detail satisfies ConversationDetail)}\n\n`);
  };
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  const detach = worker.closeSse(response);
  snapshot();
  const unsubscribe = worker.onChange(id, snapshot);
  const keepAlive = setInterval(snapshot, 1_000);
  response.on("close", () => { clearInterval(keepAlive); unsubscribe(); detach(); });
}

async function route(request: IncomingMessage, response: ServerResponse, worker: Worker, token: string): Promise<void> {
  if (!authorized(request, token)) return error(response, 401, "Unauthorized.");
  const url = new URL(request.url ?? "/", "http://worker.internal");
  const parts = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true });
  if (request.method === "GET" && url.pathname === "/conversations") return send(response, 200, { conversations: worker.store.listConversations() });
  if (request.method === "POST" && url.pathname === "/conversations") {
    const payload = await body(request);
    return isEmptyObject(payload) ? send(response, 201, worker.createConversation()) : error(response, 400, "Expected an empty object.");
  }
  if (parts[0] === "conversations" && validId(parts[1])) {
    const id = parts[1];
    if (request.method === "GET" && parts.length === 2) {
      const detail = worker.detail(id);
      return detail ? send(response, 200, detail) : error(response, 404, "Conversation not found.");
    }
    if (request.method === "DELETE" && parts.length === 2) {
      const deleted = worker.deleteConversation(id);
      if (deleted === "missing") return error(response, 404, "Conversation not found.");
      return deleted === "running" ? error(response, 409, "A running conversation cannot be deleted.") : send(response, 204);
    }
    if (request.method === "POST" && parts[2] === "turns" && parts.length === 3) {
      const payload = await body(request);
      if (!isTurnBody(payload)) return error(response, 400, "Expected one non-empty text string up to 8,000 characters.");
      const submitted = await worker.submitTurn(id, payload.text);
      if (submitted === "missing") return error(response, 404, "Conversation not found.");
      if (submitted === "running") return error(response, 409, "This conversation already has a running turn.");
      if ("kind" in submitted) return error(response, 503, submitted.error);
      return send(response, 202, submitted);
    }
    if (request.method === "GET" && parts[2] === "events" && parts.length === 3) {
      return worker.detail(id) ? streamSnapshots(response, worker, id) : error(response, 404, "Conversation not found.");
    }
  }
  return error(response, 404, "Not found.");
}

function isEmptyObject(value: unknown): value is Record<string, never> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0; }
function isTurnBody(value: unknown): value is { text: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 1
    && typeof (value as { text?: unknown }).text === "string" && (value as { text: string }).text.trim().length > 0
    && (value as { text: string }).text.length <= MAX_TEXT_LENGTH;
}

function acquireSingleton(conversationDir: string): () => void {
  const path = join(conversationDir, "worker-lock.sqlite");
  const database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch {
    database.close();
    throw new Error("Another worker process already owns this state directory.");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { database.exec("COMMIT;"); } finally { database.close(); }
  };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const config = parseConfig();
  const releaseSingleton = acquireSingleton(config.conversationDir);
  try {
    const worker = new Worker(config);
    await worker.initialize();
    const server = createServer((request, response) => {
      void route(request, response, worker, config.token).catch(() => error(response, 400, "Invalid worker request."));
    });
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      server.close();
      server.closeAllConnections();
      void worker.shutdown().then((clean) => {
        if (clean) releaseSingleton();
        else process.exit(1);
      });
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    server.listen(config.port, config.host);
  } catch (error) {
    releaseSingleton();
    throw error;
  }
}

void main().catch(() => { process.exitCode = 1; });
