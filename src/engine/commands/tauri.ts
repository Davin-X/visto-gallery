import { invoke } from "@tauri-apps/api/core";
import type {
  ScanResult,
  MediaItem,
  Album,
  Tag,
  ImportSession,
  LibraryFilterDTO,
  ThumbnailRequest,
  ThumbnailResponse,
  ExifData,
  RenderRequest,
  ExportResult,
  BatchExportRequest,
  BatchExportResult,
  BatchProgressEvent,
  DuplicateGroup,
  LibraryFolder,
  LibraryChangedEvent,
  ImportProgressEvent,
  ThumbnailReadyEvent,
  AppSettings,
  EditValues,
  CropRect,
  TrashResult,
  TrashError,
} from "../types/commands";

// Type-safe command wrappers
export const tauri = {
  library: {
    scan: (rootPath: string, force = false): Promise<ScanResult> =>
      invoke("scan_library", { rootPath, force }),

    cancelScan: (): Promise<void> => invoke("cancel_scan"),

    importFiles: (paths: string[]): Promise<ScanResult> =>
      invoke("import_files", { paths }),

    getItems: (filter: LibraryFilterDTO): Promise<MediaItem[]> =>
      invoke("get_library_items", { filter }),

    getThumbnail: (request: ThumbnailRequest): Promise<ThumbnailResponse> =>
      invoke("get_item_thumbnail", { request }),

    watchFolder: (path: string): Promise<void> =>
      invoke("watch_folder", { path }),

    unwatchFolder: (path: string): Promise<void> =>
      invoke("unwatch_folder", { path }),

    getFolders: (): Promise<LibraryFolder[]> =>
      invoke("get_library_folders"),

    removeFolder: (path: string, deleteFiles = false): Promise<number> =>
      invoke("remove_library_folder", { path, deleteFiles }),

    deleteDatabase: (): Promise<void> =>
      invoke("delete_library_database"),
  },

  items: {
    toggleFavorite: (itemId: string, favorite: boolean): Promise<void> =>
      invoke("toggle_favorite", { itemId, favorite }),

    toggleHidden: (itemId: string, hidden: boolean): Promise<void> =>
      invoke("toggle_hidden", { itemId, hidden }),

    updateTags: (itemId: string, tags: string[]): Promise<void> =>
      invoke("update_item_tags", { itemId, tags }),

    moveToTrash: (paths: string[]): Promise<TrashResult> =>
      invoke("move_to_trash", { paths }),

    cancelMoveToTrash: (): Promise<void> =>
      invoke("cancel_move_to_trash"),

    revealInFinder: (path: string): Promise<void> =>
      invoke("reveal_in_finder", { path }),

    openFolder: (path: string): Promise<void> =>
      invoke("open_folder", { path }),
  },

  albums: {
    get: (): Promise<Album[]> =>
      invoke("get_albums"),

    getTags: (): Promise<Tag[]> =>
      invoke("get_tags"),

    create: (name: string, colorIndex?: number): Promise<Album> =>
      invoke("create_album", { name, colorIndex }),

    delete: (albumId: string): Promise<void> =>
      invoke("delete_album", { albumId }),

    rename: (albumId: string, name: string): Promise<void> =>
      invoke("rename_album", { albumId, name }),

    addItems: (albumId: string, itemIds: string[]): Promise<void> =>
      invoke("add_to_album", { albumId, itemIds }),

    removeItems: (albumId: string, itemIds: string[]): Promise<void> =>
      invoke("remove_from_album", { albumId, itemIds }),
  },

  metadata: {
    readExif: (path: string): Promise<ExifData> =>
      invoke("read_exif", { path }),

    writeExif: (path: string, data: Partial<ExifData>): Promise<void> =>
      invoke("write_exif", { path, data }),
  },

  editing: {
    render: (request: RenderRequest): Promise<ExportResult> =>
      invoke("render_edited", { request }),
  },

  batch: {
    export: (request: BatchExportRequest): Promise<BatchExportResult> =>
      invoke("batch_export", { request }),

    cancel: (): Promise<void> =>
      invoke("cancel_batch_export"),
  },

  duplicates: {
    scan: (): Promise<DuplicateGroup[]> =>
      invoke("find_duplicates"),

    cancel: (): Promise<void> =>
      invoke("cancel_find_duplicates"),
  },

  finder: {
    writeTags: (path: string, tags: string[]): Promise<void> =>
      invoke("write_finder_tags", { path, tags }),

    readTags: (path: string): Promise<string[]> =>
      invoke("read_finder_tags", { path }),
  },

  settings: {
    get: (): Promise<AppSettings> =>
      invoke("get_settings"),

    save: (settings: Partial<AppSettings>): Promise<AppSettings> =>
      invoke("save_settings", { settings }),
  },

  app: {
    getVersion: (): Promise<string> =>
      invoke("get_version"),

    checkUpdates: (): Promise<{ available: boolean; version: string; notes: string }> =>
      invoke("check_updates"),

    openExternal: (url: string): Promise<void> =>
      invoke("open_external", { url }),

    exportBytes: (suggestedName: string, bytes: Uint8Array, backup?: boolean): Promise<string> =>
      invoke("export_bytes", { suggestedName, bytes: Array.from(bytes), backup }),
  },
};

import { listen } from "@tauri-apps/api/event";

// Event listeners
export const events = {
  onLibraryChanged: (callback: (event: LibraryChangedEvent) => void) =>
    listen("library-changed", (e: any) => callback(e.payload)),

  onImportProgress: (callback: (event: ImportProgressEvent) => void) =>
    listen("import-progress", (e: any) => callback(e.payload)),

  onThumbnailReady: (callback: (event: ThumbnailReadyEvent) => void) =>
    listen("thumbnail-ready", (e: any) => callback(e.payload)),

  onBatchProgress: (callback: (event: BatchProgressEvent) => void) =>
    listen("batch-progress", (e: any) => callback(e.payload)),
};

// Helper: Build thumbnail data URL from response
export function thumbnailToDataUrl(response: ThumbnailResponse): string {
  return response.dataUrl;
}

// Helper: Default edit values
export const defaultEdits: EditValues = {
  exposure: 0,
  contrast: 0,
  warmth: 0,
  shadows: 0,
  highlights: 0,
  saturation: 0,
  rotation: 0,
  flip: false,
};

// Helper: Format bytes with unit scaling (B → KB → MB → GB → TB)
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

// Helper: Format dimensions
export function formatDimensions(item: Pick<MediaItem, "width" | "height">): string {
  return item.width && item.height ? `${item.width.toLocaleString()} × ${item.height.toLocaleString()}` : "Unavailable";
}

// Helper: Format date
export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(timestamp);
}

// Helper: Format date short
export function formatDateShort(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

// Helper: Format time
export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
