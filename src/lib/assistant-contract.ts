import type { MediaResult, SavedMediaResult } from "../../worker/src/media-contract";
export type { MediaResult, SavedMediaResult } from "../../worker/src/media-contract";

export type TurnStatus = "running" | "complete" | "interrupted" | "failure";

export type Turn = {
  id: string;
  status: TurnStatus;
  error: string | null;
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  provider?: string;
  model?: string;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turn: Turn | null;
};

export type ToolCallRecord = {
  id: string;
  turnId: string;
  name: string;
  parameters: Record<string, unknown>;
  result: unknown;
  status: "complete" | "error";
};

export type ConversationDetail = Conversation & {
  messages: Message[];
  mediaResults: SavedMediaResult[];
  toolCalls: ToolCallRecord[];
};

export type ErrorResponse = {
  error: string;
};

export type AssistantProviderId = "openai-codex" | "openrouter";

export type AssistantModelOption = {
  id: string;
  name: string;
  free: boolean;
  inputCost: number;
  outputCost: number;
  contextWindow: number;
};

export type AssistantProviderOption = {
  id: AssistantProviderId;
  name: string;
  configured: boolean;
  models: AssistantModelOption[];
};

export type AssistantSettings = {
  provider: AssistantProviderId;
  model: string;
  lastModels: Record<AssistantProviderId, string>;
  providers: AssistantProviderOption[];
};
