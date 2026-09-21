import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConversationStore } from "../worker/dist/store.js";

const directories: string[] = [];

async function legacyDatabase(): Promise<{ directory: string; first: string; second: string }> {
  const directory = await mkdtemp(join(tmpdir(), "voidstation-assistant-store-"));
  directories.push(directory);
  const database = new DatabaseSync(join(directory, "conversations.sqlite"));
  const first = "legacy-first";
  const second = "already-migrated";
  database.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, transcript_path TEXT NOT NULL);
    CREATE TABLE turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE media_results (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE tool_calls (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, name TEXT NOT NULL, parameters TEXT NOT NULL, result TEXT NOT NULL, status TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE timeline_items (conversation_id TEXT NOT NULL, position INTEGER NOT NULL, type TEXT NOT NULL, ref_id TEXT NOT NULL, PRIMARY KEY(conversation_id, position), UNIQUE(conversation_id, type, ref_id));
  `);
  const stamp = "2026-01-01T00:00:00.000Z";
  database.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)").run(first, "Legacy", stamp, stamp, "first.jsonl");
  database.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?)").run("first-complete", first, "complete", null, stamp, stamp);
  database.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?)").run("first-failed", first, "failure", "provider failure", stamp, stamp);
  const message = database.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)");
  message.run("first-user", first, "first-complete", "user", "Find Dune", 1, stamp);
  message.run("first-reply", first, "first-complete", "assistant", "Dune was found.", 2, stamp);
  message.run("failed-user", first, "first-failed", "user", "Try again", 3, stamp);
  const tool = database.prepare("INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  tool.run("first-tool", first, "first-complete", "media_find", "{\"type\":\"movie\"}", "{\"kind\":\"find\"}", "complete", 1);
  tool.run("failed-tool", first, "first-failed", "media_details", "{\"type\":\"movie\"}", "{\"kind\":\"error\"}", "error", 2);
  const media = database.prepare("INSERT INTO media_results (id, conversation_id, turn_id, result) VALUES (?, ?, ?, ?)");
  media.run("first-media", first, "first-complete", "{\"kind\":\"find\",\"choices\":[],\"library\":[]}");
  media.run("failed-media", first, "first-failed", "{\"kind\":\"error\",\"operation\":\"details\",\"code\":\"service_unavailable\",\"message\":\"Unavailable\"}");

  database.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?)").run(second, "Existing", stamp, stamp, "second.jsonl");
  database.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?)").run("second-turn", second, "complete", null, stamp, stamp);
  message.run("second-user", second, "second-turn", "user", "Keep this", 1, stamp);
  message.run("second-reply", second, "second-turn", "assistant", "Already migrated.", 2, stamp);
  database.prepare("INSERT INTO timeline_items VALUES (?, ?, ?, ?)").run(second, 1, "message", "second-user");
  database.close();
  return { directory, first, second };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("backfills each legacy conversation atomically without replacing existing timelines", async () => {
  const { directory, first, second } = await legacyDatabase();
  const expected = [
    { type: "message", id: "first-user" },
    { type: "toolCall", id: "first-tool" },
    { type: "mediaResult", id: "first-media" },
    { type: "message", id: "first-reply" },
    { type: "message", id: "failed-user" },
    { type: "toolCall", id: "failed-tool" },
    { type: "mediaResult", id: "failed-media" },
  ];

  const store = new ConversationStore(directory);
  try {
    expect(store.getDetail(first)?.timeline).toEqual(expected);
    expect(store.getDetail(second)?.timeline).toEqual([{ type: "message", id: "second-user" }]);
  } finally {
    store.close();
  }

  const reopened = new ConversationStore(directory);
  try {
    expect(reopened.getDetail(first)?.timeline).toEqual(expected);
    expect(reopened.getDetail(second)?.timeline).toEqual([{ type: "message", id: "second-user" }]);
  } finally {
    reopened.close();
  }
});
