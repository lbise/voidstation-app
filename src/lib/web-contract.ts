export type WebSearchCategory = "general" | "videos" | "news";
export type WebTimeRange = "day" | "week" | "month" | "year";
export type WebOperation = "search" | "fetch";

export interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
  publishedAt?: string;
  thumbnail?: string;
}

export interface WebLink {
  text: string;
  url: string;
}

export type WebResult =
  | { kind: "webSearch"; query: string; category: WebSearchCategory; results: WebSearchHit[] }
  | { kind: "webPage"; url: string; title?: string; siteName?: string; excerpt?: string; characters: number; truncated: boolean; videos: string[] }
  | { kind: "error"; operation: WebOperation; code: string; message: string };
