export type {
  CommandError,
  ErrorCode,
  MediaKind,
  Album,
  Tag,
  ScanResult,
  LibraryFolder,
  LibraryFilterDTO,
  LibraryItemsPage,
  LibraryStats,
  ThumbnailRequest,
  ThumbnailResponse,
  ExifData,
  RenderRequest,
  EditValues,
  CropRect,
  CropState,
  ExportResult,
  BatchExportRequest,
  BatchExportItem,
  BatchExportProgress,
  BatchExportResult,
  BatchExportError,
  TrashResult,
  TrashError,
  DuplicateGroup,
  SmartAlbumFilter,
  SmartAlbum,
  BackupInfo,
  RestoreResult,
  RootPathMappingPreview,
  RootPathMappingResult,
  AlbumOverview,
  EditRecipe,
  EditPreset,
  ExternalPlayer,
  MediaProbe,
  PlaybackStrategy,
  PreparedPlayback,
  UpdateCheck,
  AppSettings,
  PartialSettings,
} from "./generated/ipc";

export type { UpdateCheck as UpdateCheckResult } from "./generated/ipc";
export type { ImportSession, LibraryFilter, MediaItem } from "./media";
/** `batch-progress` event payload. */
export type { BatchExportProgress as BatchProgressEvent } from "./generated/ipc";

import type { TrashError } from "./generated/ipc";

export interface FinderTagFailure {
  path: string;
  error: string;
}

export interface FinderTagCopyResult {
  updated: number;
  skipped: number;
  failed: FinderTagFailure[];
  tagsByPath: Record<string, string[]>;
}

/** Phases the Rust backend emits on the `import-progress` event. */
export type BackendProgressPhase =
  "scanning" | "reading" | "hashing" | "indexing" | "trashing" | "complete";

/**
 * Outcome of a trash request, as the store reports it to the UI. Status is
 * explicit so callers never have to compare error strings.
 */
export type DeleteItemsOutcome =
  | {
      status: "done";
      trashed: number;
      failed: number;
      /** Per-item refusals, for diagnostics rather than user-facing copy. */
      failures: TrashError[];
      /** Bytes those files occupied, for the "space reclaimed" result. */
      bytes: number;
      /** Files moved, catalog not updated: a rescan is needed. */
      catalogWarning?: string;
    }
  | { status: "cancelled"; trashed: number; failed: number }
  | { status: "failed"; failures: TrashError[] };

export interface LibraryChangedEvent {
  type: "added" | "updated" | "removed" | "reindexed";
  itemIds: string[];
  timestamp: number;
}

export interface ImportProgressEvent {
  sessionId: string;
  phase: BackendProgressPhase;
  processed: number;
  total: number;
  currentFile?: string;
  bytesProcessed?: number;
  bytesTotal?: number;
  filesProcessed?: number;
  filesTotal?: number;
  currentFileBytes?: number;
  currentFileSize?: number;
}

export interface ThumbnailReadyEvent {
  itemId: string;
  size: number;
  dataUrl: string;
}
