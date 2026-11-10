export type {
  MediaKind,
  Album,
  Tag,
  BatchExportRequest,
  BatchExportItem,
  BatchExportResult,
  EditValues,
  CropRect,
  CropState,
  ExportResult,
  ExifData,
  RenderRequest,
  DuplicateGroup,
  EditRecipe,
  EditPreset,
} from "./generated/ipc";

import type { MediaItem as GeneratedMediaItem, MediaKind } from "./generated/ipc";

/**
 * Catalog item plus UI-only fields hydrated client-side. Everything else comes
 * from the generated IPC type, so the Rust DTO is the source of truth.
 */
export type MediaItem = GeneratedMediaItem & {
  /** Video duration in seconds, hydrated by the viewer. */
  duration?: number;
};

export interface ImportSession {
  id: string;
  rootPath: string;
  fileCount: number;
  startedAt: number;
  completedAt?: number;
  status: "scanning" | "importing" | "completed" | "failed";
}

export type Filter = "All" | "Photos" | "Videos" | "RAW" | "Animations" | "Favorites";
export type LayoutMode = "grid" | "filmstrip" | "overview" | "details" | "timeline";
export type Screen =
  | "Library"
  | "Viewer"
  | "Explore"
  | "CameraLens"
  | "Duplicates"
  | "Edit"
  | "Batch"
  | "Hidden"
  | "Slideshow"
  | "Settings";

export interface LibraryFilter {
  kind?: MediaKind;
  favorite?: boolean;
  hidden?: boolean;
  albumId?: string;
  query?: string;
  dateFrom?: number;
  dateTo?: number;
  rating?: number; // filter items at or above this star rating (0-5)
  colorLabel?: string; // 'red' | 'yellow' | 'green' | 'blue' | 'purple'
  camera?: string; // filter by camera model
  lens?: string; // filter by lens model
}
