// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Assistant } from "../src/components/assistant";
import type { ConversationDetail, ToolCallRecord } from "../src/lib/assistant-contract";

const conversation: ConversationDetail = {
  id: "chat-1", title: "Test conversation", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  turn: null, messages: [], toolCalls: [], mediaResults: [],
};
const model = (id: string) => ({ id, name: id, free: false, inputCost: 1, outputCost: 2, contextWindow: 1000 });
const initialSettings = {
  provider: "openai-codex", model: "gpt-5.5", lastModels: { "openai-codex": "gpt-5.5", openrouter: "" },
  providers: [{ id: "openai-codex", name: "OpenAI Codex", configured: true, models: [model("gpt-5.5"), model("gpt-5.4")] }],
};
const unavailable = { status: "unavailable", value: null, observedAt: null };
const metrics = {
  cpu: { ...unavailable, unit: "percent" }, uptime: { ...unavailable, unit: "seconds" },
  ram: { ...unavailable, unit: "bytes" }, rootFilesystem: { ...unavailable, unit: "bytes" },
  dataFilesystem: { ...unavailable, unit: "bytes" },
};
const findResult = { kind: "find" as const, choices: [], library: [] };
const detailsResult = { kind: "details" as const, type: "movie" as const, externalId: 42, tracked: true, activeDownload: false, available: true };
function tool(id: string, turnId = "turn-1"): ToolCallRecord {
  return { id, turnId, name: "media_find", parameters: { type: "movie", query: "Dune" }, result: findResult, status: "complete" };
}
let details: Map<string, ConversationDetail>;
let phonePointer: boolean;
let fetchMock: ReturnType<typeof vi.fn<(url: string, options?: RequestInit) => Promise<Response>>>;
let emitSnapshot: (snapshot: unknown) => void;

