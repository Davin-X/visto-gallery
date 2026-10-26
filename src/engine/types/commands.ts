export type { MediaItem, Album, Tag, ImportSession, LibraryFilter, DuplicateGroup } from "./media";
export type { AppSettings } from "./settings";

import type { MediaItem, Album, Tag, ImportSession, LibraryFilter, DuplicateGroup, MediaKind } from "./media";
import type { AppSettings } from "./settings";

export interface ScanResult {
  items: MediaItem[];
  discoveredCount: number;
  removedCount: number;
  cancelled: boolean;
  albums: Album[];
  tags: Tag[];
  sessions: ImportSession[];
  totalSize: number;
  duration: number;
}

export interface LibraryFilterDTO {
  kind?: string;
  favorite?: boolean;
  hidden?: boolean;
  albumId?: string;
  query?: string;
  tags?: string[];
  dateFrom?: number;
  dateTo?: number;
  limit?: number;
  offset?: number;
  sortBy?: "capturedAt" | "modifiedAt" | "name" | "size" | "kind";
  sortOrder?: "asc" | "desc";
}

export interface ThumbnailRequest {
  itemId: string;
  size: 64 | 128 | 256 | 512 | 1024;
  format?: "jpeg" | "webp" | "avif";
}

export interface ThumbnailResponse {
  itemId: string;
  dataUrl: string;           // base64 data URL
  width: number;
  height: number;
}

export interface ExifData {
  capturedAt?: number;
  camera?: string;
  lens?: string;
  exposure?: string;
  iso?: number;
  latitude?: number;
  longitude?: number;
  width?: number;
  height?: number;
  metadataError?: string;
}

export interface RenderRequest {
  sourcePath: string;
  edits: EditValues;
  outputFormat: "jpeg" | "png" | "webp" | "heic" | "avif" | "in_place";
  quality: number;
  stripMetadata: boolean;
  crop?: CropRect;
}

export interface EditValues {
  exposure: number;
  contrast: number;
  warmth: number;
  shadows: number;
  highlights: number;
  saturation: number;
  rotation: number;
  flip: boolean;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportResult {
  outputPath: string;
  size: number;
  width: number;
  height: number;
}

export interface BatchExportRequest {
  items: BatchExportItem[];
  outputFolder: string;
  pattern: string;
  format: "jpeg" | "png" | "webp" | "heic" | "avif" | "source";
  quality: number;
  stripMetadata: boolean;
  maxDimension?: number;
}

export interface BatchExportItem {
  id: string;
  sourcePath: string;
  index: number;
  kind?: MediaKind;
  date?: number;
}

export interface BatchExportResult {
  exported: number;
  failed: Array<{ itemId: string; error: string }>;
  outputs: string[];
}

export interface TrashResult {
  trashed: string[];
  failed: Array<{ path: string; error: string }>;
}

export interface TrashError {
  path: string;
  error: string;
}

export interface LibraryChangedEvent {
  type: "added" | "updated" | "removed" | "reindexed";
  itemIds: string[];
  timestamp: number;
}

export interface ImportProgressEvent {
  sessionId: string;
  phase: "scanning" | "reading" | "hashing" | "indexing" | "complete";
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

export interface BatchProgressEvent {
  current: number;
  total: number;
  currentFile: string;
}

/**
 * A folder the library is made of. `itemCount`/`totalSize` are computed from
 * the catalog, not stored, so they always match what the grid shows.
 */
export interface LibraryFolder {
  path: string;
  name: string;
  itemCount: number;
  totalSize: number;
}

// Tauri Command Signatures (for type-safe invoke)
// Using a mapped type for command signatures
export type TauriCommandSignature = {
  // Library
  scan_library: (rootPath: string, force: boolean) => ScanResult;
  cancel_scan: () => void;
  cancel_move_to_trash: () => void;
  import_files: (paths: string[]) => ScanResult;
  get_library_items: (filter: LibraryFilterDTO) => MediaItem[];
  get_item_thumbnail: (request: ThumbnailRequest) => ThumbnailResponse;
  watch_folder: (path: string) => void;
  unwatch_folder: (path: string) => void;
  get_library_folders: () => LibraryFolder[];
  remove_library_folder: (path: string, deleteFiles?: boolean) => number;

  // Items
  toggle_favorite: (itemId: string, favorite: boolean) => void;
  toggle_hidden: (itemId: string, hidden: boolean) => void;
  update_item_tags: (itemId: string, tags: string[]) => void;
  move_to_trash: (paths: string[]) => void;
  reveal_in_finder: (path: string) => void;
  open_folder: (path: string) => void;

  // Albums
  create_album: (name: string, colorIndex?: number) => Album;
  delete_album: (albumId: string) => void;
  rename_album: (albumId: string, name: string) => void;
  add_to_album: (albumId: string, itemIds: string[]) => void;
  remove_from_album: (albumId: string, itemIds: string[]) => void;

  // Metadata
  read_exif: (path: string) => ExifData;
  write_exif: (path: string, data: Partial<ExifData>) => void;

  // Editing
  render_edited: (request: RenderRequest) => ExportResult;

  // Batch
  batch_export: (request: BatchExportRequest) => BatchExportResult;
  cancel_batch_export: () => void;

  // Duplicates
  find_duplicates: () => DuplicateGroup[];
  cancel_find_duplicates: () => void;

  // Finder
  write_finder_tags: (path: string, tags: string[]) => void;
  read_finder_tags: (path: string) => string[];

  // Settings
  get_settings: () => AppSettings;
  save_settings: (settings: Partial<AppSettings>) => AppSettings;

  // App
  get_version: () => string;
  check_updates: () => { available: boolean; version: string; notes: string };
  open_external: (url: string) => void;
};
