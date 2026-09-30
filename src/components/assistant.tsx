"use client";

import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  Menu,
  MessageSquarePlus,
  Radio,
  Settings,
  Trash2,
  WifiOff,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AppShell } from "@/components/app-shell";
import { activityHasError, activitySummary, conversationEntries, groupThreadEntries, type ThreadGroup } from "@/components/assistant-thread";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Textarea } from "@/components/ui/textarea";
import type {
  Conversation,
  ConversationDetail,
  ErrorResponse,
  Message as AssistantMessage,
  Turn,
  TurnStatus,
  MediaResult,
  SavedMediaResult,
  ToolCallRecord,
  AssistantModelOption,
  AssistantProviderId,
  AssistantSettings,
} from "@/lib/assistant-contract";

type RequestResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

type OptimisticMessage = AssistantMessage & { pending: true };

type ConversationListResponse = { conversations: Conversation[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isConversation(value: unknown): value is Conversation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.turn === null || isTurn(value.turn))
  );
}

function isTurn(value: unknown): value is Turn {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.status === "running" ||
      value.status === "complete" ||
      value.status === "interrupted" ||
      value.status === "failure") &&
    (value.error === null || typeof value.error === "string") &&
    typeof value.startedAt === "string" &&
    (value.finishedAt === null || typeof value.finishedAt === "string")
  );
}

function isMediaResult(value: unknown): value is MediaResult {
  return isRecord(value) && (value.kind === "find" || value.kind === "lookup" || value.kind === "details" || value.kind === "discovery" || value.kind === "status" || value.kind === "configure" || value.kind === "search" || value.kind === "error");
}

function isToolCall(value: unknown): value is ToolCallRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.turnId === "string" && typeof value.name === "string" &&
    isRecord(value.parameters) && (value.status === "complete" || value.status === "error") && Object.hasOwn(value, "result");
}

function isConversationDetail(value: unknown): value is ConversationDetail {
  if (!isRecord(value)) return false;
  const messages = value.messages;
  const mediaResults = value.mediaResults;
  const toolCalls = value.toolCalls;
  const timeline = value.timeline;
  return (
    isConversation(value) &&
    Array.isArray(messages) &&
    messages.every(
      (message) =>
        isRecord(message) &&
        typeof message.id === "string" &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.text === "string",
    ) &&
    Array.isArray(mediaResults) &&
    mediaResults.every((entry) => isRecord(entry) && typeof entry.id === "string" && typeof entry.turnId === "string" && isMediaResult(entry.result)) &&
    Array.isArray(toolCalls) && toolCalls.every(isToolCall) &&
    (timeline === undefined || (Array.isArray(timeline) && timeline.every((entry) =>
      isRecord(entry) && typeof entry.id === "string" &&
      (entry.type === "message" || entry.type === "toolCall" || entry.type === "mediaResult"))))
  );
}

function isConversationList(value: unknown): value is ConversationListResponse {
  return isRecord(value) && Array.isArray(value.conversations) && value.conversations.every(isConversation);
}

function isAssistantModel(value: unknown): value is AssistantModelOption {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.free === "boolean" &&
    typeof value.inputCost === "number" && typeof value.outputCost === "number" && typeof value.contextWindow === "number";
}

