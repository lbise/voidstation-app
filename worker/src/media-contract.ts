export type MediaType = "movie" | "series";
export type MediaService = "radarr" | "sonarr";

export interface MediaChoice {
  externalId: number;
  title: string;
  year: number | null;
  type: MediaType;
}

export interface MediaStatus {
  type: MediaType;
  externalId: number;
  tracked: boolean | null;
  activeDownload: boolean | null;
  available: boolean | null;
}

export type MediaResult =
  | { kind: "skill"; service: MediaService; resource: string; content: string }
  | { kind: "lookup"; choices: MediaChoice[] }
  | { kind: "discovery"; type: MediaType; rootFolder: string; qualityProfileId: number; quality?: string }
  | ({ kind: "status" } & MediaStatus)
  | { kind: "error"; operation: "read_skill" | "lookup" | "discovery" | "status"; code: string; message: string; data?: MediaStatus };

export type SavedMediaResult = { id: string; turnId: string; result: MediaResult };
