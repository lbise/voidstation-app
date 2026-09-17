export type MediaType = "movie" | "series";
export type MediaService = "radarr" | "sonarr";
export type MonitoringMode = "all" | "future" | "none" | "seasons";

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

export interface MediaLibraryItem extends MediaChoice {
  libraryId: number;
  missing: boolean;
  monitored?: boolean;
}

export interface MediaEpisode {
  season: number;
  episode: number;
  title?: string;
  monitored?: boolean;
  available?: boolean;
}

export interface MediaDetails extends MediaStatus {
  title?: string;
  year?: number;
  monitored?: boolean;
  episodes?: MediaEpisode[];
}

export type MediaResult =
  | { kind: "find"; choices: MediaChoice[]; library: MediaLibraryItem[] }
  | { kind: "lookup"; choices: MediaChoice[] }
  | { kind: "discovery"; type: MediaType; rootFolder: string; qualityProfileId: number; quality?: string }
  | ({ kind: "status" } & MediaStatus)
  | { kind: "skill"; service: MediaService; resource: string; content: string }
  | ({ kind: "details" } & MediaDetails)
  | { kind: "configure"; type: MediaType; externalId: number; created: boolean; title?: string; monitored: boolean; qualityProfileId: number }
  | { kind: "search"; type: MediaType; externalId: number; season: number | null; command: string; commandId: number | null }
  | { kind: "error"; operation: MediaOperation; code: string; message: string; data?: MediaStatus };

export type MediaOperation = "find" | "details" | "configure" | "search" | "read_skill" | "lookup" | "discovery" | "status";
export type SavedMediaResult = { id: string; turnId: string; result: MediaResult };
