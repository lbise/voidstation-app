// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

beforeEach(() => {
  window.history.replaceState({}, "", "/assistant");
  vi.stubGlobal("EventSource", class {
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

it("keeps tool evidence inside the message scroller and collapsed until requested", async () => {
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/chat-1") ? Response.json({
    ...conversation,
    messages: [{ id: "message-1", role: "assistant", text: "Your series are listed." }],
    toolCalls: [{ id: "tool-1", turnId: "turn-1", name: "media_find", parameters: { type: "series" }, result: { kind: "find", choices: [], library: [] }, status: "complete" }],
  }) : original(url, options));
  await openChat();
  const evidence = screen.getByText("Tool calls and media evidence").closest("details")!;
  expect(evidence.open).toBe(false);
  expect(evidence.closest('[data-slot="message-scroller-content"]')).not.toBeNull();
  expect(screen.getByText("Your series are listed.")).toBeTruthy();
  fireEvent.click(evidence.querySelector("summary")!);
  fireEvent.click(screen.getByRole("button", { name: /media_find\s*Complete/ }));
  expect(await screen.findByRole("alertdialog", { name: "media_find" })).toBeTruthy();
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
