"use client";

import {
  ArrowDown,
  Bot,
  CircleAlert,
  CircleDashed,
  LayoutDashboard,
  MessageSquarePlus,
  Radio,
  SendHorizontal,
  Server,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { LogoutButton } from "@/components/logout-button";
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

function isConversationDetail(value: unknown): value is ConversationDetail {
  if (!isRecord(value)) return false;
  const messages = value.messages;
  return (
    isConversation(value) &&
    Array.isArray(messages) &&
    messages.every(
      (message) =>
        isRecord(message) &&
        typeof message.id === "string" &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.text === "string",
    )
  );
}

function isConversationList(value: unknown): value is ConversationListResponse {
  return isRecord(value) && Array.isArray(value.conversations) && value.conversations.every(isConversation);
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
  const composer = useRef<HTMLTextAreaElement>(null);
  const activeIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);

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
    setText("");
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
    return () => { cancelled = true; };
  }, [refreshConversations, selectConversation]);

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

  const activeConversation = detail?.id === activeId ? detail : null;
  const messages = activeConversation
    ? optimisticMessage ? [...activeConversation.messages, optimisticMessage] : activeConversation.messages
    : [];
  const isSending = activeId ? sendingIds.has(activeId) : false;
  const isRunning = activeConversation?.turn?.status === "running" || isSending;
  const composerDisabled = !activeConversation || isRunning;

  return (
    <div className="assistant-workbench">
      <aside className="dashboard-rail">
        <div className="dashboard-wordmark">
          <span className="dashboard-mark" aria-hidden="true">V<span>/</span></span>
          voidstation<span className="dashboard-wordmark-dot" aria-hidden="true">.</span>
        </div>
        <div className="dashboard-server">
          <Server aria-hidden="true" />
          <span>Home Server<small>Ubuntu</small></span>
        </div>
        <nav className="dashboard-navigation" aria-label="Workspace">
          <a href="/"><LayoutDashboard aria-hidden="true" />Dashboard</a>
          <a href="/assistant" aria-current="page"><Bot aria-hidden="true" />Assistant</a>
        </nav>
        <LogoutButton />
      </aside>

      <section className="assistant-conversation-list" aria-labelledby="conversation-list-title">
        <div className="assistant-conversation-list__head">
          <div>
            <p className="assistant-eyebrow">History</p>
            <h2 id="conversation-list-title">Conversations</h2>
          </div>
          <Button type="button" size="icon" onClick={createConversation} disabled={isCreating} aria-label="New conversation">
            <MessageSquarePlus data-icon="inline-start" aria-hidden="true" />
          </Button>
        </div>
        {listState === "unavailable" && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>History is unavailable. Saved conversations already on screen remain available.</AlertDescription>
          </Alert>
        )}
        <div className="assistant-conversation-items" aria-busy={listState === "loading"}>
          {listState === "loading" && <p className="assistant-list-status">Loading history...</p>}
          {listState !== "loading" && conversations.length === 0 && (
            <p className="assistant-list-status">No saved conversations.</p>
          )}
          {conversations.map((conversation) => {
            const isActive = conversation.id === activeId;
            const canDelete = conversation.turn?.status !== "running";
            return (
              <div className="assistant-conversation-item" key={conversation.id} data-active={isActive}>
                <Button
                  className="assistant-conversation-select"
                  type="button"
                  variant="ghost"
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => selectConversation(conversation.id)}
                >
                  <span>{conversation.title || "Untitled conversation"}</span>
                  <small>{formatDate(conversation.updatedAt)}</small>
                </Button>
                <Button
                  className="assistant-delete"
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${conversation.title || "conversation"}`}
                  title={conversation.turn?.status === "running" ? "Cannot delete a conversation while it is working" : "Delete conversation"}
                  disabled={!canDelete || deletingId === conversation.id}
                  onClick={() => setConversationPendingDeletion(conversation)}
                >
                  <Trash2 data-icon="inline-start" aria-hidden="true" />
                </Button>
              </div>
            );
          })}
        </div>
      </section>

      <main className="assistant-main">
        <header className="assistant-page-head">
          <div>
            <p className="assistant-eyebrow">Assistant</p>
            <h1>{activeConversation?.title || "Assistant"}</h1>
          </div>
          {activeConversation?.turn && <Badge variant={turnPresentation[activeConversation.turn.status].variant}>{turnPresentation[activeConversation.turn.status].label}</Badge>}
        </header>

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
              <EmptyMedia variant="icon"><Bot aria-hidden="true" /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>Start a conversation</EmptyTitle>
                <EmptyDescription>This Assistant can chat, but cannot execute Server or media actions yet.</EmptyDescription>
              </EmptyHeader>
              <Button type="button" onClick={createConversation} disabled={isCreating}>
                <MessageSquarePlus data-icon="inline-start" aria-hidden="true" />
                {isCreating ? "Creating..." : "New conversation"}
              </Button>
            </Empty>
          )}
          {activeId && !activeConversation && !detailError && (
            <div className="assistant-loading" role="status" aria-live="polite">
              <CircleDashed aria-hidden="true" /> Loading conversation...
            </div>
          )}
          {activeConversation && messages.length === 0 && (
            <Empty className="assistant-empty">
              <EmptyMedia variant="icon"><Bot aria-hidden="true" /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>How can I help?</EmptyTitle>
                <EmptyDescription>This Assistant can chat, but cannot execute Server or media actions yet.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {activeConversation && messages.length > 0 && (
            <MessageScrollerProvider autoScroll defaultScrollPosition="end">
              <MessageScroller className="assistant-message-scroller">
                <MessageScrollerViewport aria-label="Conversation messages">
                  <MessageScrollerContent className="assistant-messages" role="log" aria-live="polite" aria-relevant="additions text">
                    {messages.map((message, index) => (
                      <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={index === messages.length - 1}>
                        <Message align={message.role === "user" ? "end" : "start"}>
                          <MessageContent>
                            <MessageHeader>{message.role === "user" ? "You" : "Assistant"}</MessageHeader>
                            <Bubble align={message.role === "user" ? "end" : "start"} variant={message.role === "user" ? "secondary" : "outline"}>
                              <BubbleContent>{message.text}</BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ))}
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

        <form className="assistant-composer" onSubmit={sendTurn}>
          <FieldGroup>
            <Field data-disabled={composerDisabled || undefined}>
              <FieldLabel className="visually-hidden" htmlFor="assistant-message">Message the Assistant</FieldLabel>
              <Textarea
                ref={composer}
                id="assistant-message"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={activeConversation ? "Message the Assistant..." : "Select or create a conversation to send a message"}
                disabled={composerDisabled}
                maxLength={8000}
                rows={3}
              />
            </Field>
          </FieldGroup>
          <div className="assistant-composer__actions">
            <p aria-live="polite">{isRunning ? "The Assistant is working. New messages are unavailable." : "This Assistant cannot execute Server or media actions yet."}</p>
            <Button type="submit" disabled={composerDisabled || !text.trim()}>
              <SendHorizontal data-icon="inline-start" aria-hidden="true" />
              Send
            </Button>
          </div>
        </form>
      </main>
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
    </div>
  );
}
