// Mirrors src/lib/downloads-contract.ts; keep both copies identical apart from import paths.
import type { MediaService } from "./media-contract.ts";

export type DownloadStatus =
  | "downloading"
  | "queued"
  | "paused"
  | "delayed"
  | "importing"
  | "completed"
  | "warning"
  | "failed";

export type DownloadItem = {
  /** Stable within one response: `${service}-${downloadId or queue id}`. */
  id: string;
  service: MediaService;
  /** Movie "Title (Year)", or series "Title · S02E05" / "Title · Season 2 (10 episodes)". */
  title: string;
  status: DownloadStatus;
  /** First Radarr/Sonarr status or error message, at most 200 characters. */
  problem: string | null;
  /** Bytes; null when the download client has not reported a size. */
  size: number | null;
  sizeLeft: number | null;
  /** 0–100, derived from size and sizeLeft; null when size is unknown or 0. */
  progress: number | null;
  /** ISO time reported by the download client; null when unknown. */
  estimatedCompletion: string | null;
};

export type ServiceQueue =
  | {
    status: "available";
    /** At most 50 items, problems first, then by estimated completion. */
    items: DownloadItem[];
    /** Items in the queue after grouping, including those beyond the 50 returned. */
    total: number;
    observedAt: string;
  }
  | {
    status: "unavailable";
    reason: "not_configured" | "service_unavailable" | "timed_out" | "invalid_response";
    observedAt: null;
  };

/** GET /api/downloads */
export type DownloadQueue = { radarr: ServiceQueue; sonarr: ServiceQueue };
