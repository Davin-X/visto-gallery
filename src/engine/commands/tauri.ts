import { invoke } from "@tauri-apps/api/core";
import type {
  ScanResult,
  MediaItem,
  Album,
  Tag,
  ImportSession,
  LibraryFilterDTO,
  LibraryItemsPage,
  AlbumOverview,
  SmartAlbum,
  SmartAlbumFilter,
  BackupInfo,
  RestoreResult,
  RootPathMappingPreview,
  RootPathMappingResult,
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
  CropState,
  EditRecipe,
  EditPreset,
  TrashResult,
  UpdateCheckResult,
  LibraryStats,
  ExternalPlayer,
} from "../types/commands";

// Type-safe command wrappers
export const tauri = {
  library: {
    scan: (rootPath: string, force = false): Promise<ScanResult> =>
      invoke("scan_library", { rootPath, force }),

    cancelScan: (): Promise<void> => invoke("cancel_scan"),

    importFiles: (paths: string[]): Promise<ScanResult> => invoke("import_files", { paths }),

    getItems: (filter: LibraryFilterDTO): Promise<LibraryItemsPage> =>
      invoke("get_library_items", { filter }),

    getHiddenItems: (): Promise<LibraryItemsPage> => invoke("get_hidden_items"),

    getThumbnail: (request: ThumbnailRequest): Promise<ThumbnailResponse> =>
      invoke("get_item_thumbnail", { request }),

    watchFolder: (path: string): Promise<void> => invoke("watch_folder", { path }),

    unwatchFolder: (path: string): Promise<void> => invoke("unwatch_folder", { path }),

    getFolders: (): Promise<LibraryFolder[]> => invoke("get_library_folders"),

    getRoots: (): Promise<string[]> => invoke("get_library_roots"),

    getStats: (): Promise<LibraryStats> => invoke("get_library_stats"),

    removeFolder: (path: string, deleteFiles = false): Promise<number> =>
      invoke("remove_library_folder", { path, deleteFiles }),

    deleteDatabase: (): Promise<void> => invoke("delete_library_database"),

    supportedExtensions: (): Promise<string[]> => invoke("supported_extensions"),
  },

  items: {
    toggleFavorite: (itemId: string, favorite: boolean): Promise<void> =>
      invoke("toggle_favorite", { itemId, favorite }),

    toggleHidden: (itemId: string, hidden: boolean): Promise<void> =>
      invoke("toggle_hidden", { itemId, hidden }),

    setRating: (itemId: string, rating: number): Promise<void> =>
      invoke("set_rating", { itemId, rating }),

    setColorLabel: (itemId: string, colorLabel: string): Promise<void> =>
      invoke("set_color_label", { itemId, colorLabel }),

    updateTags: (itemId: string, tags: string[]): Promise<void> =>
      invoke("update_item_tags", { itemId, tags }),

    moveToTrash: (ids: string[]): Promise<TrashResult> => invoke("move_to_trash", { ids }),

    cancelMoveToTrash: (): Promise<void> => invoke("cancel_move_to_trash"),

    revealInFinder: (path: string): Promise<void> => invoke("reveal_in_finder", { path }),

    openFile: (path: string): Promise<void> => invoke("open_file", { path }),

    openWithPlayer: (path: string, player: string): Promise<void> =>
      invoke("open_with_player", { path, player }),

    externalVideoPlayers: (): Promise<ExternalPlayer[]> => invoke("external_video_players"),

    openFolder: (path: string): Promise<void> => invoke("open_folder", { path }),
  },

  albums: {
    get: (): Promise<Album[]> => invoke("get_albums"),

    getOverviews: (): Promise<AlbumOverview[]> => invoke("get_album_overviews"),

    getItems: (albumId: string): Promise<MediaItem[]> => invoke("get_album_items", { albumId }),

    getTags: (): Promise<Tag[]> => invoke("get_tags"),

    create: (name: string, colorIndex?: number): Promise<Album> =>
      invoke("create_album", { name, colorIndex }),

    delete: (albumId: string): Promise<void> => invoke("delete_album", { albumId }),

    rename: (albumId: string, name: string): Promise<void> =>
      invoke("rename_album", { albumId, name }),

    addItems: (albumId: string, itemIds: string[]): Promise<void> =>
      invoke("add_to_album", { albumId, itemIds }),

    removeItems: (albumId: string, itemIds: string[]): Promise<void> =>
      invoke("remove_from_album", { albumId, itemIds }),
  },

  smartAlbums: {
    get: (): Promise<SmartAlbum[]> => invoke("get_smart_albums"),

    create: (name: string, filter: SmartAlbumFilter): Promise<SmartAlbum> =>
      invoke("create_smart_album", { name, filter }),

    rename: (albumId: string, name: string): Promise<void> =>
      invoke("rename_smart_album", { albumId, name }),

    delete: (albumId: string): Promise<void> => invoke("delete_smart_album", { albumId }),

    getItems: (albumId: string, limit?: number, cursor?: string): Promise<LibraryItemsPage> =>
      invoke("get_smart_album_items", { albumId, limit, cursor }),
  },

  rootMap: {
    preview: (oldRoot: string, newRoot: string): Promise<RootPathMappingPreview> =>
      invoke("preview_root_path_mapping", { oldRoot, newRoot }),

    apply: (oldRoot: string, newRoot: string): Promise<RootPathMappingResult> =>
      invoke("apply_root_path_mapping", { oldRoot, newRoot }),
  },

  backup: {
    create: (destinationPath: string): Promise<BackupInfo> =>
      invoke("create_catalog_backup", { destinationPath }),

    validate: (path: string): Promise<BackupInfo> => invoke("validate_catalog_backup", { path }),

    restore: (path: string): Promise<RestoreResult> => invoke("restore_catalog_backup", { path }),
  },

  metadata: {
    readExif: (path: string): Promise<ExifData> => invoke("read_exif", { path }),

    backfillMetadata: (): Promise<number> => invoke("backfill_metadata"),
  },

  editing: {
    render: (request: RenderRequest): Promise<ExportResult> => invoke("render_edited", { request }),

    moveExportedFile: (sourcePath: string, destinationPath: string): Promise<void> =>
      invoke("move_exported_file", { sourcePath, destinationPath }),
  },

  batch: {
    export: (request: BatchExportRequest): Promise<BatchExportResult> =>
      invoke("batch_export", { request }),

    cancel: (): Promise<void> => invoke("cancel_batch_export"),
  },

  duplicates: {
    scan: (): Promise<DuplicateGroup[]> => invoke("find_duplicates"),

    cancel: (): Promise<void> => invoke("cancel_find_duplicates"),
  },

  finder: {
    writeTags: (path: string, tags: string[]): Promise<void> =>
      invoke("write_finder_tags", { path, tags }),

    readTags: (path: string): Promise<string[]> => invoke("read_finder_tags", { path }),

    /** Merge app tags into existing Finder tags without deleting any. */
    mergeTags: (path: string, tags: string[]): Promise<string[]> =>
      invoke("merge_finder_tags", { path, tags }),
  },

  settings: {
    get: (): Promise<AppSettings> => invoke("get_settings"),

    save: (settings: Partial<AppSettings>): Promise<AppSettings> =>
      invoke("save_settings", { patch: settings }),
  },

  edit: {
    saveRecipe: (req: {
      mediaId: string;
      edits: EditValues;
      crop?: CropState;
      history: EditValues[];
      historyIndex: number;
    }) => invoke<EditRecipe>("save_edit_recipe", req),

    getRecipe: (mediaId: string) => invoke<EditRecipe | null>("get_edit_recipe", { mediaId }),

    listRecipes: () => invoke<EditRecipe[]>("list_edit_recipes"),

    deleteRecipe: (mediaId: string) => invoke<boolean>("delete_edit_recipe", { mediaId }),
    revertRecipe: (mediaId: string) => invoke<boolean>("revert_edit_recipe", { mediaId }),

    copyRecipe: (req: { fromMediaId: string; toMediaId: string }) =>
      invoke<EditRecipe>("copy_edit_recipe", req),

    batchApply: (req: { mediaIds: string[]; edits: EditValues; crop?: CropState }) =>
      invoke<number>("batch_apply_edit", req),

    savePreset: (req: { id?: string; name: string; edits: EditValues; crop?: CropState }) =>
      invoke<EditPreset>("save_edit_preset", req),

    listPresets: () => invoke<EditPreset[]>("list_edit_presets"),

    deletePreset: (id: string) => invoke<boolean>("delete_edit_preset", { id }),

    applyPreset: (req: { presetId: string; mediaId: string }) =>
      invoke<EditRecipe>("apply_edit_preset", req),

    vacuumCatalog: () => invoke<void>("vacuum_catalog", {}),
  },

  app: {
    getVersion: (): Promise<string> => invoke("get_version"),

    checkUpdates: (force = false): Promise<UpdateCheckResult> => invoke("check_updates", { force }),

    openExternal: (url: string): Promise<void> => invoke("open_external", { url }),

    exportBytes: (suggestedName: string, bytes: Uint8Array, backup?: boolean): Promise<string> =>
      invoke("export_bytes", {
        suggestedName,
        bytes: Array.from(bytes),
        backup,
      }),
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

  onFolderChanged: (callback: (path: string) => void) =>
    listen("folder-changed", (e: any) => callback(e.payload)),

  onFolderWatchError: (callback: (event: { path: string; message: string }) => void) =>
    listen("folder-watch-error", (e: any) => callback(e.payload)),
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
  return item.width && item.height
    ? `${item.width.toLocaleString()} × ${item.height.toLocaleString()}`
    : "Unavailable";
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
