export type MediaKind = "photo" | "video" | "raw";

export interface MediaItem {
  id: string;
  path: string; // Native: absolute file path
  name: string;
  extension: string;
  kind: MediaKind;
  size: number;
  modifiedAt: number; // File mtime (ms)
  capturedAt?: number; // EXIF DateTimeOriginal (ms)
  width?: number;
  height?: number;
  camera?: string;
  lens?: string;
  exposure?: string;
  iso?: number;
  latitude?: number;
  longitude?: number;
  sha256?: string; // Content hash
  favorite: boolean;
  hidden: boolean;
  rating?: number; // 0-5 star rating, undefined = unrated
  colorLabel?: string; // 'red' | 'yellow' | 'green' | 'blue' | 'purple', undefined = unlabeled
  tags: string[];
  albumIds: string[]; // Album IDs this item belongs to
  duration?: number; // Video duration (seconds), hydrated client-side
  importSessionId?: string;
  createdAt: number; // When added to catalog
  updatedAt: number; // When metadata last changed
}

export interface Album {
  id: string;
  name: string;
  colorIndex: number; // 0-3 for dot colors
  itemCount: number;
  itemIds: string[]; // IDs of items in this album (populated by get_albums)
  createdAt: number;
  updatedAt: number;
}

export interface Tag {
  id: string;
  name: string;
  colorIndex: number;
  itemCount: number;
}

export interface ImportSession {
  id: string;
  rootPath: string;
  fileCount: number;
  startedAt: number;
  completedAt?: number;
  status: "scanning" | "importing" | "completed" | "failed";
}

export interface BatchExportRequest {
  items: {
    id: string;
    sourcePath: string;
    index: number;
    kind?: MediaKind;
    date?: number;
  }[];
  outputFolder: string;
  pattern: string;
  format: "jpeg" | "png" | "webp" | "heic" | "avif" | "source";
  quality: number;
  stripMetadata: boolean;
  maxDimension?: number;
}

export interface BatchExportResult {
  exported: number;
  failed: Array<{ itemId: string; error: string }>;
  outputs: string[];
  cancelled?: boolean;
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
  mediaId?: string;
  edits: EditValues;
  outputFormat: "jpeg" | "png" | "webp" | "heic" | "avif";
  quality: number;
  stripMetadata: boolean;
  crop?: CropRect;
}

export type Filter = "All" | "Photos" | "Videos" | "RAW" | "Favorites";
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

export interface DuplicateGroup {
  id: string;
  sha256: string;
  size: number;
  items: MediaItem[];
}

export interface EditRecipe {
  mediaId: string;
  edits: EditValues;
  crop?: CropState;
  history: EditValues[];
  historyIndex: number;
  createdAt: number;
  updatedAt: number;
}

export interface EditPreset {
  id: string;
  name: string;
  edits: EditValues;
  crop?: CropState;
  createdAt: number;
  updatedAt: number;
}

export interface CropState {
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  aspectRatio: number | "free";
}
