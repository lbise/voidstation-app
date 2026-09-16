import type { SavedMediaResult } from "./media-contract.ts";
export type { SavedMediaResult } from "./media-contract.ts";

export type TurnStatus = "running" | "complete" | "interrupted" | "failure";

export interface Turn {
  id: string;
  status: TurnStatus;
  error: string | null;
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
}

export interface ConversationDetail extends Conversation {
  messages: Message[];
  mediaResults: SavedMediaResult[];
}

export interface ErrorResponse {
  error: string;
}
