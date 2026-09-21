import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Conversation, ConversationDetail, ConversationTimelineItem, Message, ToolCallRecord, Turn, TurnStatus, SavedMediaResult } from "./contract.ts";
import type { MediaResult } from "./media-contract.ts";

interface ConversationRow { id: string; title: string; created_at: string; updated_at: string; transcript_path: string; }
interface TurnRow { id: string; conversation_id: string; status: TurnStatus; error: string | null; provider: string; model: string; started_at: string; finished_at: string | null; }
interface MessageRow { id: string; role: Message["role"]; text: string; provider: string | null; model: string | null; }
interface AssistantSettingsRow { provider: string; model: string; codex_model: string; openrouter_model: string; }
interface ToolCallRow { id: string; turn_id: string; name: string; parameters: string; result: string; status: "complete" | "error"; position: number; }
interface TimelineRow { type: ConversationTimelineItem["type"]; ref_id: string; }
interface DeletionRow { conversation_id: string; transcript_path: string; trash_path: string; }

const now = () => new Date().toISOString();
const turn = (row: TurnRow): Turn => ({ id: row.id, status: row.status, error: row.error, provider: row.provider, model: row.model, startedAt: row.started_at, finishedAt: row.finished_at });

export class ConversationStore {
  private readonly database: DatabaseSync;
  private readonly transcriptRoot: string;
  private readonly trashRoot: string;

