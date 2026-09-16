import type { MediaResult, SavedMediaResult } from "../../worker/src/media-contract";
export type { MediaResult, SavedMediaResult } from "../../worker/src/media-contract";

export type TurnStatus = "running" | "complete" | "interrupted" | "failure";

export type Turn = {
  id: string;
  status: TurnStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turn: Turn | null;
};

export type ConversationDetail = Conversation & {
  messages: Message[];
  mediaResults: SavedMediaResult[];
};

export type ErrorResponse = {
  error: string;
};
