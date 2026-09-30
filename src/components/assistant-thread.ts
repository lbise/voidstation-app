import type {
  ConversationDetail,
  Message,
  SavedMediaResult,
  ToolCallRecord,
} from "@/lib/assistant-contract";

export type ThreadEntry =
  | { type: "message"; value: Message }
  | { type: "toolCall"; value: ToolCallRecord }
  | { type: "mediaResult"; value: SavedMediaResult };

export type ActivityEntry = Exclude<ThreadEntry, { type: "message" }>;
export type ThreadGroup =
  | Extract<ThreadEntry, { type: "message" }>
  | { type: "activity"; id: string; turnId: string; entries: ActivityEntry[] };

export function conversationEntries(conversation: ConversationDetail): ThreadEntry[] {
  const entries: ThreadEntry[] = [
    ...conversation.messages.map((value): ThreadEntry => ({ type: "message", value })),
    ...conversation.toolCalls.map((value): ThreadEntry => ({ type: "toolCall", value })),
    ...conversation.mediaResults.map((value): ThreadEntry => ({ type: "mediaResult", value })),
  ];
  if (!conversation.timeline) return entries;
  const remaining = new Map(entries.map((entry) => [`${entry.type}-${entry.value.id}`, entry]));
  const ordered: ThreadEntry[] = [];
  for (const reference of conversation.timeline) {
    const key = `${reference.type}-${reference.id}`;
    const entry = remaining.get(key);
    if (entry) {
      ordered.push(entry);
      remaining.delete(key);
    }
  }
  // A streaming snapshot can contain a record not yet referenced by the timeline.
  return [...ordered, ...remaining.values()];
}

export function groupThreadEntries(entries: readonly ThreadEntry[]): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      groups.push(entry);
      continue;
    }
    const previous = groups.at(-1);
    if (previous?.type === "activity" && previous.turnId === entry.value.turnId) {
      previous.entries.push(entry);
    } else {
      groups.push({
        type: "activity",
        id: `${entry.type}-${entry.value.id}`,
        turnId: entry.value.turnId,
        entries: [entry],
      });
    }
  }
  return groups;
}

export function activityHasError(entry: ActivityEntry): boolean {
  if (entry.type === "mediaResult") return entry.value.result.kind === "error";
  const result = entry.value.result;
  return entry.value.status === "error" || Boolean(
    result && typeof result === "object" && "kind" in result && result.kind === "error",
  );
}

function resultSummary(result: SavedMediaResult["result"]): string {
  switch (result.kind) {
    case "find": return "Checked your library";
    case "lookup": return "Looked up titles";
    case "details": return `Read ${result.type === "movie" ? "movie" : "series"} details`;
    case "status": return `Checked ${result.type === "movie" ? "movie" : "series"} status`;
    case "discovery": return "Read media defaults";
    case "configure": return "Media configuration result";
    case "search": return "Download search result";
    case "error": return `${result.operation} failed`;
  }
}

function webHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return undefined; }
}

export function activitySummary(entries: readonly ActivityEntry[]): string {
  const labels = entries.map((entry) => {
    if (entry.type === "mediaResult") return resultSummary(entry.value.result);
    if (activityHasError(entry)) return `${entry.value.name} failed`;
    switch (entry.value.name) {
      case "media_find": return "Checked your library";
      case "media_lookup": return "Looked up titles";
      case "media_details": return `Read ${entry.value.parameters.type === "movie" ? "movie" : entry.value.parameters.type === "series" ? "series" : "media"} details`;
      case "media_status": return "Checked media status";
      case "media_discovery": return "Read media defaults";
      case "web_search": return "Searched the web";
      case "web_fetch": return `Read ${webHost(entry.value.parameters.url) ?? "a web page"}`;
      default: return `Ran ${entry.value.name}`;
    }
  });
  // Only the short labels repeat less. Every underlying record stays in the group.
  return [...new Set(labels)].join(" · ");
}