beforeEach(() => {
  window.history.replaceState({}, "", "/assistant");
  details = new Map([[conversation.id, structuredClone(conversation)]]);
  phonePointer = false;
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: phonePointer && (query.includes("max-width") || query.includes("pointer: coarse")),
    media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true,
  })));
  vi.stubGlobal("EventSource", class {
    onmessage?: (event: MessageEvent) => void;
    constructor() {
      emitSnapshot = (snapshot) => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(snapshot) }));
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === "/api/metrics") return Response.json(metrics);
    if (url.endsWith("/turns")) return new Promise<Response>(() => {});
    if (url.endsWith("/settings")) return Response.json(options?.method === "PUT"
      ? { ...initialSettings, ...JSON.parse(options.body as string) } : initialSettings);
    if (url.endsWith("/conversations")) return Response.json({ conversations: [...details.values()] });
    const id = url.split("/").at(-1)!;
    if (options?.method === "DELETE") {
      details.delete(id);
      return new Response(null, { status: 204 });
    }
    return Response.json(details.get(id) ?? { error: "Conversation not found" }, { status: details.has(id) ? 200 : 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openChat() {
  render(<Assistant />);
  const input = screen.getByRole("textbox", { name: "Message the Assistant" }) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  await screen.findByRole("button", { name: "OpenAI Codex · gpt-5.5" });
  return input;
}

function submissions() { return fetchMock.mock.calls.filter(([url]) => url.endsWith("/turns")); }
function threadRows() { return Array.from(screen.getByRole("log").querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"]')); }
function settingsTrigger() { return screen.getByRole("button", { name: /^Provider and model settings:/ }); }
async function openSettings() {
  fireEvent.click(settingsTrigger());
  return screen.findByRole("dialog", { name: "Provider and model" });
}

it("renders assistant replies as safe GitHub-flavored Markdown", async () => {
  details.set(conversation.id, {
    ...conversation,
    messages: [{ id: "message-1", role: "assistant", provider: "openai-codex", model: "gpt-5.5", text: "## Release status\n\nThe **series** is ready.\n\n- Season one\n- Season two\n\n[Open guide](https://example.com/guide)\n\n`media_find`\n\n<script>alert('unsafe')</script>" }],
  });
  await openChat();
  const log = screen.getByRole("log");
  expect(within(log).getByText("OpenAI Codex · gpt-5.5")).toBeTruthy();
  expect(within(log).getByRole("heading", { name: "Release status", level: 2 })).toBeTruthy();
  expect(within(log).getByText("series").tagName).toBe("STRONG");
  expect(within(log).getByRole("list")).toBeTruthy();
  const link = within(log).getByRole("link", { name: "Open guide" });
  expect(link.getAttribute("href")).toBe("https://example.com/guide");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(within(log).getByText("media_find").tagName).toBe("CODE");
  expect(screen.queryByText("## Release status")).toBeNull();
  expect(log.querySelector("script")).toBeNull();
});

it("submits once on Enter and disables the composer while sending", async () => {
  const input = await openChat();
  fireEvent.change(input, { target: { value: "List my series" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(submissions()).toHaveLength(1));
  expect(JSON.parse(submissions()[0][1]!.body as string)).toEqual({ text: "List my series" });
  expect(input.value).toBe("");
  expect(input.disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(input.form!);
  expect(submissions()).toHaveLength(1);
  expect(screen.queryByText("Media changes and searches are available when you ask for them.")).toBeNull();
  expect(screen.getByText("Enter to send · Shift+Enter for a new line")).toBeTruthy();
});

it("leaves Shift+Enter and IME Enter alone and rejects blank or repeated Enter", async () => {
  const input = await openChat();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.change(input, { target: { value: "First line" } });
  expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(true);
  fireEvent.keyDown(input, { key: "Enter", repeat: true });
  expect(submissions()).toHaveLength(0);
  fireEvent.change(input, { target: { value: "First line\nSecond line" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(submissions()).toHaveLength(1));
  expect(JSON.parse(submissions()[0][1]!.body as string).text).toBe("First line\nSecond line");
});

it("allows phone coarse-pointer Enter to insert a newline and sends using the icon button", async () => {
  phonePointer = true;
  const input = await openChat();
  fireEvent.change(input, { target: { value: "First line" } });
  // jsdom doesn't perform the browser's default text insertion. An uncancelled
  // event verifies that Enter remains available to the textarea, not submission.
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
  expect(submissions()).toHaveLength(0);
  fireEvent.change(input, { target: { value: "First line\nSecond line" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(submissions()).toHaveLength(1));
  expect(JSON.parse(submissions()[0][1]!.body as string).text).toBe("First line\nSecond line");
});

it("groups consecutive calls and saved results into one disclosure without dropping independent records", async () => {
  const detail: ConversationDetail = {
    ...conversation,
    messages: [{ id: "user-1", role: "user", text: "Find Dune" }, { id: "answer-1", role: "assistant", text: "Dune is available." }],
    toolCalls: [tool("find-1"), { ...tool("details-1"), name: "media_details", parameters: { type: "movie", externalId: 42 }, result: detailsResult }],
    mediaResults: [{ id: "saved-find", turnId: "turn-1", result: findResult }, { id: "saved-details", turnId: "turn-1", result: detailsResult }],
    timeline: [{ type: "message", id: "user-1" }, { type: "toolCall", id: "find-1" }, { type: "mediaResult", id: "saved-find" }, { type: "toolCall", id: "details-1" }, { type: "mediaResult", id: "saved-details" }, { type: "message", id: "answer-1" }],
  };
  details.set(conversation.id, detail);
  await openChat();
  const log = screen.getByRole("log");
  const disclosure = within(log).getByRole("button", { name: /Checked your library · Read movie details/ });
  expect(within(log).getAllByRole("button")).toHaveLength(1);
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(disclosure.textContent).toContain("4 records");
  expect(within(log).queryByText("Parameters")).toBeNull();
  fireEvent.click(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(within(log).getByText("media_find")).toBeTruthy();
  expect(within(log).getByText("media_details")).toBeTruthy();
  expect(within(log).getAllByText("Parameters")).toHaveLength(2);
  expect(within(log).getByText(/"query": "Dune"/)).toBeTruthy();
  expect(within(log).getAllByText(/"kind": "find"/)).toHaveLength(2);
  expect(within(log).getAllByText(/"kind": "details"/)).toHaveLength(2);
  expect(log.querySelectorAll(".assistant-tool-records > article")).toHaveLength(4);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  act(() => emitSnapshot(detail));
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
});

it("preserves ordering across assistant preambles, intermediate text, user messages, and turns", async () => {
  details.set(conversation.id, {
    ...conversation,
    messages: [
      { id: "user-1", role: "user", text: "List my series" },
      { id: "preamble", role: "assistant", text: "Checking your library." },
      { id: "intermediate", role: "assistant", text: "Reading the title details." },
      { id: "answer-1", role: "assistant", text: "Your series are listed." },
      { id: "user-2", role: "user", text: "Check another title" },
    ],
    toolCalls: [tool("first"), tool("second"), tool("third", "turn-2"), tool("fourth", "turn-3")],
    timeline: [
      { type: "message", id: "user-1" }, { type: "message", id: "preamble" }, { type: "toolCall", id: "first" },
      { type: "message", id: "intermediate" }, { type: "toolCall", id: "second" }, { type: "message", id: "answer-1" },
      { type: "message", id: "user-2" }, { type: "toolCall", id: "third" }, { type: "toolCall", id: "fourth" },
    ],
  });
  await openChat();
  const rows = threadRows();
  expect(rows).toHaveLength(9);
  const expectedMessages = [[0, "List my series"], [1, "Checking your library."], [3, "Reading the title details."], [5, "Your series are listed."], [6, "Check another title"]] as const;
  for (const [index, text] of expectedMessages) expect(within(rows[index]).getByText(text)).toBeTruthy();
  for (const index of [2, 4, 7, 8]) {
    const disclosure = within(rows[index]).getByRole("button", { name: /Checked your library/ });
    expect(disclosure.textContent).toContain("1 record");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  }
});

it("shows tool errors in the collapsed summary and retains their technical results", async () => {
  details.set(conversation.id, {
    ...conversation,
    toolCalls: [{ ...tool("failed"), name: "media_details", parameters: { externalId: 42 }, result: { kind: "error", message: "Title not found", code: "not_found" }, status: "error" }],
    mediaResults: [{ id: "saved-failure", turnId: "turn-1", result: { kind: "error", operation: "details", code: "not_found", message: "Title not found" } }],
    timeline: [{ type: "toolCall", id: "failed" }, { type: "mediaResult", id: "saved-failure" }],
  });
  await openChat();
  const log = screen.getByRole("log");
  const disclosure = within(log).getByRole("button", { name: /media_details failed · details failed/ });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(within(disclosure).getByText("2 failed")).toBeTruthy();
  expect(within(log).queryByText("Parameters")).toBeNull();
  fireEvent.click(disclosure);
  expect(within(log).getByText(/"externalId": 42/)).toBeTruthy();
  expect(within(log).getByText("Title not found")).toBeTruthy();
  expect(within(log).getAllByText(/"code": "not_found"/)).toHaveLength(2);
});

it("inserts SSE activity before the next reply and keeps the existing disclosure expanded", async () => {
  await openChat();
  const live: ConversationDetail = {
    ...conversation,
    turn: { id: "turn-1", status: "running", error: null, provider: "openai-codex", model: "gpt-5.5", startedAt: "2026-01-01T00:00:00Z", finishedAt: null },
    messages: [{ id: "user-1", role: "user", text: "Find Dune" }],
    toolCalls: [tool("tool-1")],
    timeline: [{ type: "message", id: "user-1" }, { type: "toolCall", id: "tool-1" }],
  };
  act(() => emitSnapshot(live));
  const log = screen.getByRole("log");
  const disclosure = within(log).getByRole("button", { name: /Checked your library/ });
  expect(within(threadRows()[0]).getByText("Find Dune")).toBeTruthy();
  expect(threadRows()[1].contains(disclosure)).toBe(true);
  expect(within(threadRows()[2]).getByRole("status").textContent).toContain("Assistant is working");
  fireEvent.click(disclosure);
  act(() => emitSnapshot({
    ...live,
    turn: { ...live.turn!, status: "complete", finishedAt: "2026-01-01T00:00:01Z" },
    messages: [...live.messages, { id: "answer-1", role: "assistant", text: "Found Dune." }],
    toolCalls: [...live.toolCalls, { ...tool("tool-2"), name: "media_details", result: detailsResult }],
    timeline: [...live.timeline!, { type: "toolCall", id: "tool-2" }, { type: "message", id: "answer-1" }],
  }));
  expect(threadRows()).toHaveLength(3);
  expect(threadRows()[1].contains(disclosure)).toBe(true);
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(disclosure.textContent).toContain("2 records");
  expect(within(threadRows()[2]).getByText("Found Dune.")).toBeTruthy();
  expect(within(log).getAllByRole("button")).toHaveLength(1);
  expect(within(log).queryByRole("status")).toBeNull();
});

it("keeps standalone legacy media evidence in an inline disclosure", async () => {
  details.set(conversation.id, {
    ...conversation,
    mediaResults: [{ id: "result-1", turnId: "turn-1", result: { kind: "error", operation: "find", code: "unavailable", message: "Service unavailable" } }],
    timeline: [{ type: "mediaResult", id: "result-1" }],
  });
  await openChat();
  const log = screen.getByRole("log");
  const disclosure = within(log).getByRole("button", { name: /find failed/ });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(within(disclosure).getByText("1 failed")).toBeTruthy();
  fireEvent.click(disclosure);
  expect(within(log).getByText("Service unavailable")).toBeTruthy();
  expect(within(log).getByText(/"code": "unavailable"/)).toBeTruthy();
});

it("restores each conversation's draft after switching chats", async () => {
  details.set("chat-2", { ...conversation, id: "chat-2", title: "Second conversation" });
  const input = await openChat();
  fireEvent.change(input, { target: { value: "Draft for the first chat" } });
  fireEvent.click(screen.getByRole("button", { name: /^Second conversation/ }));
  await waitFor(() => expect(input.disabled).toBe(false));
  expect(input.value).toBe("");
  fireEvent.change(input, { target: { value: "Draft for the second chat" } });
  fireEvent.click(screen.getByRole("button", { name: /^Test conversation/ }));
  await waitFor(() => expect(input.disabled).toBe(false));
  expect(input.value).toBe("Draft for the first chat");
  fireEvent.click(screen.getByRole("button", { name: /^Second conversation/ }));
  await waitFor(() => expect(input.disabled).toBe(false));
  expect(input.value).toBe("Draft for the second chat");
  expect(submissions()).toHaveLength(0);
});

it("opens settings from the composer chip and submits the real form from its footer", async () => {
  await openChat();
  const dialog = await openSettings();
  expect(dialog.closest(".assistant-main")).toBeNull();
  fireEvent.change(within(dialog).getByRole("listbox", { name: "Assistant model" }), { target: { value: "gpt-5.4" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const saved = fetchMock.mock.calls.find(([url, options]) => url.endsWith("/settings") && options?.method === "PUT");
  expect(JSON.parse(saved![1]!.body as string)).toEqual({ provider: "openai-codex", model: "gpt-5.4" });
  expect(screen.getByRole("button", { name: "OpenAI Codex · gpt-5.4" })).toBeTruthy();
  expect(settingsTrigger().getAttribute("aria-label")).toBe("Provider and model settings: OpenAI Codex · gpt-5.4");
});

it("keeps model chips on the saved settings while editing and discards cancelled edits", async () => {
  await openChat();
  const headerChip = screen.getByRole("button", { name: "OpenAI Codex · gpt-5.5" });
  const composerChip = settingsTrigger();
  fireEvent.click(headerChip);
  const dialog = await screen.findByRole("dialog", { name: "Provider and model" });
  fireEvent.change(within(dialog).getByRole("listbox", { name: "Assistant model" }), { target: { value: "gpt-5.4" } });
  expect(within(dialog).getByText("Selected: gpt-5.4")).toBeTruthy();
  expect(headerChip.textContent).toBe("OpenAI Codex · gpt-5.5");
  expect(composerChip.textContent).toBe("gpt-5.5");
  expect(composerChip.getAttribute("aria-label")).toContain("gpt-5.5");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "OpenAI Codex · gpt-5.5" })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([url, options]) => url.endsWith("/settings") && options?.method === "PUT")).toHaveLength(0);
  const reopened = await openSettings();
  expect((within(reopened).getByRole("listbox", { name: "Assistant model" }) as HTMLSelectElement).value).toBe("gpt-5.5");
});

it("requires confirmation before deleting a saved conversation and lets the owner cancel", async () => {
  await openChat();
  fireEvent.click(screen.getByRole("button", { name: "Delete Test conversation" }));
  const confirmation = await screen.findByRole("alertdialog", { name: "Delete conversation?" });
  expect(within(confirmation).getByText(/saved history/)).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(0);
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("button", { name: /^Test conversation/ })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Delete Test conversation" }));
  const reopened = await screen.findByRole("alertdialog", { name: "Delete conversation?" });
  fireEvent.click(within(reopened).getByRole("button", { name: "Delete conversation" }));
  await waitFor(() => expect(screen.getByText("No saved conversations.")).toBeTruthy());
  const deletions = fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE");
  expect(deletions).toHaveLength(1);
  expect(deletions[0][0]).toBe("/api/assistant/conversations/chat-1");
  expect(screen.getByText("Start a conversation")).toBeTruthy();
});

it("disables deletion while the conversation is working", async () => {
  details.set(conversation.id, {
    ...conversation,
    turn: { id: "turn-1", status: "running", provider: "openai-codex", model: "gpt-5.5", error: null, startedAt: "2026-01-01T00:00:00Z", finishedAt: null },
  });
  render(<Assistant />);
  const deletion = await screen.findByRole("button", { name: "Delete Test conversation" });
  await waitFor(() => expect((deletion as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(deletion);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(0);
});
