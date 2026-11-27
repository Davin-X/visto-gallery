import type React from "react";
import type { RefObject } from "react";
import type { ContextMenuItem } from "../../design/components/ContextMenu";
import type { LibraryState } from "../../engine/stores/useLibraryStore";
import type { DeleteItemsOutcome } from "../../engine/types/commands";
import type { Album, Filter, LayoutMode, MediaItem } from "../../engine/types/media";

export interface LibraryScreenProps {
  activeAlbum: string | null;
  albumDragOver?: boolean;
  albums: Album[];
  assetUrl: (path: string) => string;
  busy: boolean;
  filter: Filter;
  hasItems?: boolean;
  hiddenCount: number;
  hiddenView?: boolean;
  /**
   * Veil hidden thumbnails behind hold-to-reveal. On by default in the hidden
   * view; Hidden turns it off once Touch ID or the password unlocked it.
   */
  veilHidden?: boolean;
  /** Extra header control for the hidden view (Hidden's Lock button). */
  hiddenHeaderAction?: React.ReactNode;
  inspectedId: string | null;
  items: MediaItem[];
  layout: LayoutMode;
  onAddItems?: (albumId: string) => void;
  onAlbumMenu?: (e: React.MouseEvent) => void;
  onBrowseLibrary?: () => void;
  onChangeFilter: (filter: Filter) => void;
  onChangeLayout: (layout: LayoutMode) => void;
  onChangeQuery: (query: string) => void;
  onClearSelection: () => void;
  onContextMenu: (items: ContextMenuItem[], e: React.MouseEvent) => void;
  onCopyTagsToFinder?: (ids: string[]) => void | Promise<void>;
  onCreateAlbum: (itemIds?: string[]) => void;
  onImportFiles?: () => void;
  onImportFolder?: () => void;
  onImportCameraCard?: () => void;
  onInspectItem: (id: string) => void;
  onOpenAlbumPicker: (itemIds?: string[]) => void;
  onOpenAlbums: () => void;
  onOpenBatch?: (ids?: string[]) => void;
  onOpenEdit: (item: MediaItem) => void;
  onOpenViewer: (id?: string) => void;
  /** Start a background session for a video without leaving the grid. */
  onPlayBackground?: (id: string) => void;
  onPlaySlideshow: (ids?: string[]) => void;
  onRequestDeleteItems: (ids: string[]) => void;
  onRequestRemoveFromAlbum?: (albumId: string, itemIds: string[]) => void;
  onSelectRange: (startId: string, endId: string) => void;
  onSetActiveAlbum: (albumId: string | null) => void;
  onSetFavoriteForIds: (ids: string[], favorite: boolean) => void | Promise<void>;
  onSetHiddenForIds: (ids: string[], hidden: boolean) => void | Promise<void>;
  onSetSelection: (ids: string[]) => void;
  onSetRatingForIds: (ids: string[], rating: number) => void | Promise<void>;
  onSetColorLabelForIds: (ids: string[], colorLabel: string | null) => void | Promise<void>;
  onToggleFavorite: (id: string) => void | Promise<void>;
  onToggleHidden: (id: string) => void | Promise<void>;
  onToggleInspector: () => void;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onDeleteItems: (ids: string[]) => void | Promise<DeleteItemsOutcome>;
  onUpdateTags: (id: string, tags: string[]) => void | Promise<void>;
  query: string;
  minRating: number | null;
  libraryStats?: {
    photos: number;
    videos: number;
    raws: number;
    animations?: number;
    favorites: number;
  };
  colorLabelFilter: string | null;
  dateFrom: number | null;
  dateTo: number | null;
  onSetMinRating: (rating: number | null) => void;
  onSetColorLabelFilter: (colorLabel: string | null) => void;
  onSetDateRange: (from: number | null, to: number | null) => void;
  onCreateSmartAlbum?: (name: string) => void;
  notice: (text: string) => void;
  progress: LibraryState["progress"];
  searchInputRef: RefObject<HTMLInputElement | null>;
  selectedIds: string[];
  showInspector: boolean;
}
