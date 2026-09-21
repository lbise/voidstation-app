import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createAgentSession, SessionManager, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AssistantModelOption, AssistantProviderId, AssistantProviderOption, AssistantSettings, Conversation, ConversationDetail, ErrorResponse, Message, ToolCallRecord, Turn } from "./contract.ts";
import { RestrictedResourceLoader, codexModel, codexModels, createCodexRuntime, emptySettings, installSanitizedProvider, providerFailure, type ProviderFailureKind } from "./pi.ts";
import { ConversationStore } from "./store.ts";
import { createMediaTools } from "./media.ts";
import type { MediaResult } from "./media-contract.ts";

const MAX_BODY_BYTES = 20_000;
const MAX_TEXT_LENGTH = 8_000;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PROVIDER_COOLDOWN_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4_000;

type ProviderGate = { kind: Exclude<ProviderFailureKind, "unknown">; error: string; until: number | null };
type Selection = { provider: AssistantProviderId; model: string };
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
  provider: AssistantProviderId;
  model: string;
  live?: Message;
  toolArgs: Map<string, Record<string, unknown>>;
  toolIds: Map<string, string>;
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
  private readonly gates = new Map<AssistantProviderId, ProviderGate>();
  private fixtureModel!: Model<any>;
  private selection: Selection = { provider: "openai-codex", model: "gpt-5.5" };
  private runtime!: ModelRuntime;
  readonly store: ConversationStore;

  constructor(privateConfig: Config) {
    this.config = privateConfig;
    this.store = new ConversationStore(privateConfig.conversationDir);
  }

  private readonly config: Config;

  async initialize(): Promise<void> {
    this.runtime = await createCodexRuntime(this.config.credentialDir);
    await this.loadOpenRouterApiKey();
    this.fixture = Boolean(process.env.VOIDSTATION_TEST_MODEL_FILE);
    if (this.fixture) {
      if (process.env.NODE_ENV !== "test") throw new Error("The deterministic model fixture is test-only.");
      const { installFixtureModel } = await import("./test-fixture.ts");
      this.fixtureModel = installFixtureModel(this.runtime);
      installSanitizedProvider(this.runtime, "voidstation-test");
    } else {
      if (process.env.OPENAI_API_KEY) throw new Error("API-key provider configuration is not allowed.");
      const credentials = await this.runtime.listCredentials();
      if (credentials.some((credential) => credential.providerId === "openai-codex" && credential.type !== "oauth")) {
        throw new Error("Only OpenAI Codex OAuth credentials are allowed.");
      }
      installSanitizedProvider(this.runtime, "openai-codex");
      installSanitizedProvider(this.runtime, "openrouter");
    }
    const saved = this.store.getAssistantSettings();
    const provider = isProviderId(saved.provider) ? saved.provider : "openai-codex";
    const model = isProviderId(saved.provider) && this.validModel(provider, saved.model) ? saved.model : this.defaultModel(provider);
    this.selection = { provider, model };
    if (saved.provider !== provider || saved.model !== model) this.store.setAssistantSettings(provider, model);
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
    const selection = this.selection;
    const blocked = await this.providerBlocked(selection.provider);
    if (blocked) return { kind: "provider", error: blocked };
    const model = this.modelFor(selection);
    if (!model) return { kind: "provider", error: "The selected model is unavailable." };
    const turn = this.store.startTurn(conversationId, text, selection.provider, selection.model);
    if (typeof turn === "string") return turn;
    const task: ActiveTurn = {
      conversationId,
      turnId: turn.id,
      toolArgs: new Map(),
      toolIds: new Map(),
      abort: new AbortController(),
      settled: false,
      provider: selection.provider,
      model: selection.model,
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
    return task?.live ? {
      ...detail,
      messages: [...detail.messages, task.live],
      timeline: [...(detail.timeline ?? []), { type: "message", id: task.live.id }],
    } : detail;
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

  private async providerBlocked(provider: AssistantProviderId): Promise<string | undefined> {
    const gate = this.gates.get(provider);
    if (gate && (gate.until === null || gate.until > Date.now())) return gate.error;
    this.gates.delete(provider);
    if (this.fixture) return undefined;
    const auth = await this.runtime.checkAuth(provider);
    if (auth) return undefined;
    const failure = providerFailure("authentication", provider);
    this.setGate(provider, failure.kind, failure.message);
    return failure.message;
  }

  private setGate(provider: AssistantProviderId, kind: ProviderFailureKind, error: string): void {
    if (kind === "unknown") return;
    this.gates.set(provider, {
      kind,
      error,
      until: kind === "authentication" ? null : Date.now() + this.config.providerCooldownMs,
    });
  }

  private async loadOpenRouterApiKey(): Promise<void> {
    const path = join(this.config.credentialDir, "openrouter-api-key");
    try {
      const key = readFileSync(path, "utf8").trim();
      if (!key || /\s/.test(key)) throw new Error("OpenRouter API key file is invalid.");
      await this.runtime.setRuntimeApiKey("openrouter", key);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private validModel(provider: AssistantProviderId, model: string): boolean {
    if (provider === "openai-codex") return codexModels(this.runtime).some((candidate) => candidate.id === model);
    const candidate = this.runtime.getModel(provider, model);
    return Boolean(candidate && isSelectableOpenRouterModel(candidate));
  }

  private defaultModel(provider: AssistantProviderId): string {
    if (provider === "openai-codex") return codexModel(this.runtime).id;
    const model = this.runtime.getModels("openrouter").find(isSelectableOpenRouterModel);
    if (!model) throw new Error("The pinned Pi runtime does not include an OpenRouter model.");
    return model.id;
  }

  private modelFor(selection: Selection): Model<any> | undefined {
    return this.fixture ? this.fixtureModel : this.validModel(selection.provider, selection.model) ? this.runtime.getModel(selection.provider, selection.model) : undefined;
  }

  assistantSettings(): Promise<AssistantSettings> {
    return this.providerOptions().then((providers) => {
      const saved = this.store.getAssistantSettings();
      return { provider: this.selection.provider, model: this.selection.model, lastModels: saved.lastModels, providers };
    });
  }

  async updateAssistantSettings(provider: string, model: string): Promise<"invalid" | AssistantSettings> {
    if (!isProviderId(provider) || typeof model !== "string" || !this.validModel(provider, model)) return "invalid";
    this.selection = { provider, model };
    this.store.setAssistantSettings(provider, model);
    return this.assistantSettings();
  }

  private async providerOptions(): Promise<AssistantProviderOption[]> {
    const codex = codexModels(this.runtime);
    const openrouterModels = this.runtime.getModels("openrouter").filter(isSelectableOpenRouterModel);
    const status = async (provider: AssistantProviderId) => {
      if (this.fixture) return true;
      try { return Boolean(await this.runtime.checkAuth(provider)); }
      catch { return false; }
    };
    return [
      { id: "openai-codex", name: "OpenAI Codex", configured: await status("openai-codex"), models: codex.map(modelOption) },
      { id: "openrouter", name: "OpenRouter", configured: await status("openrouter"), models: openrouterModels.map(modelOption) },
    ];
  }

  private async runTurn(task: ActiveTurn, text: string): Promise<void> {
    const timeout = setTimeout(() => {
      task.abort.abort();
      void task.session?.abort().catch(() => {});
      const failure = providerFailure("timeout");
      this.setGate(task.provider, failure.kind, failure.message);
      this.settle(task, "failure", "The assistant took too long to reply.");
      // Do not release this conversation while Pi may still append its transcript.
      task.forceExitTimer = setTimeout(() => {
        if (this.activeTurns.has(task.turnId)) process.exit(1);
      }, this.config.shutdownTimeoutMs);
    }, this.config.turnTimeoutMs);
    let unsubscribe: (() => void) | undefined;
    try {
      const transcriptPath = this.store.getTranscriptPath(task.conversationId);
      const model = this.modelFor({ provider: task.provider, model: task.model });
      if (!transcriptPath || !model || task.settled || this.stopping) return;
      const sessionManager = SessionManager.open(transcriptPath, join(this.config.conversationDir, "transcripts"), "/voidstation");
      const created = await createAgentSession({
        cwd: "/voidstation",
        agentDir: this.config.credentialDir,
        modelRuntime: this.runtime,
        model,
        thinkingLevel: "medium",
        noTools: "builtin",
        customTools: createMediaTools((result: MediaResult) => {
          this.store.saveMediaResult(task.conversationId, task.turnId, result);
        }),
        resourceLoader: new RestrictedResourceLoader(),
        settingsManager: emptySettings(),
        sessionManager,
      });
      task.session = created.session;
      unsubscribe = task.session.subscribe((event) => {
        if (task.settled) return;
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          const live = task.live ?? (task.live = {
            id: randomUUID(), role: "assistant", text: "", provider: task.provider, model: task.model,
          });
          live.text += event.assistantMessageEvent.delta;
          this.emit(task.conversationId);
          return;
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const text = assistantMessageText(event.message);
          if (text) {
            const message = task.live ?? {
              id: randomUUID(), role: "assistant" as const, text: "", provider: task.provider, model: task.model,
            };
            message.text = text;
            this.store.saveAssistantMessage(task.conversationId, task.turnId, message);
          }
          task.live = undefined;
          this.emit(task.conversationId);
          return;
        }
        if (event.type === "tool_execution_start") {
          // Reserve source order now; the row becomes visible only after the tool has completed.
          task.toolArgs.set(event.toolCallId, isRecord(event.args) ? event.args : {});
          const id = randomUUID();
          task.toolIds.set(event.toolCallId, id);
          this.store.reserveToolCall(task.conversationId, id);
          return;
        }
        if (event.type === "tool_execution_end") {
          const result = toolResult(event.result);
          this.store.saveToolCall(task.conversationId, {
            id: task.toolIds.get(event.toolCallId) ?? randomUUID(),
            turnId: task.turnId,
            name: event.toolName,
            parameters: task.toolArgs.get(event.toolCallId) ?? {},
            result,
            status: event.isError || (isRecord(result) && result.kind === "error") ? "error" : "complete",
          });
          this.emit(task.conversationId);
        }
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
        const failure = providerFailure(rawError, task.provider);
        this.setGate(task.provider, failure.kind, failure.message);
        this.settle(task, "failure", failure.message);
      } else {
        this.settle(task, "complete", null);
      }
    } catch (error) {
      if (!task.settled) {
        const failure = providerFailure(error, task.provider);
        this.setGate(task.provider, failure.kind, failure.message);
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

  private settle(task: ActiveTurn, status: "complete" | "interrupted" | "failure", error: string | null): void {
    if (task.settled) return;
    task.settled = true;
    this.store.finishTurn(task.conversationId, task.turnId, status, error);
    this.emit(task.conversationId);
  }

  private emit(conversationId: string): void { this.changes.emit(conversationId); }

  onChange(conversationId: string, listener: () => void): () => void {
    this.changes.on(conversationId, listener);
    return () => this.changes.off(conversationId, listener);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolResult(value: unknown): unknown {
  const record = isRecord(value) ? value : undefined;
  const details = record && isRecord(record.details) && Object.hasOwn(record.details, "result") ? record.details.result : undefined;
  const content = record && Array.isArray(record.content)
    ? record.content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string") as Record<string, unknown> | undefined
    : undefined;
  let result: unknown = details ?? content?.text ?? null;
  if (typeof result === "string") {
    try { result = JSON.parse(result) as unknown; } catch { /* Keep bounded text if a tool returned non-JSON text. */ }
  }
  return result;
}

function assistantMessageText(message: unknown): string {
  const record = isRecord(message) ? message : undefined;
  return record && Array.isArray(record.content)
    ? record.content.filter((content) => isRecord(content) && content.type === "text" && typeof content.text === "string").map((content) => content.text).join("")
    : "";
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
  const mediaConfigFile = process.env.VOIDSTATION_MEDIA_CONFIG_FILE;
  if (!tokenFile || !conversationDir || !credentialDir || !mediaConfigFile ||
      !isAbsolute(tokenFile) || !isAbsolute(conversationDir) || !isAbsolute(credentialDir) || !isAbsolute(mediaConfigFile)) {
    throw new Error("Worker state, token, and media configuration paths must be absolute and configured.");
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
  if (url.pathname === "/settings") {
    if (request.method === "GET") return send(response, 200, await worker.assistantSettings());
    if (request.method === "PUT") {
      const payload = await body(request);
      if (!isSettingsBody(payload)) return error(response, 400, "Expected a supported provider and model.");
      const updated = await worker.updateAssistantSettings(payload.provider, payload.model);
      return updated === "invalid" ? error(response, 400, "That provider/model selection is not supported.") : send(response, 200, updated);
    }
  }
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
function isProviderId(value: unknown): value is AssistantProviderId { return value === "openai-codex" || value === "openrouter"; }
function isSelectableOpenRouterModel(model: Model<any>): boolean {
  return model.input.includes("text") && (model.api === "openai-completions" || model.api === "anthropic-messages");
}
function modelOption(model: Model<any>): AssistantModelOption {
  return {
    id: model.id,
    name: model.name,
    free: model.cost.input === 0 && model.cost.output === 0,
    inputCost: model.cost.input,
    outputCost: model.cost.output,
    contextWindow: model.contextWindow,
  };
}
function isSettingsBody(value: unknown): value is { provider: AssistantProviderId; model: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 2
    && isProviderId((value as { provider?: unknown }).provider) && typeof (value as { model?: unknown }).model === "string";
}
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
