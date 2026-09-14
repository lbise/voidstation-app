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
};

export type ErrorResponse = {
  error: string;
};
