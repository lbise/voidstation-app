// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Assistant } from "../src/components/assistant";

const conversation = {
  id: "chat-1", title: "Test conversation", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  turn: null, messages: [], toolCalls: [], mediaResults: [],
};
const model = (id: string) => ({ id, name: id, free: false, inputCost: 1, outputCost: 2, contextWindow: 1000 });
const initialSettings = {
  provider: "openai-codex", model: "gpt-5.5", lastModels: { "openai-codex": "gpt-5.5", openrouter: "" },
  providers: [{ id: "openai-codex", name: "OpenAI Codex", configured: true, models: [model("gpt-5.5"), model("gpt-5.4")] }],
};
let fetchMock: ReturnType<typeof vi.fn<(url: string, options?: RequestInit) => Promise<Response>>>;
let emitSnapshot: (snapshot: unknown) => void;

beforeEach(() => {
  window.history.replaceState({}, "", "/assistant");
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
    if (url.endsWith("/turns")) return new Promise<Response>(() => {});
    if (url.endsWith("/settings")) return Response.json(options?.method === "PUT"
      ? { ...initialSettings, ...JSON.parse(options.body as string) } : initialSettings);
    if (url.endsWith("/conversations")) return Response.json({ conversations: [conversation] });
    return Response.json(conversation);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openChat() {
  render(<Assistant />);
  const input = screen.getByRole("textbox", { name: "Message the Assistant" }) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  return input;
}

function submissions() { return fetchMock.mock.calls.filter(([url]) => url.endsWith("/turns")); }

it("renders assistant replies as safe GitHub-flavored Markdown", async () => {
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/chat-1") ? Response.json({
    ...conversation,
    messages: [{ id: "message-1", role: "assistant", text: "## Release status\n\nThe **series** is ready.\n\n- Season one\n- Season two\n\n[Open guide](https://example.com/guide)\n\n`media_find`" }],
  }) : original(url, options));
  await openChat();
  expect(screen.getByRole("heading", { name: "Release status", level: 2 })).toBeTruthy();
  expect(screen.getByText("series").tagName).toBe("STRONG");
  expect(screen.getByRole("list")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open guide" }).getAttribute("href")).toBe("https://example.com/guide");
  expect(screen.getByRole("link", { name: "Open guide" }).getAttribute("target")).toBe("_blank");
  expect(screen.getByText("media_find")).toBeTruthy();
  expect(screen.queryByText("## Release status")).toBeNull();
});