function isAssistantSettings(value: unknown): value is AssistantSettings {
  if (!isRecord(value) || (value.provider !== "openai-codex" && value.provider !== "openrouter") || typeof value.model !== "string") return false;
  const lastModels = value.lastModels;
  const providers = value.providers;
  return isRecord(lastModels) && typeof lastModels["openai-codex"] === "string" && typeof lastModels.openrouter === "string" &&
    Array.isArray(providers) && providers.every((provider) => isRecord(provider) &&
      (provider.id === "openai-codex" || provider.id === "openrouter") && typeof provider.name === "string" &&
      typeof provider.configured === "boolean" && Array.isArray(provider.models) && provider.models.every(isAssistantModel));
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof (payload as ErrorResponse).error === "string") {
      return (payload as ErrorResponse).error;
    }
  } catch {
    // The status still gives the owner a useful failure state.
  }
  return `Request failed (${response.status}).`;
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  isPayload: (payload: unknown) => payload is T,
): Promise<RequestResult<T>> {
  try {
    const response = await fetch(input, {
      ...init,
      cache: "no-store",
      headers: { "Cache-Control": "no-store", ...init.headers },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: await responseError(response) };
    }
    const payload: unknown = await response.json();
    if (!isPayload(payload)) {
      return { ok: false, status: response.status, error: "The Assistant returned an unexpected response." };
    }
    return { ok: true, value: payload };
  } catch {
    return { ok: false, status: 0, error: "The Assistant could not be reached." };
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unknown time"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

const turnPresentation = {
  running: { label: "Working", variant: "default" },
  complete: { label: "Complete", variant: "secondary" },
  interrupted: { label: "Interrupted", variant: "warning" },
  failure: { label: "Failed", variant: "destructive" },
} satisfies Record<TurnStatus, { label: string; variant: "default" | "secondary" | "warning" | "destructive" }>;

function mediaResultLabel(result: MediaResult): string {
  if (result.kind === "find") return `${result.choices.length + result.library.length} media result${result.choices.length + result.library.length === 1 ? "" : "s"}`;
  if (result.kind === "lookup") return `${result.choices.length} title choice${result.choices.length === 1 ? "" : "s"}`;
  if (result.kind === "details" || result.kind === "status") return `${result.type === "movie" ? "Movie" : "Series"} details`;
  if (result.kind === "discovery") return `${result.type === "movie" ? "Movie" : "Series"} defaults validated`;
  if (result.kind === "configure") return `${result.type === "movie" ? "Movie" : "Series"} configuration changed`;
  if (result.kind === "search") return `${result.type === "movie" ? "Movie" : "Series"} search accepted`;
  return `Media ${result.operation} failed`;
}

function AssistantMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function MediaResultCard({ entry }: { entry: SavedMediaResult }) {
  const result = entry.result;
  return (
    <article className="assistant-media-result" aria-label={mediaResultLabel(result)}>
      <div className="assistant-media-result__heading">
        <strong>{mediaResultLabel(result)}</strong>
        <Badge variant={result.kind === "error" ? "destructive" : "secondary"}>{result.kind === "error" ? "Unavailable" : "Tool result"}</Badge>
      </div>
      {result.kind === "error" && <p>{result.message}</p>}
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </article>
  );
}

function ToolActivity({ group }: { group: Extract<ThreadGroup, { type: "activity" }> }) {
  const errorCount = group.entries.filter(activityHasError).length;
  return (
    <Collapsible className="assistant-tool-activity">
      <CollapsibleTrigger render={<Button type="button" variant="outline" className="assistant-tool-summary" />}>
        <Wrench data-icon="inline-start" aria-hidden="true" />
        <span className="assistant-tool-summary__label">{activitySummary(group.entries)}</span>
        <span className="assistant-tool-count">{group.entries.length} record{group.entries.length === 1 ? "" : "s"}</span>
        {errorCount > 0 && <Badge variant="destructive">{errorCount} failed</Badge>}
        <ChevronRight data-icon="inline-end" className="assistant-tool-chevron" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="assistant-tool-records">
          {group.entries.map((entry) => entry.type === "mediaResult" ? (
            <MediaResultCard key={`mediaResult-${entry.value.id}`} entry={entry.value} />
          ) : (
            <article className="assistant-tool-call-detail" key={`toolCall-${entry.value.id}`}>
              <div className="assistant-tool-call-detail__head">
                <code>{entry.value.name}</code>
                <Badge variant={activityHasError(entry) ? "destructive" : "secondary"}>{activityHasError(entry) ? "Failed" : "Complete"}</Badge>
              </div>
              <strong>Parameters</strong>
              <pre>{JSON.stringify(entry.value.parameters, null, 2)}</pre>
              <strong>Result</strong>
              <pre>{JSON.stringify(entry.value.result, null, 2)}</pre>
            </article>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function AssistantMark() {
  return <span className="assistant-avatar" aria-hidden="true">V<span>/</span></span>;
}

function ConversationEntry({ entry }: { entry: ThreadGroup }) {
  if (entry.type === "activity") return <ToolActivity group={entry} />;
  const message = entry.value;
  return (
    <Message align={message.role === "user" ? "end" : "start"}>
      <MessageContent>
        <MessageHeader>
          {message.role === "user" ? <span className="visually-hidden">You</span> : <><AssistantMark /><span>Assistant</span></>}
          {message.role === "assistant" && message.provider && message.model && <small className="assistant-message-model">{message.provider === "openrouter" ? "OpenRouter" : "OpenAI Codex"} · {message.model}</small>}
        </MessageHeader>
        <Bubble align={message.role === "user" ? "end" : "start"} variant={message.role === "user" ? "secondary" : "ghost"}>
          <BubbleContent className={message.role === "assistant" ? "assistant-markdown" : undefined}>
            {message.role === "assistant" ? <AssistantMarkdown text={message.text} /> : message.text}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

function replaceConversation(conversations: Conversation[], next: Conversation): Conversation[] {
  const existing = conversations.findIndex((conversation) => conversation.id === next.id);
  if (existing === -1) return [next, ...conversations];
  return conversations.map((conversation) => (conversation.id === next.id ? next : conversation));
}

export function Assistant() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [listState, setListState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [sendingIds, setSendingIds] = useState<ReadonlySet<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [conversationPendingDeletion, setConversationPendingDeletion] = useState<Conversation | null>(null);
  const [text, setText] = useState("");
  const [optimisticMessage, setOptimisticMessage] = useState<OptimisticMessage | null>(null);
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [settingsState, setSettingsState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsProvider, setSettingsProvider] = useState<AssistantProviderId>("openai-codex");
  const [settingsModel, setSettingsModel] = useState("gpt-5.5");
  const [modelSearch, setModelSearch] = useState("");
  const [modelFilter, setModelFilter] = useState<"all" | "free" | "paid">("all");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const historyTrigger = useRef<HTMLButtonElement>(null);
  const activeIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const drafts = useRef(new Map<string, string>());

  const updateText = (value: string) => {
    if (activeIdRef.current) drafts.current.set(activeIdRef.current, value);
    setText(value);
  };

  useEffect(() => {
    const resize = () => {
      const textarea = composer.current;
      if (!textarea) return;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [text, activeId, detail?.id]);

  const redirectIfUnauthorized = useCallback((status: number): boolean => {
    if (status !== 401) return false;
    window.location.replace("/login");
    return true;
  }, []);

  const setUrlConversation = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("conversation", id);
    else url.searchParams.delete("conversation");
    window.history.replaceState(null, "", url);
  }, []);

  const commitConversations = useCallback((next: Conversation[]) => {
    conversationsRef.current = next;
    setConversations(next);
  }, []);

  const selectConversation = useCallback((id: string) => {
    activeIdRef.current = id;
    setActionError(null);
    setDetailError(null);
    setLiveError(false);
    setOptimisticMessage(null);
    setDetail(null);
    setText(drafts.current.get(id) ?? "");
    setHistoryOpen(false);
    setActiveId(id);
    setUrlConversation(id);
  }, [setUrlConversation]);

  const clearConversation = useCallback(() => {
    activeIdRef.current = null;
    setActiveId(null);
    setDetail(null);
    setDetailError(null);
    setLiveError(false);
    setOptimisticMessage(null);
    setText("");
    setUrlConversation(null);
  }, [setUrlConversation]);

  const refreshConversations = useCallback(async (): Promise<Conversation[] | null> => {
    const result = await requestJson("/api/assistant/conversations", { method: "GET" }, isConversationList);
    if (!result.ok) {
      if (!redirectIfUnauthorized(result.status)) setListState("unavailable");
      return null;
    }
    commitConversations(result.value.conversations);
    setListState("ready");
    return result.value.conversations;
  }, [commitConversations, redirectIfUnauthorized]);

  const loadSettings = useCallback(async () => {
    const result = await requestJson("/api/assistant/settings", { method: "GET" }, isAssistantSettings);
    if (!result.ok) {
      if (!redirectIfUnauthorized(result.status)) {
        setSettingsState("unavailable");
        setSettingsError(result.error);
      }
      return;
    }
    setSettingsError(null);
    setSettings(result.value);
    setSettingsProvider(result.value.provider);
    setSettingsModel(result.value.model);
    setSettingsState("ready");
  }, [redirectIfUnauthorized]);

  const removeConversation = useCallback((id: string, notice: string) => {
    const remaining = conversationsRef.current.filter((conversation) => conversation.id !== id);
    commitConversations(remaining);
    if (activeIdRef.current !== id) return;

    setDetail(null);
    if (remaining[0]) {
      selectConversation(remaining[0].id);
    } else {
      clearConversation();
    }
    setActionError(notice);
  }, [clearConversation, commitConversations, selectConversation]);

  const loadConversation = useCallback(async (id: string) => {
    const result = await requestJson(
      `/api/assistant/conversations/${encodeURIComponent(id)}`,
      { method: "GET" },
      isConversationDetail,
    );
    if (activeIdRef.current !== id) return;
    if (!result.ok) {
      if (result.status === 404) {
        removeConversation(id, "This conversation was removed.");
        void refreshConversations();
      } else if (!redirectIfUnauthorized(result.status)) {
        setDetailError(result.error);
      }
      return;
    }
    setDetail(result.value);
    commitConversations(replaceConversation(conversationsRef.current, result.value));
    setDetailError(null);
    setOptimisticMessage(null);
  }, [commitConversations, redirectIfUnauthorized, refreshConversations, removeConversation]);

  useEffect(() => {
    const requestedId = new URL(window.location.href).searchParams.get("conversation");
    if (requestedId) {
      activeIdRef.current = requestedId;
      setActiveId(requestedId);
    }

    let cancelled = false;
    void refreshConversations().then((next) => {
      if (!cancelled && !requestedId && !activeIdRef.current && next?.[0]) {
        selectConversation(next[0].id);
      }
    });
    void loadSettings();
    return () => { cancelled = true; };
  }, [loadSettings, refreshConversations, selectConversation]);

  useEffect(() => {
    if (!activeId) return;
    void loadConversation(activeId);
  }, [activeId, loadConversation]);

  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    let verifying = false;
    const events = new EventSource(`/api/assistant/conversations/${encodeURIComponent(activeId)}/events`);
    const applySnapshot = (event: Event) => {
      if (!(event instanceof MessageEvent)) return;
      try {
        const snapshot: unknown = JSON.parse(event.data);
        if (!isConversationDetail(snapshot) || activeIdRef.current !== activeId || snapshot.id !== activeId) return;
        setDetail(snapshot);
        commitConversations(replaceConversation(conversationsRef.current, snapshot));
        setDetailError(null);
        setLiveError(false);
        setOptimisticMessage(null);
      } catch {
        if (activeIdRef.current === activeId) setLiveError(true);
      }
    };
    const verifyReconnect = async () => {
      if (verifying || stopped || activeIdRef.current !== activeId) return;
      verifying = true;
      const result = await requestJson(
        `/api/assistant/conversations/${encodeURIComponent(activeId)}`,
        { method: "GET" },
        isConversationDetail,
      );
      verifying = false;
      if (stopped || activeIdRef.current !== activeId) return;
      if (result.ok) return;
      if (result.status === 404) {
        stopped = true;
        events.close();
        removeConversation(activeId, "This conversation was removed.");
        void refreshConversations();
      } else if (!redirectIfUnauthorized(result.status)) {
        setLiveError(true);
      }
    };
    events.onmessage = applySnapshot;
    events.addEventListener("snapshot", applySnapshot);
    events.onerror = () => {
      if (stopped || activeIdRef.current !== activeId) return;
      setLiveError(true);
      void verifyReconnect();
    };
    return () => {
      stopped = true;
      events.removeEventListener("snapshot", applySnapshot);
      events.close();
    };
  }, [activeId, commitConversations, redirectIfUnauthorized, refreshConversations, removeConversation]);

  const createConversation = async () => {
    const originId = activeIdRef.current;
    setActionError(null);
    setIsCreating(true);
    const result = await requestJson(
      "/api/assistant/conversations",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      isConversation,
    );
    setIsCreating(false);
    if (!result.ok) {
      if (activeIdRef.current === originId && !redirectIfUnauthorized(result.status)) {
        setActionError(result.error);
      }
      return;
    }
    commitConversations(replaceConversation(conversationsRef.current, result.value));
    if (activeIdRef.current !== originId) return;
    selectConversation(result.value.id);
    window.setTimeout(() => composer.current?.focus(), 0);
  };

  const sendTurn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const conversation = detail?.id === activeId ? detail : null;
    const message = text.trim();
    if (!message || !conversation || conversation.turn?.status === "running" || sendingIds.has(conversation.id)) return;

    const conversationId = conversation.id;
    drafts.current.delete(conversationId);
    setActionError(null);
    setSendingIds((previous) => new Set(previous).add(conversationId));
    setOptimisticMessage({ id: `pending-${crypto.randomUUID()}`, role: "user", text: message, pending: true });
    setText("");
    const result = await requestJson(
      `/api/assistant/conversations/${encodeURIComponent(conversationId)}/turns`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: message }) },
      isTurn,
    );
    setSendingIds((previous) => {
      const next = new Set(previous);
      next.delete(conversationId);
      return next;
    });
    if (!result.ok) drafts.current.set(conversationId, message);
    if (activeIdRef.current !== conversationId) return;
    if (!result.ok) {
      setText(message);
      setOptimisticMessage(null);
      if (result.status === 409) {
        setActionError("This conversation is already working. Its latest state has been refreshed.");
        void loadConversation(conversationId);
      } else if (!redirectIfUnauthorized(result.status)) {
        setActionError(result.error);
      }
      return;
    }
    setDetail((previous) => previous && previous.id === conversationId ? { ...previous, turn: result.value } : previous);
    void loadConversation(conversationId);
  };

  const deleteConversation = async (conversation: Conversation) => {
    if (conversation.turn?.status === "running") return;

    const wasActive = activeIdRef.current === conversation.id;
    setActionError(null);
    setDeletingId(conversation.id);
    try {
      const response = await fetch(`/api/assistant/conversations/${encodeURIComponent(conversation.id)}`, {
        method: "DELETE",
        headers: { "Cache-Control": "no-store" },
      });
      if (response.status === 401) {
        redirectIfUnauthorized(response.status);
        return;
      }
      if (response.status !== 204) throw new Error(await responseError(response));
      drafts.current.delete(conversation.id);
      const remaining = conversationsRef.current.filter(({ id }) => id !== conversation.id);
      commitConversations(remaining);
      if (wasActive && activeIdRef.current === conversation.id) {
        if (remaining[0]) selectConversation(remaining[0].id);
        else clearConversation();
      }
    } catch (error) {
      if (activeIdRef.current === conversation.id) {
        setActionError(error instanceof Error ? error.message : "Could not delete this conversation.");
      }
    } finally {
      setDeletingId((current) => current === conversation.id ? null : current);
    }
  };

  const saveSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSettingsError(null);
    setSettingsSaving(true);
    const result = await requestJson(
      "/api/assistant/settings",
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: settingsProvider, model: settingsModel }) },
      isAssistantSettings,
    );
    setSettingsSaving(false);
    if (!result.ok) {
      if (!redirectIfUnauthorized(result.status)) setSettingsError(result.error);
      return;
    }
    setSettings(result.value);
    setSettingsProvider(result.value.provider);
    setSettingsModel(result.value.model);
    setSettingsError(null);
    setSettingsOpen(false);
  };

  const changeSettingsProvider = (provider: AssistantProviderId) => {
    if (!settings) return;
    const nextProvider = settings.providers.find((item) => item.id === provider);
    if (!nextProvider) return;
    const remembered = settings.lastModels[provider];
    setSettingsProvider(provider);
    setSettingsModel(nextProvider.models.some((model) => model.id === remembered) ? remembered : nextProvider.models[0]?.id ?? "");
    setModelSearch("");
    setModelFilter("all");
  };

  const selectedProvider = settings?.providers.find((provider) => provider.id === settingsProvider);
  const selectedModelOption = selectedProvider?.models.find((model) => model.id === settingsModel);
  const selectedModelAvailable = Boolean(selectedModelOption);
  const visibleModels = selectedProvider?.models.filter((model) =>
    (modelFilter === "all" || (modelFilter === "free" ? model.free : !model.free)) &&
    `${model.name} ${model.id}`.toLowerCase().includes(modelSearch.trim().toLowerCase()),
  ) ?? [];
  const activeConversation = detail?.id === activeId ? detail : null;
  const entries = activeConversation ? conversationEntries(activeConversation) : [];
  if (activeConversation && optimisticMessage) entries.push({ type: "message", value: optimisticMessage });
  const groupedEntries = groupThreadEntries(entries);
  const savedProvider = settings?.providers.find((provider) => provider.id === settings?.provider);
  const savedModel = savedProvider?.models.find((model) => model.id === settings?.model);
  const modelLabel = settings ? `${savedProvider?.name ?? settings.provider} · ${savedModel?.name ?? settings.model}` : "Provider and model";
  const openSettings = (open: boolean) => {
    if (open && settings) {
      setSettingsProvider(settings.provider);
      setSettingsModel(settings.model);
      setModelSearch("");
      setModelFilter("all");
      setSettingsError(null);
    }
    setSettingsOpen(open);
  };
  const isSending = activeId ? sendingIds.has(activeId) : false;
  const isRunning = activeConversation?.turn?.status === "running" || isSending;
  const composerDisabled = !activeConversation || isRunning;

  const sortedConversations = [...conversations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const today = new Date().toDateString();
  const historyGroups = [
    { label: "Today", items: sortedConversations.filter((conversation) => new Date(conversation.updatedAt).toDateString() === today) },
    { label: "Earlier", items: sortedConversations.filter((conversation) => new Date(conversation.updatedAt).toDateString() !== today) },
  ];
  const history = () => (
    <>
      <Button className="assistant-new-conversation" type="button" variant="outline" onClick={createConversation} disabled={isCreating}>
        <MessageSquarePlus data-icon="inline-start" aria-hidden="true" />
        {isCreating ? "Creating..." : "New conversation"}
      </Button>
      {listState === "unavailable" && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>History is unavailable. Saved conversations already on screen remain available.</AlertDescription>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refreshConversations()}>Retry</Button>
        </Alert>
      )}
      <div className="assistant-conversation-items" aria-busy={listState === "loading"}>
        {listState === "loading" && <p className="assistant-list-status" role="status">Loading history...</p>}
        {listState === "ready" && conversations.length === 0 && <p className="assistant-list-status">No saved conversations.</p>}
        {historyGroups.map((group) => group.items.length > 0 && (
          <section className="assistant-history-group" key={group.label} aria-label={group.label}>
            <h2>{group.label}</h2>
            <ul>
              {group.items.map((conversation) => {
                const isActive = conversation.id === activeId;
                return (
                  <li className="assistant-conversation-item" key={conversation.id} data-active={isActive}>
                    <Button
                      className="assistant-conversation-select"
                      type="button"
                      variant="ghost"
                      aria-current={isActive ? "page" : undefined}
                      title={conversation.title || "Untitled conversation"}
                      onClick={() => selectConversation(conversation.id)}
                    >
                      <span className="truncate">{conversation.title || "Untitled conversation"}</span>
                      <time dateTime={conversation.updatedAt} title={formatDate(conversation.updatedAt)}>
                        {new Date(conversation.updatedAt).toDateString() === today
                          ? new Date(conversation.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                          : new Date(conversation.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </time>
                    </Button>
                    <Button
                      className="assistant-delete"
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${conversation.title || "conversation"}`}
                      title={conversation.turn?.status === "running" ? "Cannot delete a conversation while it is working" : "Delete conversation"}
                      disabled={conversation.turn?.status === "running" || deletingId === conversation.id}
                      onClick={() => setConversationPendingDeletion(conversation)}
                    >
                      <Trash2 data-icon="inline-start" aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </>
  );

  return (
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
      <Dialog open={settingsOpen} onOpenChange={openSettings}>
        <AppShell
          active="assistant"
          mobileLeading={
            <Button ref={historyTrigger} type="button" variant="ghost" size="icon" className="assistant-history-trigger" onClick={() => setHistoryOpen(true)} aria-label="Open conversations" aria-haspopup="dialog" aria-expanded={historyOpen}>
              <Menu data-icon="inline-start" aria-hidden="true" />
            </Button>
          }
          mobileTrailing={
            <Button type="button" variant="ghost" size="icon" className="assistant-mobile-new" onClick={createConversation} disabled={isCreating} aria-label="New chat">
              <MessageSquarePlus data-icon="inline-start" aria-hidden="true" />
            </Button>
          }
        >
          <div className="assistant-workbench">
            <aside className="assistant-conversation-list" aria-label="Conversations">{history()}</aside>
            <main className="assistant-main">
              <header className="assistant-page-head">
                <h1 className="truncate">{activeConversation?.title || "Assistant"}</h1>
                <div className="assistant-page-head__actions">
                  {activeConversation?.turn && activeConversation.turn.status !== "complete" && <Badge variant={turnPresentation[activeConversation.turn.status].variant}>{turnPresentation[activeConversation.turn.status].label}</Badge>}
                  <DialogTrigger render={<Button type="button" variant="outline" size="sm" className="assistant-model-chip" />}>
                    <Settings data-icon="inline-start" aria-hidden="true" />
                    <span className="truncate">{modelLabel}</span>
                  </DialogTrigger>
                </div>
              </header>
              <DialogContent className="assistant-settings">
                <DialogHeader className="pr-6">
                  <DialogTitle>Provider and model</DialogTitle>
                  <DialogDescription>Changes apply to your next message. A reply already running keeps its current model.</DialogDescription>
                </DialogHeader>
                <div className="assistant-settings__body">
            {settingsState === "loading" && <p role="status">Loading provider options...</p>}
            {settingsState === "unavailable" && <Alert variant="destructive"><CircleAlert aria-hidden="true" /><AlertTitle>Provider settings unavailable</AlertTitle><AlertDescription>{settingsError || "The Assistant worker could not return provider settings. Check that it is running the current build."}</AlertDescription><Button type="button" variant="outline" onClick={() => void loadSettings()}>Retry</Button></Alert>}
            {settingsState === "ready" && settings && (
              <form id="assistant-settings-form" className="assistant-settings__form" onSubmit={saveSettings}>
                <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="assistant-provider">Provider</FieldLabel>
                  <select id="assistant-provider" value={settingsProvider} onChange={(event) => changeSettingsProvider(event.target.value as AssistantProviderId)}>
                    {settings.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.configured ? " · Configured" : " · Setup required"}</option>)}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="assistant-model-search">Model</FieldLabel>
                  <Input id="assistant-model-search" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Search models" />
                </Field>
                {settingsProvider === "openrouter" && <Field>
                  <FieldLabel htmlFor="assistant-model-filter">Price</FieldLabel>
                  <select id="assistant-model-filter" value={modelFilter} onChange={(event) => setModelFilter(event.target.value as "all" | "free" | "paid")}>
                    <option value="all">All models</option>
                    <option value="free">Free models</option>
                    <option value="paid">Paid models</option>
                  </select>
                </Field>}
                <Field>
                  <FieldLabel htmlFor="assistant-model">Available models</FieldLabel>
                  <select id="assistant-model" value={settingsModel} onChange={(event) => setSettingsModel(event.target.value)} aria-label="Assistant model" size={6}>
                    {visibleModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                  </select>
                  {visibleModels.length === 0 && <p role="status" className="assistant-settings__hint">No models match your search.</p>}
                  {selectedModelOption && <p className="assistant-settings__hint">Selected: {selectedModelOption.name}</p>}
                  {selectedProvider && !selectedProvider.configured && <p className="assistant-settings__hint">Configure this provider on the Server before sending a message.</p>}
                  {!selectedModelAvailable && <p className="assistant-settings__hint">The saved model is no longer available. Choose another model before saving.</p>}
                  {settingsProvider === "openrouter" && selectedModelOption && <p className="assistant-settings__hint">{selectedModelOption.free ? "Free model." : selectedModelOption.inputCost < 0 || selectedModelOption.outputCost < 0 ? "Pricing depends on the routed model." : `$${selectedModelOption.inputCost} input / $${selectedModelOption.outputCost} output per 1M tokens. OpenRouter usage is billed separately.`}</p>}
                </Field>
                </FieldGroup>
                {settingsError && <Alert variant="destructive"><CircleAlert aria-hidden="true" /><AlertDescription>{settingsError}</AlertDescription></Alert>}
                <p className="assistant-settings__hint">{visibleModels.length} model{visibleModels.length === 1 ? "" : "s"} shown{selectedProvider?.id === "openrouter" ? ". Free models may still have rate limits." : "."}</p>
              </form>
            )}
                </div>
                <DialogFooter>
                  <Button type="submit" form="assistant-settings-form" disabled={settingsState !== "ready" || settingsSaving || !settingsModel || !selectedModelAvailable}>{settingsSaving ? "Saving..." : "Save settings"}</Button>
                </DialogFooter>
              </DialogContent>

        <section className="assistant-thread" aria-label="Conversation">
          <div className="assistant-notices">
            {actionError && (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>Assistant request failed</AlertTitle>
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            )}
            {detailError && (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>Conversation unavailable</AlertTitle>
                <AlertDescription>{detailError} Previously loaded history remains visible.</AlertDescription>
              </Alert>
            )}
            {liveError && activeConversation && (
              <Alert>
                <WifiOff aria-hidden="true" />
                <AlertTitle>Live updates unavailable</AlertTitle>
                <AlertDescription>Showing the last saved conversation. Reconnecting...</AlertDescription>
              </Alert>
            )}
          </div>
          {!activeId && listState !== "loading" && (
            <Empty className="assistant-empty">
              <EmptyMedia><AssistantMark /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>Start a conversation</EmptyTitle>
                <EmptyDescription>Look up movies and series, check your managed library, and read Radarr and Sonarr status. This Assistant is read-only.</EmptyDescription>
              </EmptyHeader>
              <Button type="button" onClick={createConversation} disabled={isCreating}>
                <MessageSquarePlus data-icon="inline-start" aria-hidden="true" />
                {isCreating ? "Creating..." : "New conversation"}
              </Button>
            </Empty>
          )}
          {((!activeId && listState === "loading") || (activeId && !activeConversation && !detailError)) && (
            <div className="assistant-loading" role="status" aria-live="polite">
              <CircleDashed aria-hidden="true" /> Loading conversation...
            </div>
          )}
          {activeConversation && entries.length === 0 && (
            <Empty className="assistant-empty">
              <EmptyMedia><AssistantMark /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>What's in your library?</EmptyTitle>
                <EmptyDescription>Look up movies and series, check your managed library, and read Radarr and Sonarr status. This Assistant is read-only.</EmptyDescription>
              </EmptyHeader>
              <div className="assistant-example-prompts" aria-label="Example prompts">
                {["Is Dune in my library?", "Check the status of Severance"].map((prompt) => (
                  <Button key={prompt} type="button" variant="outline" disabled={composerDisabled} onClick={() => { updateText(prompt); composer.current?.focus(); }}>{prompt}</Button>
                ))}
              </div>
            </Empty>
          )}
          {activeConversation && entries.length > 0 && (
            <MessageScrollerProvider autoScroll defaultScrollPosition="end">
              <MessageScroller className="assistant-message-scroller">
                <MessageScrollerViewport aria-label="Conversation messages">
                  <MessageScrollerContent className="assistant-messages" role="log" aria-live="polite" aria-relevant="additions text">
                    {groupedEntries.map((entry) => {
                      const id = entry.type === "activity" ? entry.id : `message-${entry.value.id}`;
                      return (
                        <MessageScrollerItem key={id} messageId={id}>
                          <ConversationEntry entry={entry} />
                        </MessageScrollerItem>
                      );
                    })}
                    {isRunning && (
                      <MessageScrollerItem messageId={`working-${activeConversation.turn?.id ?? "pending"}`}>
                        <div className="assistant-working" role="status">
                          <Radio aria-hidden="true" /> Assistant is working...
                        </div>
                      </MessageScrollerItem>
                    )}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton aria-label="Jump to latest message">
                  <ArrowDown data-icon="inline-start" aria-hidden="true" />
                  <span className="visually-hidden">Jump to latest message</span>
                </MessageScrollerButton>
              </MessageScroller>
            </MessageScrollerProvider>
          )}
          {activeConversation?.turn?.status === "failure" && (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Assistant work failed</AlertTitle>
              <AlertDescription>{activeConversation.turn.error || "The provider or worker could not complete this request."}</AlertDescription>
            </Alert>
          )}
          {activeConversation?.turn?.status === "interrupted" && (
            <Alert>
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Assistant work was interrupted</AlertTitle>
              <AlertDescription>{activeConversation.turn.error || "Refresh or send a new message when you are ready."}</AlertDescription>
            </Alert>
          )}
        </section>

        <div className="assistant-composer-wrap">
        <form className="assistant-composer" onSubmit={sendTurn}>
          <FieldGroup>
            <Field data-disabled={composerDisabled || undefined}>
              <FieldLabel className="visually-hidden" htmlFor="assistant-message">Message the Assistant</FieldLabel>
              <Textarea
                ref={composer}
                id="assistant-message"
                value={text}
                onChange={(event) => updateText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (window.matchMedia("(max-width: 859px) and (pointer: coarse)").matches) return;
                  event.preventDefault();
                  if (!event.repeat && !composerDisabled && text.trim()) event.currentTarget.form?.requestSubmit();
                }}
                placeholder={activeConversation ? "Message the Assistant..." : "Select or create a conversation to send a message"}
                disabled={composerDisabled}
                maxLength={8000}
                rows={1}
              />
            </Field>
          </FieldGroup>
          <div className="assistant-composer__actions">
            <DialogTrigger render={<Button type="button" variant="ghost" size="sm" className="assistant-composer-model" />} aria-label={`Provider and model settings: ${modelLabel}`}>
              <Settings data-icon="inline-start" aria-hidden="true" />
              <span className="truncate">{settings?.model ?? "Model settings"}</span>
            </DialogTrigger>
            <span className="assistant-composer-hint">Enter to send · Shift+Enter for a new line</span>
            <Button type="submit" size="icon" className="assistant-send" aria-label="Send message" disabled={composerDisabled || !text.trim()}>
              <ArrowUp data-icon="inline-start" aria-hidden="true" />
            </Button>
          </div>
        </form>
        </div>
      </main>
      </div>
      </AppShell>
      </Dialog>
      <DialogContent className="assistant-history-drawer" finalFocus={historyTrigger}>
        <DialogHeader>
          <DialogTitle>Conversations</DialogTitle>
          <DialogDescription className="visually-hidden">Resume or create a saved conversation.</DialogDescription>
        </DialogHeader>
        {history()}
      </DialogContent>
      <AlertDialog
        open={Boolean(conversationPendingDeletion)}
        onOpenChange={(open) => {
          if (!open) setConversationPendingDeletion(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {conversationPendingDeletion?.title || "this conversation"} and its saved history. It does not undo completed Assistant work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              onClick={() => {
                const conversation = conversationPendingDeletion;
                setConversationPendingDeletion(null);
                if (conversation) void deleteConversation(conversation);
              }}
            >
              Delete conversation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