  constructor(conversationDir: string) {
    const root = resolve(conversationDir);
    this.transcriptRoot = join(root, "transcripts");
    this.trashRoot = join(root, ".deleting");
    mkdirSync(this.transcriptRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.trashRoot, { recursive: true, mode: 0o700 });
    const databasePath = join(root, "conversations.sqlite");
    this.database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    this.migrate();
    this.recoverPendingDeletes();
    this.interruptRunningTurns();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, transcript_path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('running', 'complete', 'interrupted', 'failure')),
        error TEXT, provider TEXT NOT NULL DEFAULT 'openai-codex', model TEXT NOT NULL DEFAULT 'gpt-5.5', started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_turn_per_conversation ON turns(conversation_id) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL, role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(conversation_id, position)
      );
      CREATE TABLE IF NOT EXISTS media_results (
        position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deletions (
        conversation_id TEXT PRIMARY KEY, transcript_path TEXT NOT NULL, trash_path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1), provider TEXT NOT NULL, model TEXT NOT NULL,
        codex_model TEXT NOT NULL, openrouter_model TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, name TEXT NOT NULL,
        parameters TEXT NOT NULL, result TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('complete', 'error')), position INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS timeline_items (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('message', 'toolCall', 'mediaResult')),
        ref_id TEXT NOT NULL,
        PRIMARY KEY(conversation_id, position),
        UNIQUE(conversation_id, type, ref_id)
      );
    `);
    const columns = this.database.prepare("PRAGMA table_info(turns)").all() as unknown as { name: string }[];
    if (!columns.some((column) => column.name === "provider")) this.database.exec("ALTER TABLE turns ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai-codex'");
    if (!columns.some((column) => column.name === "model")) this.database.exec("ALTER TABLE turns ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-5.5'");
    this.backfillTimeline();
  }

  private backfillTimeline(): void {
    const conversations = this.database.prepare("SELECT id FROM conversations").all() as { id: string }[];
    for (const conversation of conversations) {
      if (this.database.prepare("SELECT 1 FROM timeline_items WHERE conversation_id = ? LIMIT 1").get(conversation.id)) continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        // A prior worker may have completed this conversation after the first check.
        if (!this.database.prepare("SELECT 1 FROM timeline_items WHERE conversation_id = ? LIMIT 1").get(conversation.id)) {
          this.backfillConversationTimeline(conversation.id);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private backfillConversationTimeline(conversationId: string): void {
    const insert = this.database.prepare("INSERT INTO timeline_items (conversation_id, position, type, ref_id) VALUES (?, ?, ?, ?)");
    const messages = this.database.prepare("SELECT id, turn_id, role FROM messages WHERE conversation_id = ? ORDER BY position ASC").all(conversationId) as { id: string; turn_id: string | null; role: Message["role"] }[];
    const assistantTurns = new Set(messages.flatMap((message) => message.role === "assistant" && message.turn_id ? [message.turn_id] : []));
    const addedTools = new Set<string>();
    const addedMedia = new Set<string>();
    let position = 1;
    const appendTurnEvidence = (turnId: string) => {
      const tools = this.database.prepare("SELECT id FROM tool_calls WHERE conversation_id = ? AND turn_id = ? ORDER BY position ASC").all(conversationId, turnId) as { id: string }[];
      const media = this.database.prepare("SELECT id FROM media_results WHERE conversation_id = ? AND turn_id = ? ORDER BY position ASC").all(conversationId, turnId) as { id: string }[];
      for (const item of tools) if (!addedTools.has(item.id)) { insert.run(conversationId, position++, "toolCall", item.id); addedTools.add(item.id); }
      for (const item of media) if (!addedMedia.has(item.id)) { insert.run(conversationId, position++, "mediaResult", item.id); addedMedia.add(item.id); }
    };
    for (const message of messages) {
      // Older data has no cross-table sequence, so put a turn's evidence immediately before its reply.
      if (message.role === "assistant" && message.turn_id) appendTurnEvidence(message.turn_id);
      insert.run(conversationId, position++, "message", message.id);
      // A failed old turn may have evidence but no saved reply; retain it after that turn's user message.
      if (message.role === "user" && message.turn_id && !assistantTurns.has(message.turn_id)) appendTurnEvidence(message.turn_id);
    }
    const orphanTools = this.database.prepare("SELECT id FROM tool_calls WHERE conversation_id = ? ORDER BY position ASC").all(conversationId) as { id: string }[];
    const orphanMedia = this.database.prepare("SELECT id FROM media_results WHERE conversation_id = ? ORDER BY position ASC").all(conversationId) as { id: string }[];
    for (const item of orphanTools) if (!addedTools.has(item.id)) insert.run(conversationId, position++, "toolCall", item.id);
    for (const item of orphanMedia) if (!addedMedia.has(item.id)) insert.run(conversationId, position++, "mediaResult", item.id);
  }

  private interruptRunningTurns(): void {
    this.database.prepare("UPDATE turns SET status = 'interrupted', error = ?, finished_at = ? WHERE status = 'running'")
      .run("The worker restarted before this reply finished.", now());
  }

  private recoverPendingDeletes(): void {
    const pending = this.database.prepare("SELECT conversation_id, transcript_path, trash_path FROM deletions").all() as unknown as DeletionRow[];
    for (const deletion of pending) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("DELETE FROM conversations WHERE id = ?").run(deletion.conversation_id);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      rmSync(this.absoluteTrashPath(deletion.trash_path), { force: true });
      rmSync(this.absoluteTranscriptPath(deletion.transcript_path), { force: true });
      this.database.prepare("DELETE FROM deletions WHERE conversation_id = ?").run(deletion.conversation_id);
    }
  }

  createConversation(transcriptPath: string): Conversation {
    const id = randomUUID();
    const createdAt = now();
    this.database.prepare("INSERT INTO conversations (id, title, created_at, updated_at, transcript_path) VALUES (?, ?, ?, ?, ?)")
      .run(id, "New conversation", createdAt, createdAt, this.relativeTranscriptPath(transcriptPath));
    return { id, title: "New conversation", createdAt, updatedAt: createdAt, turn: null };
  }

  listConversations(): Conversation[] {
    const rows = this.database.prepare("SELECT * FROM conversations ORDER BY updated_at DESC, id DESC").all() as unknown as ConversationRow[];
    return rows.map((row) => this.toConversation(row));
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
    return row && this.toConversation(row);
  }

  getDetail(id: string): ConversationDetail | undefined {
    const conversation = this.getConversation(id);
    if (!conversation) return undefined;
    const messages = this.database.prepare("SELECT messages.id, messages.role, messages.text, turns.provider, turns.model FROM messages LEFT JOIN turns ON turns.id = messages.turn_id WHERE messages.conversation_id = ? ORDER BY messages.position ASC")
      .all(id) as unknown as MessageRow[];
    const results = this.database.prepare("SELECT id, turn_id, result FROM media_results WHERE conversation_id = ? ORDER BY position ASC")
      .all(id) as unknown as { id: string; turn_id: string; result: string }[];
    const mediaResults: SavedMediaResult[] = results.map((row) => ({ id: row.id, turnId: row.turn_id, result: JSON.parse(row.result) as MediaResult }));
    const toolRows = this.database.prepare("SELECT id, turn_id, name, parameters, result, status, position FROM tool_calls WHERE conversation_id = ? ORDER BY position ASC")
      .all(id) as unknown as ToolCallRow[];
    const toolCalls: ToolCallRecord[] = toolRows.map((row) => ({ id: row.id, turnId: row.turn_id, name: row.name, parameters: JSON.parse(row.parameters) as Record<string, unknown>, result: JSON.parse(row.result) as unknown, status: row.status }));
    const timelineRows = this.database.prepare("SELECT type, ref_id FROM timeline_items WHERE conversation_id = ? ORDER BY position ASC")
      .all(id) as unknown as TimelineRow[];
    const known = {
      message: new Set(messages.map((message) => message.id)),
      toolCall: new Set(toolCalls.map((call) => call.id)),
      mediaResult: new Set(mediaResults.map((result) => result.id)),
    };
    const timeline = timelineRows.flatMap((row) => known[row.type].has(row.ref_id) ? [{ type: row.type, id: row.ref_id }] : []);
    return { ...conversation, messages: messages.map((message) => ({
      id: message.id, role: message.role, text: message.text,
      ...(message.role === "assistant" && message.provider && message.model ? { provider: message.provider, model: message.model } : {}),
    })), mediaResults, toolCalls, timeline };
  }

  saveMediaResult(conversationId: string, turnId: string, result: MediaResult): string {
    const id = randomUUID();
    this.database.prepare("INSERT INTO media_results (id, conversation_id, turn_id, result) VALUES (?, ?, ?, ?)")
      .run(id, conversationId, turnId, JSON.stringify(result));
    this.appendTimeline(conversationId, "mediaResult", id);
    return id;
  }

  reserveToolCall(conversationId: string, id: string): void {
    this.appendTimeline(conversationId, "toolCall", id);
  }

  saveToolCall(conversationId: string, call: ToolCallRecord): void {
    this.reserveToolCall(conversationId, call.id);
    const current = this.database.prepare("SELECT position FROM tool_calls WHERE id = ?").get(call.id) as { position: number } | undefined;
    const position = current?.position ?? (this.database.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM tool_calls WHERE conversation_id = ?").get(conversationId) as { position: number }).position;
    this.database.prepare(`INSERT INTO tool_calls (id, conversation_id, turn_id, name, parameters, result, status, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, parameters = excluded.parameters, result = excluded.result, status = excluded.status`)
      .run(call.id, conversationId, call.turnId, call.name, JSON.stringify(call.parameters), JSON.stringify(call.result), call.status, position);
  }

  getTranscriptPath(id: string): string | undefined {
    const row = this.database.prepare("SELECT transcript_path FROM conversations WHERE id = ?").get(id) as { transcript_path: string } | undefined;
    return row && this.absoluteTranscriptPath(row.transcript_path);
  }

  startTurn(conversationId: string, text: string, provider = "openai-codex", model = "gpt-5.5"): Turn | "missing" | "running" {
    const id = randomUUID();
    const startedAt = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId)) {
        this.database.exec("ROLLBACK");
        return "missing";
      }
      if (this.database.prepare("SELECT 1 FROM deletions WHERE conversation_id = ?").get(conversationId)) {
        this.database.exec("ROLLBACK");
        return "running";
      }
      try {
        this.database.prepare("INSERT INTO turns (id, conversation_id, status, error, provider, model, started_at, finished_at) VALUES (?, ?, 'running', NULL, ?, ?, ?, NULL)")
          .run(id, conversationId, provider, model, startedAt);
      } catch {
        this.database.exec("ROLLBACK");
        return "running";
      }
      this.insertMessage(conversationId, id, "user", text);
      const title = text.trim().slice(0, 80) || "New conversation";
      this.database.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, startedAt, conversationId);
      this.database.exec("COMMIT");
      return { id, status: "running", error: null, provider, model, startedAt, finishedAt: null };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  finishTurn(conversationId: string, turnId: string, status: Exclude<TurnStatus, "running">, error: string | null): void {
    const finishedAt = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare("UPDATE turns SET status = ?, error = ?, finished_at = ? WHERE id = ? AND conversation_id = ? AND status = 'running'")
        .run(status, error, finishedAt, turnId, conversationId);
      if (result.changes === 1) {
        this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(finishedAt, conversationId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteConversation(id: string): "missing" | "running" | "deleted" {
    this.database.exec("BEGIN IMMEDIATE");
    let deletion: DeletionRow;
    try {
      const row = this.database.prepare("SELECT transcript_path FROM conversations WHERE id = ?").get(id) as { transcript_path: string } | undefined;
      if (!row) { this.database.exec("ROLLBACK"); return "missing"; }
      if (this.database.prepare("SELECT 1 FROM turns WHERE conversation_id = ? AND status = 'running'").get(id)) {
        this.database.exec("ROLLBACK");
        return "running";
      }
      const transcriptPath = this.absoluteTranscriptPath(row.transcript_path);
      deletion = {
        conversation_id: id,
        transcript_path: row.transcript_path,
        trash_path: this.relativeTrashPath(join(this.trashRoot, `${id}-${basename(transcriptPath)}`)),
      };
      this.database.prepare("INSERT INTO deletions (conversation_id, transcript_path, trash_path) VALUES (?, ?, ?)")
        .run(deletion.conversation_id, deletion.transcript_path, deletion.trash_path);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    const transcriptPath = this.absoluteTranscriptPath(deletion!.transcript_path);
    const trashPath = this.absoluteTrashPath(deletion!.trash_path);
    try {
      renameSync(transcriptPath, trashPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.database.prepare("DELETE FROM deletions WHERE conversation_id = ?").run(id);
        throw error;
      }
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    rmSync(trashPath, { force: true });
    rmSync(transcriptPath, { force: true });
    this.database.prepare("DELETE FROM deletions WHERE conversation_id = ?").run(id);
    return "deleted";
  }

  getAssistantSettings(): { provider: string; model: string; lastModels: { "openai-codex": string; openrouter: string } } {
    const row = this.database.prepare("SELECT provider, model, codex_model, openrouter_model FROM assistant_settings WHERE id = 1").get() as AssistantSettingsRow | undefined;
    if (!row) return { provider: "openai-codex", model: "gpt-5.5", lastModels: { "openai-codex": "gpt-5.5", openrouter: "" } };
    return { provider: row.provider, model: row.model, lastModels: { "openai-codex": row.codex_model, openrouter: row.openrouter_model } };
  }

  setAssistantSettings(provider: "openai-codex" | "openrouter", model: string): void {
    const current = this.getAssistantSettings();
    const lastModels = { ...current.lastModels, [provider]: model };
    this.database.prepare(`INSERT INTO assistant_settings (id, provider, model, codex_model, openrouter_model) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model, codex_model = excluded.codex_model, openrouter_model = excluded.openrouter_model`)
      .run(provider, model, lastModels["openai-codex"], lastModels.openrouter);
  }

  close(): void { this.database.close(); }

  private toConversation(row: ConversationRow): Conversation {
    const latest = this.database.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY started_at DESC, id DESC LIMIT 1").get(row.id) as TurnRow | undefined;
    return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at, turn: latest ? turn(latest) : null };
  }

  saveAssistantMessage(conversationId: string, turnId: string, message: Message): void {
    if (!message.text) return;
    this.insertMessage(conversationId, turnId, "assistant", message.text, message.id);
  }

  private insertMessage(conversationId: string, turnId: string, role: Message["role"], text: string, id: string = randomUUID()): void {
    const position = (this.database.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM messages WHERE conversation_id = ?").get(conversationId) as { position: number }).position;
    this.database.prepare("INSERT INTO messages (id, conversation_id, turn_id, role, text, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, conversationId, turnId, role, text, position, now());
    this.appendTimeline(conversationId, "message", id);
  }

  private appendTimeline(conversationId: string, type: ConversationTimelineItem["type"], id: string): void {
    const position = (this.database.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM timeline_items WHERE conversation_id = ?").get(conversationId) as { position: number }).position;
    this.database.prepare("INSERT OR IGNORE INTO timeline_items (conversation_id, position, type, ref_id) VALUES (?, ?, ?, ?)")
      .run(conversationId, position, type, id);
  }

  private relativeTranscriptPath(path: string): string { return this.relativePath(this.transcriptRoot, path, "Transcript"); }
  private relativeTrashPath(path: string): string { return this.relativePath(this.trashRoot, path, "Trash"); }
  private absoluteTranscriptPath(path: string): string { return this.absolutePath(this.transcriptRoot, path, "Transcript"); }
  private absoluteTrashPath(path: string): string { return this.absolutePath(this.trashRoot, path, "Trash"); }

  private relativePath(root: string, path: string, label: string): string {
    const absolute = resolve(path);
    if (!absolute.startsWith(root + sep)) throw new Error(`${label} path is outside worker storage.`);
    return absolute.slice(root.length + 1);
  }

  private absolutePath(root: string, path: string, label: string): string {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(root + sep)) throw new Error(`Invalid ${label.toLowerCase()} path.`);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    return absolute;
  }
}