it("submits once on Enter and disables the composer while sending", async () => {
  const input = await openChat();
  fireEvent.change(input, { target: { value: "List my series" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(submissions()).toHaveLength(1));
  expect(JSON.parse(submissions()[0][1]!.body as string)).toEqual({ text: "List my series" });
  expect(input.value).toBe("");
  expect(input.disabled).toBe(true);
  fireEvent.submit(input.form!);
  expect(submissions()).toHaveLength(1);
  expect(screen.queryByText("Media changes and searches are available when you ask for them.")).toBeNull();
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

it("interleaves tool calls with messages and expands each call in place", async () => {
  const original = fetchMock.getMockImplementation()!;
  const detail = {
    ...conversation,
    messages: [
      { id: "user-1", role: "user", text: "List my series" },
      { id: "message-1", role: "assistant", text: "Checking your library." },
      { id: "message-2", role: "assistant", text: "Your series are listed." },
      { id: "user-2", role: "user", text: "Check that title" },
      { id: "message-3", role: "assistant", text: "That title is unavailable." },
    ],
    toolCalls: [
      { id: "tool-1", turnId: "turn-1", name: "media_find", parameters: { type: "series" }, result: { kind: "find", choices: [], library: [] }, status: "complete" },
      { id: "tool-2", turnId: "turn-2", name: "media_details", parameters: { externalId: 42 }, result: { message: "Title not found" }, status: "error" },
    ],
    timeline: [
      { type: "message", id: "user-1" },
      { type: "message", id: "message-1" },
      { type: "toolCall", id: "tool-1" },
      { type: "message", id: "message-2" },
      { type: "message", id: "user-2" },
      { type: "toolCall", id: "tool-2" },
      { type: "message", id: "message-3" },
    ],
  };
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/chat-1") ? Response.json(detail) : original(url, options));
  await openChat();
  const log = screen.getByRole("log");
  expect(Array.from(log.querySelectorAll('[data-slot="message-scroller-item"]')).map((entry) => entry.textContent)).toEqual([
    "YouList my series", "AssistantChecking your library.", "media_findComplete",
    "AssistantYour series are listed.", "YouCheck that title", "media_detailsFailed", "AssistantThat title is unavailable.",
  ]);
  expect(screen.queryByText("Tool calls and media evidence")).toBeNull();
  const tool = within(log).getByRole("button", { name: /media_find\s*Complete/ });
  expect(tool.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Parameters")).toBeNull();
  fireEvent.click(tool);
  expect(tool.getAttribute("aria-expanded")).toBe("true");
  expect(within(log).getByText("Parameters")).toBeTruthy();
  expect(within(log).getByText(/"type": "series"/)).toBeTruthy();
  expect(within(log).getByText(/"kind": "find"/)).toBeTruthy();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  act(() => emitSnapshot(detail));
  expect(tool.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(within(log).getByRole("button", { name: /media_details\s*Failed/ }));
  expect(within(log).getByText(/Title not found/)).toBeTruthy();
});

it("inserts live tool calls before the next reply without moving earlier calls", async () => {
  await openChat();
  const live = {
    ...conversation,
    turn: { id: "turn-1", status: "running", error: null, startedAt: "2026-01-01T00:00:00Z", finishedAt: null },
    messages: [{ id: "user-1", role: "user", text: "Find Dune" }],
    toolCalls: [{ id: "tool-1", turnId: "turn-1", name: "media_find", parameters: {}, result: { title: "Dune" }, status: "complete" }],
    timeline: [{ type: "message", id: "user-1" }, { type: "toolCall", id: "tool-1" }],
  };
  act(() => emitSnapshot(live));
  const log = screen.getByRole("log");
  expect(Array.from(log.querySelectorAll('[data-slot="message-scroller-item"]')).map((entry) => entry.textContent)).toEqual([
    "YouFind Dune", "media_findComplete", " Assistant is working...",
  ]);
  act(() => emitSnapshot({
    ...live,
    turn: { ...live.turn, status: "complete", finishedAt: "2026-01-01T00:00:01Z" },
    messages: [...live.messages, { id: "answer-1", role: "assistant", text: "Found Dune." }],
    timeline: [...live.timeline, { type: "message", id: "answer-1" }],
  }));
  expect(Array.from(log.querySelectorAll('[data-slot="message-scroller-item"]')).map((entry) => entry.textContent)).toEqual([
    "YouFind Dune", "media_findComplete", "AssistantFound Dune.",
  ]);
  expect(screen.getAllByRole("button", { name: /media_find/ })).toHaveLength(1);
});

it("keeps legacy media evidence available as an inline expandable entry", async () => {
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/chat-1") ? Response.json({
    ...conversation,
    mediaResults: [{ id: "result-1", turnId: "turn-1", result: { kind: "error", operation: "find", message: "Service unavailable" } }],
    timeline: [{ type: "mediaResult", id: "result-1" }],
  }) : original(url, options));
  await openChat();
  fireEvent.click(within(screen.getByRole("log")).getByRole("button", { name: "Media find failed" }));
  expect(screen.getByText("Service unavailable")).toBeTruthy();
});

it("opens settings in a dialog and submits the form from its visible footer", async () => {
  await openChat();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Provider and model" });
  expect(dialog.closest(".assistant-main")).toBeNull();
  fireEvent.change(within(dialog).getByRole("listbox", { name: "Assistant model" }), { target: { value: "gpt-5.4" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const saved = fetchMock.mock.calls.find(([url, options]) => url.endsWith("/settings") && options?.method === "PUT");
  expect(JSON.parse(saved![1]!.body as string)).toEqual({ provider: "openai-codex", model: "gpt-5.4" });
});
