export type {
  CommandError,
  ErrorCode,
  MediaKind,
  Album,
  Tag,
  ScanResult,
  LibraryFolder,
  OpenPath,
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
  TrashRestoreItem,
  TrashRestoreFailure,
  TrashRestoreResult,
  DuplicateGroup,
  FileDuplicateItem,
  FileDuplicateGroup,
  FileDuplicateScan,
  FileDuplicateTrashResult,
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
  AudioTrackInfo,
  SubtitleTrackInfo,
  PlaybackStrategy,
  PreparedPlayback,
  PlaybackConversionProgress,
  UpdateCheck,
  AppSettings,
  PartialSettings,
  StorageUsage,
  CacheKind,
  ClearCacheResult,
  JunkCategory,
  JunkTier,
  ScanStatus,
  SkipReason,
  JunkItem,
  JunkSkip,
  JunkCategoryReport,
  JunkFailure,
  JunkCleanResult,
  JunkIgnoredItem,
  DiskSpace,
  LibraryFootprint,
  CleanupRun,
  CleanupOverview,
  TimelineMonth,
  HiddenLockStatus,
  DisplayPreview,
  DefaultAppGroup,
  DefaultAppType,
  DefaultAppsStatus,
  DefaultAppTarget,
  SetDefaultOutcome,
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
  "scanning" | "reading" | "hashing" | "analyzing" | "indexing" | "trashing" | "complete";

/**
 * Progress the any-file duplicate scan emits on `file-duplicates-progress`. A
 * separate stream from imports, so an unrelated library operation cannot
 * overwrite it.
 */
export interface FileDuplicatesProgressEvent {
  phase: "walking" | "hashing";
  processed: number;
  total: number;
  currentFile?: string;
  bytesProcessed?: number;
}

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
