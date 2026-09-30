import { describe, expect, it } from "vitest";
import type { ConversationDetail, SavedMediaResult, ToolCallRecord } from "@/lib/assistant-contract";
import { activityHasError, activitySummary, conversationEntries, groupThreadEntries, type ThreadEntry } from "../src/components/assistant-thread";

const message = (id: string, role: "user" | "assistant" = "assistant", text = id): ThreadEntry => ({
  type: "message", value: { id, role, text },
});
const call = (id: string, turnId = "turn-1", status: "complete" | "error" = "complete"): ToolCallRecord => ({
  id, turnId, name: "media_find", parameters: { query: "Dune" },
  result: { kind: "find", choices: [], library: [] }, status,
});
const tool = (id: string, turnId = "turn-1"): ThreadEntry => ({ type: "toolCall", value: call(id, turnId) });
const saved = (id: string, turnId = "turn-1"): SavedMediaResult => ({
  id, turnId, result: { kind: "find", choices: [], library: [] },
});
const media = (id: string, turnId = "turn-1"): ThreadEntry => ({ type: "mediaResult", value: saved(id, turnId) });
const conversation = (overrides: Partial<ConversationDetail> = {}): ConversationDetail => ({
  id: "conversation-1", title: "Dune", createdAt: "2026-09-23T10:00:00Z", updatedAt: "2026-09-23T10:00:00Z",
  turn: null, messages: [], toolCalls: [], mediaResults: [], ...overrides,
});

describe("Assistant thread grouping", () => {
  it("follows the timeline including preambles and intermediate assistant text", () => {
    const detail = conversation({
      messages: [
        { id: "user", role: "user", text: "Find Dune" },
        { id: "preamble", role: "assistant", text: "I'll check." },
        { id: "intermediate", role: "assistant", text: "Checking the next result." },
        { id: "answer", role: "assistant", text: "Here is the result." },
      ],
      toolCalls: [call("first"), call("second")], mediaResults: [saved("saved-first")],
      timeline: [
        { type: "message", id: "user" }, { type: "message", id: "preamble" },
        { type: "toolCall", id: "first" }, { type: "mediaResult", id: "saved-first" },
        { type: "message", id: "intermediate" }, { type: "toolCall", id: "second" },
        { type: "message", id: "answer" },
      ],
    });
    const groups = groupThreadEntries(conversationEntries(detail));
    expect(groups.map((group) => group.type === "activity" ? group.entries.map((entry) => entry.value.id) : group.value.id))
      .toEqual(["user", "preamble", ["first", "saved-first"], "intermediate", ["second"], "answer"]);
  });

  it("groups only consecutive records in the same turn", () => {
    const entries = [tool("a"), media("b"), tool("c", "turn-2"), media("d", "turn-2"), message("user", "user"), tool("e", "turn-2")];
    expect(groupThreadEntries(entries).map((group) => group.type === "activity" ? group.entries.length : group.type))
      .toEqual([2, 2, "message", 1]);
  });

  it("keeps independent records even when their payloads or IDs across types match", () => {
    const detail = conversation({
      toolCalls: [call("same"), call("other")], mediaResults: [saved("same"), saved("other")],
      timeline: [{ type: "toolCall", id: "same" }, { type: "mediaResult", id: "same" }, { type: "toolCall", id: "other" }, { type: "mediaResult", id: "other" }],
    });
    const groups = groupThreadEntries(conversationEntries(detail));
    expect(groups).toHaveLength(1);
    const group = groups[0];
    if (group.type !== "activity") throw new Error("Expected activity");
    expect(group.entries).toHaveLength(4);
    expect(activitySummary(group.entries)).toBe("Checked your library");
    expect(group.entries.filter((entry) => entry.type === "mediaResult")).toHaveLength(2);
  });

  it("retains unreferenced streaming records and tolerates not-yet-present timeline references", () => {
    const detail = conversation({
      messages: [{ id: "preamble", role: "assistant", text: "" }],
      toolCalls: [call("first")], mediaResults: [saved("just-saved")],
      timeline: [{ type: "message", id: "preamble" }, { type: "toolCall", id: "first" }, { type: "toolCall", id: "not-saved-yet" }],
    });
    const groups = groupThreadEntries(conversationEntries(detail));
    expect(groups.map((group) => group.type)).toEqual(["message", "activity"]);
    expect(groups[1].type === "activity" && groups[1].entries.map((entry) => entry.value.id)).toEqual(["first", "just-saved"]);
    detail.messages[0].text = "Checking your library";
    detail.messages.push({ id: "streaming-answer", role: "assistant", text: "Part of an answer" });
    detail.timeline?.push({ type: "message", id: "streaming-answer" });
    expect(groupThreadEntries(conversationEntries(detail)).map((group) => group.type))
      .toEqual(["message", "activity", "message", "activity"]);
  });

  it("keeps empty assistant messages as boundaries while streaming", () => {
    expect(groupThreadEntries([tool("a"), message("streaming", "assistant", ""), tool("b")]).map((group) => group.type))
      .toEqual(["activity", "message", "activity"]);
  });

  it("keeps tool errors visible and preserves all technical error data", () => {
    const failedCall = call("failed", "turn-1", "error");
    failedCall.result = { kind: "error", code: "unreachable", message: "Radarr is unavailable" };
    const failedMedia: SavedMediaResult = {
      id: "saved-failure", turnId: "turn-1", result: { kind: "error", operation: "find", code: "unreachable", message: "Radarr is unavailable" },
    };
    const entries = [{ type: "toolCall" as const, value: failedCall }, { type: "mediaResult" as const, value: failedMedia }];
    expect(entries.every(activityHasError)).toBe(true);
    expect(activitySummary(entries)).toBe("media_find failed · find failed");
    const groups = groupThreadEntries(entries);
    expect(groups[0].type === "activity" && groups[0].entries[1].value).toBe(failedMedia);
    expect(activityHasError({ type: "toolCall", value: { ...failedCall, status: "complete" } })).toBe(true);
  });

  it("does not invent successful lookups for unknown tools", () => {
    expect(activitySummary([{ type: "toolCall", value: { ...call("custom"), name: "inspect_queue" } }])).toBe("Ran inspect_queue");
  });

  it("retains the legacy record order without a timeline and does not mutate inputs", () => {
    const detail = conversation({ messages: [{ id: "answer", role: "assistant", text: "Answer" }], toolCalls: [call("a")], mediaResults: [saved("b")] });
    const entries = conversationEntries(detail);
    expect(entries.map((entry) => entry.value.id)).toEqual(["answer", "a", "b"]);
    const before = structuredClone(entries);
    groupThreadEntries(entries);
    expect(entries).toEqual(before);
    expect(groupThreadEntries([])).toEqual([]);
  });
});
