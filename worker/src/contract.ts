import type { SavedMediaResult } from "./media-contract.ts";
export type { SavedMediaResult } from "./media-contract.ts";

export type TurnStatus = "running" | "complete" | "interrupted" | "failure";

export interface Turn {
  id: string;
  status: TurnStatus;
  error: string | null;
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turn: Turn | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  provider?: string;
  model?: string;
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
  mediaResults: SavedMediaResult[];
}

export interface ErrorResponse {
  error: string;
}

export type AssistantProviderId = "openai-codex" | "openrouter";

export interface AssistantModelOption {
  id: string;
  name: string;
  free: boolean;
  inputCost: number;
  outputCost: number;
  contextWindow: number;
}

export interface AssistantProviderOption {
  id: AssistantProviderId;
  name: string;
  configured: boolean;
  models: AssistantModelOption[];
}

export interface AssistantSettings {
  provider: AssistantProviderId;
  model: string;
  lastModels: Record<AssistantProviderId, string>;
  providers: AssistantProviderOption[];
}
