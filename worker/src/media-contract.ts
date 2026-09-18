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
  | ({ kind: "details" } & MediaDetails)
  | { kind: "configure"; type: MediaType; externalId: number; created: boolean; title?: string; monitored: boolean; monitoring: MonitoringMode; seasons?: number[]; qualityProfileId: number }
  | { kind: "search"; type: MediaType; externalId: number; season: number | null; monitoring?: MonitoringMode; seasons?: number[]; command: string; commandId: number | null; episodeCount?: number }
  | { kind: "error"; operation: MediaOperation; code: string; message: string; data?: MediaStatus };

export type MediaOperation = "find" | "details" | "configure" | "search" | "lookup" | "discovery" | "status";
export type SavedMediaResult = { id: string; turnId: string; result: MediaResult };
