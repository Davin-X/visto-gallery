import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  useDeferredValue,
  memo,
} from "react";
import HiddenScreen from "../screens/HiddenScreen";
import LibraryScreen from "../screens/LibraryScreen";
import { useFocusTrap } from "../design/hooks/useFocusTrap";
import EditScreen from "../screens/EditScreen";
import ViewerScreen from "../screens/ViewerScreen";
import VideoPlayer from "../design/components/VideoPlayer";
import BatchScreen from "../screens/BatchScreen";
import AlbumsScreen from "../screens/AlbumsScreen";
import { AlbumPhotoStack } from "../design/components/AlbumPhotoStack";
import VideoThumb from "../design/components/VideoThumb";
import DuplicatesScreen from "../screens/DuplicatesScreen";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { KindBadge, KindDot } from "../design/components/KindBadge";

import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { tauri, events } from "../engine/commands/tauri";
import {
  useLibraryStore,
  useViewerStore,
  useEditStore,
  useSlideshowStore,
  useBatchStore,
  useSettingsStore,
  useSystemDark,
  useThumbnailSize,
  applyTheme,
  useDraftTransforms,
  useDraftIds,
  draftTransformStyle,
  clearEditDraft,
  type DraftTransform,
  usePlaybackStore,
} from "../engine/stores";
import { formatDuration } from "../engine/utils/time";
import { MiniPlayer } from "../design/components/MiniPlayer";
import { getTypeIdentity, formatBytesSimple } from "../engine/utils/mediaTypes";

// Helper: render a kind badge using centralized type identity

// Helper: get icon for kind
function KindIcon({
  kind,
  size = 14,
}: {
  kind: "photo" | "video" | "raw";
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
  };
  if (kind === "photo") {
    return (
      <span>
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <path d="M6 2v12M10 2v12M2 6h12M2 10h12" />
        </svg>
      </span>
    );
  }
  return (
    <span>
      <svg {...common}>
        <path d="M4 4h8v8H4z" />
        <path d="M4 8h8" />
      </svg>
    </span>
  );
}

/**
 * Apply the item's saved edit draft to a preview image. Passing the shared map
 * keeps this synchronous and avoids a localStorage read per tile.
 */
function draftImageStyle(
  transforms: Map<string, DraftTransform> | undefined,
  itemId: string,
) {
  const transform = draftTransformStyle(transforms?.get(itemId));
  return transform ? { transform } : undefined;
}

function startConfiguredSlideshow(items: MediaItem[], startId?: string | null) {
  const preferences = useSettingsStore.getState();
  const slideshow = useSlideshowStore.getState();
  slideshow.setInterval(preferences.slideshowInterval);
  slideshow.setShuffle(preferences.slideshowShuffle);
  slideshow.setLoop(preferences.slideshowLoop);
  slideshow.open(items, startId);
}
import type {
  MediaItem,
  MediaKind,
  DuplicateGroup,
  Album,
  Filter,
  LayoutMode,
  EditValues,
  CropRect,
} from "../engine/types/media";
import type { LibraryFolder } from "../engine/types/commands";
import { SettingsScreen } from "../design/components/SettingsScreen";
import { SourcesManager } from "../design/components/SourcesManager";
import { SlideshowOverlay } from "../design/components/SlideshowOverlay";
import { ContextMenu } from "../design/components/ContextMenu";
import { BrandMark } from "../design/components/BrandMark";
import {
  GearIcon,
  SunIcon,
  MoonIcon,
  LibraryIcon,
  AlbumsIcon,
  ViewerIcon,
  DuplicatesIcon,
  EditIcon,
  BatchIcon,
  SearchIcon,
  PlusIcon,
  MinusIcon,
  MoreIcon,
  InspectorIcon,
  FolderIcon,
  GridIcon,
  OverviewIcon,
  DetailsIcon,
  TimelineIcon,
  HeartIcon,
  EyeIcon,
  EyeOffIcon,
  FullscreenIcon,
  RotateIcon,
  CropIcon,
  FlipIcon,
  PlayIcon,
  PauseIcon,
  SparkleIcon,
  UsersIcon,
  TagIcon,
  ImageOffIcon,
  ShareIcon,
  CheckIcon,
  StopIcon,
  TrashIcon,
  VolumeIcon,
} from "../design/components/icons";

type Screen =
  | "Library"
  | "Albums"
  | "Viewer"
  | "Duplicates"
  | "Edit"
  | "Batch"
  | "Hidden"
  | "Settings";

const initialEdits = {
  exposure: 0,
  contrast: 0,
  warmth: 0,
  shadows: 0,
  highlights: 0,
  saturation: 0,
  rotation: 0,
  flip: false,
};

const MEDIA_EXTENSIONS = [
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "jfif",
  "jpe",
  "jpeg",
  "jpg",
  "jxl",
  "png",
  "tif",
  "tiff",
  "webp",
  "3fr",
  "ari",
  "arw",
  "bay",
  "cap",
  "cr2",
  "cr3",
  "dcs",
  "dcr",
  "dng",
  "drf",
  "eip",
  "erf",
  "fff",
  "gpr",
  "iiq",
  "k25",
  "kdc",
  "mdc",
  "mef",
  "mos",
  "mrw",
  "nef",
  "nrw",
  "obm",
  "orf",
  "pef",
  "ptx",
  "pxn",
  "r3d",
  "raf",
  "raw",
  "rw2",
  "rwl",
  "sr2",
  "srf",
  "srw",
  "x3f",
  "m4v",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "webm",
];

/** Tauri rejects with a plain string, but anything else can surface too. */
function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isWarningNotice(text: string): boolean {
  return /failed|could not|cannot access|not a folder|could not read|no media files found|no supported media/i.test(
    text,
  );
}

/** Modifier glyph for the "focus search" hint - Command on macOS, Ctrl elsewhere. */
function searchShortcutLabel(): string {
  if (typeof navigator === "undefined") return "⌘F";
  // `userAgentData` is not in the default TS lib yet, so read it defensively.
  const uaData = (
    navigator as unknown as { userAgentData?: { platform?: string } }
  ).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘F" : "Ctrl F";
}

function App() {
  const [screen, setScreen] = useState<Screen>("Library");
  const [screenHistory, setScreenHistory] = useState<Screen[]>([]);

  const goBack = () => {
    setScreenHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setScreen(last);
      return prev.slice(0, -1);
    });
  };
  // Context menu state (declared here because the component references it in
  // JSX but it was previously an implicit global, which left the render blank).
  const [contextMenu, setContextMenu] = useState<{
    items: any[];
    x: number;
    y: number;
  } | null>(null);
  const systemDark = useSystemDark();
  const appearance = useSettingsStore((s) => s.appearance);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  // Resolved appearance: the user's choice, or the OS setting when "system".
  const dark = appearance === "dark" || (appearance === "system" && systemDark);
  const [albumDialogOpen, setAlbumDialogOpen] = useState(false);
  const [albumDialogMode, setAlbumDialogMode] = useState<"create" | "rename">(
    "create",
  );
  const [albumName, setAlbumName] = useState("");
  const [albumSeedIds, setAlbumSeedIds] = useState<string[] | null>(null);
  const [renamingAlbumId, setRenamingAlbumId] = useState<string | null>(null);
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const albumInputRef = useRef<HTMLInputElement | null>(null);
  const albumDialogRef = useRef<HTMLFormElement | null>(null);
  const deleteAlbumDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteItemDialogRef = useRef<HTMLDivElement | null>(null);
  const removeFolderDialogRef = useRef<HTMLDivElement | null>(null);

  const [albumPendingDelete, setAlbumPendingDelete] = useState<any | null>(
    null,
  );
  const [itemPendingDeleteCount, setItemPendingDeleteCount] =
    useState<number>(0);
  const itemPendingDeleteRef = useRef<string[] | null>(null);
  const folderChangedTimerRef = useRef<number | null>(null);
  const [albumRemovePending, setAlbumRemovePending] = useState<{
    albumId: string;
    itemIds: string[];
  } | null>(null);
  const [deletingAlbum, setDeletingAlbum] = useState(false);

  // Removing a folder is confirmed through its own dialog so a stray click in
  // the sidebar can never drop a chunk of the library.
  const [folderPendingRemove, setFolderPendingRemove] =
    useState<LibraryFolder | null>(null);
  const [removingFolder, setRemovingFolder] = useState(false);
  const [sourcesSheetOpen, setSourcesSheetOpen] = useState(false);
  useFocusTrap(albumDialogOpen, albumDialogRef);
  useFocusTrap(!!albumPendingDelete, deleteAlbumDialogRef);
  useFocusTrap(itemPendingDeleteCount > 0, deleteItemDialogRef);
  useFocusTrap(!!folderPendingRemove, removeFolderDialogRef);

  const rescanInProgress = useRef(false);
  // Where the viewer returns when it closes. Opening the viewer from Hidden
  // keeps the user in Hidden; the Library viewer returns to Library.
  const [viewerOrigin, setViewerOrigin] = useState<Screen>("Library");

  const [albumPickerOpen, setAlbumPickerOpen] = useState(false);
  const [albumPickerItemIds, setAlbumPickerItemIds] = useState<string[]>([]);
  const [albumSearch, setAlbumSearch] = useState("");
  const [addingToAlbumId, setAddingToAlbumId] = useState<string | null>(null);
  const albumSearchRef = useRef<HTMLInputElement | null>(null);
  const [albumDragOver, setAlbumDragOver] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);
  useEffect(() => {
    if (!aboutOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAboutOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aboutOpen]);
  useEffect(() => {
    let cancelled = false;
    tauri.app
      .getVersion()
      .then((v) => {
        if (!cancelled) setAppVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const importPathsIntoAlbumRef = useRef<
    (paths: string[], albumId: string) => Promise<void>
  >(async () => {});

  // Opening our own menu has to cancel the event, otherwise the webview shows
  // its default menu (Reload / Copy / Open in new tab) on top of it.
  const openContextMenu = useCallback((items: any[], e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ items, x: e.clientX, y: e.clientY });
  }, []);

  // Suppress the webview's default menu everywhere else too, so the app never
  // exposes browser chrome. Editable fields keep it, for Paste / Select All.
  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const editable =
        el.isContentEditable ||
        ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") &&
          !el.hasAttribute("disabled"));
      if (!editable) e.preventDefault();
    };
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);

  const library = useLibraryStore();
  const settingsHydrated = useSettingsStore((s) => s._hydrated);
  const defaultLayout = useSettingsStore((s) => s.defaultLayout);

  // Apply the saved library layout once settings are ready, and whenever the
  // user returns to the whole library. Avoid changing the current view while
  // they are actively browsing it.
  useEffect(() => {
    if (settingsHydrated && screen === "Library" && !library.activeAlbum) {
      library.setLayout(defaultLayout);
    }
  }, [
    settingsHydrated,
    screen,
    defaultLayout,
    library.activeAlbum,
    library.setLayout,
  ]);

  // Sidebar summary in one pass. The rows used to run a filter + reduce over
  // the whole library each, i.e. a dozen scans per render, which is costly at
  // 10k+ items and made every unrelated state change feel slow.
  const libraryStats = useMemo(() => {
    const stats = {
      photos: 0,
      videos: 0,
      raws: 0,
      favorites: 0,
      hidden: 0,
      photoSize: 0,
      videoSize: 0,
      rawSize: 0,
      favoriteSize: 0,
      hiddenSize: 0,
      totalSize: 0,
    };
    for (const item of library.items) {
      // Hidden items are a separate collection. Keeping them out of the
      // Photos/Videos/RAW/Favorites rows means the sidebar numbers match the
      // grid the user is actually looking at.
      if (item.hidden) {
        stats.hidden += 1;
        stats.hiddenSize += item.size;
        continue;
      }
      stats.totalSize += item.size;
      if (item.favorite) {
        stats.favorites += 1;
        stats.favoriteSize += item.size;
      }
      if (item.kind === "photo") {
        stats.photos += 1;
        stats.photoSize += item.size;
      } else if (item.kind === "video") {
        stats.videos += 1;
        stats.videoSize += item.size;
      } else if (item.kind === "raw") {
        stats.raws += 1;
        stats.rawSize += item.size;
      }
    }
    return stats;
  }, [library.items]);

  const viewer = useViewerStore();
  const edit = useEditStore();
  const batch = useBatchStore();
  const settings = useSettingsStore();

  // A video keeps playing when the user switches tabs. To do that the viewer
  // must stay mounted (off-screen) and keep showing the item it was playing,
  // even if the library inspection moves to another photo in the meantime.
  const [frozenViewerItem, setFrozenViewerItem] = useState<MediaItem | null>(
    null,
  );
  const lastViewerItemRef = useRef<MediaItem | null>(null);
  const viewerHostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (screen === "Viewer") lastViewerItemRef.current = library.viewerSelected;
  }, [screen, library.viewerSelected]);

  // Only videos are allowed to outlive the Viewer screen. Photos (and a viewer
  // with nothing playing) close on navigation exactly as before.
  useEffect(() => {
    if (screen === "Viewer") {
      setFrozenViewerItem(null);
      return;
    }
    if (!viewer.isOpen) {
      setFrozenViewerItem(null);
      return;
    }
    const last = lastViewerItemRef.current;
    if (last?.kind === "video") {
      setFrozenViewerItem(last);
    } else {
      viewer.close();
      setFrozenViewerItem(null);
    }
  }, [screen, viewer.isOpen, viewer.close]);

  // The hidden player must not be reachable with Tab or a screen reader.
  useEffect(() => {
    const host = viewerHostRef.current;
    if (host)
      (host as HTMLElement & { inert: boolean }).inert = screen !== "Viewer";
  }, [screen, viewer.isOpen]);

  // Ensure screen state matches viewer state on mount/hydration.
  useEffect(() => {
    if (screen === "Viewer" && !viewer.isOpen) viewer.open();
  }, [screen, viewer.isOpen, viewer.open]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // The library search input lives in LibraryScreen, but the Cmd+F shortcut
  // is owned here. Sharing the node through a ref keeps the shortcut working
  // without depending on the DOM shape (a class-name query would break the
  // moment the field is restructured).
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // The topbar is our own drag region. Drag after a few pixels of movement
  // (not on mousedown) so a double-click is not mistaken for a drag, then use
  // double-click to toggle fill / centered small window. preventDefault keeps
  // the status text from being selected by the first click.
  const dragCandidateRef = useRef<{
    x: number;
    y: number;
    dragging: boolean;
  } | null>(null);
  const preFillSizeRef = useRef<{ width: number; height: number } | null>(null);

  const beginTopbarDrag = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        "button, a, input, select, textarea, [role='button'], [data-no-drag]",
      )
    )
      return;
    e.preventDefault();
    if (e.detail > 1) return;
    dragCandidateRef.current = { x: e.clientX, y: e.clientY, dragging: false };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragCandidateRef.current;
      if (!drag || drag.dragging) return;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      drag.dragging = true;
      getCurrentWindow()
        .startDragging()
        .catch(() => {});
    };
    const clear = () => {
      dragCandidateRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // First double-click fills the monitor's work area (fully on-screen).
  // The next one restores the saved inner size and centers it.
  const handleTopbarDoubleClick = useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, select, textarea, [role='button']"))
      return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const win = getCurrentWindow();
      const monitor = await currentMonitor();
      if (!monitor) return;
      const work = monitor.workArea ?? {
        position: monitor.position,
        size: monitor.size,
      };
      const scale = monitor.scaleFactor || 1;
      const workWidth = work.size.width / scale;
      const workHeight = work.size.height / scale;
      const outer = await win.outerSize();
      const filled =
        outer.width >= work.size.width - 8 &&
        outer.height >= work.size.height - 8;

      if (filled) {
        const saved = preFillSizeRef.current;
        const width =
          saved?.width && saved.width < workWidth - 40
            ? saved.width
            : Math.min(1280, workWidth - 80);
        const height =
          saved?.height && saved.height < workHeight - 40
            ? saved.height
            : Math.min(852, workHeight - 80);
        await win.setSize(new LogicalSize(width, height));
        await win.center();
        preFillSizeRef.current = null;
      } else {
        const inner = await win.innerSize();
        const outerBefore = await win.outerSize();
        const chromeHeight = Math.max(
          0,
          (outerBefore.height - inner.height) / scale,
        );
        preFillSizeRef.current = {
          width: inner.width / scale,
          height: inner.height / scale,
        };
        await win.setPosition(
          new PhysicalPosition(work.position.x, work.position.y),
        );
        await win.setSize(
          new LogicalSize(
            Math.max(1, workWidth - 2),
            Math.max(1, workHeight - chromeHeight - 2),
          ),
        );
      }
    } catch {
      // Ignore: the browser preview has no Tauri window to resize.
    }
  }, []);

  // The system Fill can leave part of the window off-screen, and the restore
  // returns to the old frame instead of centering. Watch the native window and
  // correct both, without intercepting the titlebar gesture itself.
  useEffect(() => {
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let adjusting = false;
    let wasFilled = false;
    const unlisteners: Array<() => void> = [];

    const adjust = async () => {
      if (disposed || adjusting) return;
      try {
        const monitor = await currentMonitor();
        if (!monitor) return;
        const work = monitor.workArea ?? {
          position: monitor.position,
          size: monitor.size,
        };
        const outer = await win.outerSize();
        const pos = await win.outerPosition();
        const filled =
          outer.width >= work.size.width - 8 &&
          outer.height >= work.size.height - 8;

        if (filled) {
          wasFilled = true;
          const maxX = Math.max(
            work.position.x,
            work.position.x + work.size.width - outer.width,
          );
          const maxY = Math.max(
            work.position.y,
            work.position.y + work.size.height - outer.height,
          );
          const x = Math.min(Math.max(pos.x, work.position.x), maxX);
          const y = Math.min(Math.max(pos.y, work.position.y), maxY);
          if (x !== pos.x || y !== pos.y) {
            adjusting = true;
            await win.setPosition(new PhysicalPosition(x, y)).catch(() => {});
            adjusting = false;
          }
        } else if (wasFilled) {
          wasFilled = false;
          adjusting = true;
          await win.center().catch(() => {});
          adjusting = false;
        }
      } catch {
        // Ignore: the browser preview has no Tauri window to query.
      }
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void adjust();
      }, 140);
    };

    win
      .onResized(schedule)
      .then((un) => (disposed ? un() : unlisteners.push(un)))
      .catch(() => {});
    win
      .onMoved(schedule)
      .then((un) => (disposed ? un() : unlisteners.push(un)))
      .catch(() => {});

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisteners.forEach((un) => un());
    };
  }, []);

  // Convert local file path to Tauri asset URL
  const assetUrl = useCallback((path: string) => {
    if (!path) return "";
    if (
      path.startsWith("blob:") ||
      path.startsWith("data:") ||
      path.startsWith("http")
    )
      return path;
    try {
      return convertFileSrc(path);
    } catch {
      return path;
    }
  }, []);

  // Latest render values, so long-lived event handlers never read stale stores.
  const liveRef = useRef({
    library,
    viewer,
    edit,
    settings,
    screen,
    viewerOrigin,
    albumDialogOpen,
    albumPickerOpen,
    albumPendingDelete,
    itemPendingDeleteCount,
    folderPendingRemove,
    sourcesSheetOpen,
  });
  liveRef.current = {
    library,
    viewer,
    edit,
    settings,
    screen,
    viewerOrigin,
    albumDialogOpen,
    albumPickerOpen,
    albumPendingDelete,
    itemPendingDeleteCount,
    folderPendingRemove,
    sourcesSheetOpen,
  };

  // Handlers are declared further down; stable listeners reach them through a ref.
  const handlersRef = useRef<{
    importFolder: () => void;
    importFiles: () => void;
    showNotice: (text: string) => void;
  }>({ importFolder: () => {}, importFiles: () => {}, showNotice: () => {} });

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");

    // Opening the saved catalog is cheap; source scans are always user-started.
    liveRef.current.library.loadLibrary();
    liveRef.current.settings.hydrate();

    // Listen for native menu events (cleaned up on unmount / StrictMode remount).
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const listen = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const register = async (event: string, handler: () => void) => {
        const unlisten = await listen(event, handler);
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      };
      await register("menu-open-folder", () =>
        handlersRef.current.importFolder(),
      );
      await register("menu-import-files", () =>
        handlersRef.current.importFiles(),
      );
      await register("menu-export", () =>
        handlersRef.current.showNotice("Export - coming soon"),
      );
      await register("menu-toggle-sidebar", () =>
        liveRef.current.library.toggleSidebar(),
      );
      await register("menu-toggle-inspector", () =>
        liveRef.current.library.toggleInspector(),
      );
      await register("menu-zoom-in", () => liveRef.current.viewer.zoomIn());
      await register("menu-zoom-out", () => liveRef.current.viewer.zoomOut());
      await register("menu-about", () => setAboutOpen(true));
      await register("menu-check-updates", () =>
        handlersRef.current.showNotice("Check for updates - coming soon"),
      );

      // Listen for native import progress events from scan/import commands.
      const unlistenProgress = await events.onImportProgress((progress) => {
        const { phase, processed, total } = progress;
        liveRef.current.library.setBusy(true);
        liveRef.current.library.setProgress({
          phase,
          processed,
          total,
          bytesProcessed: progress.bytesProcessed,
          bytesTotal: progress.bytesTotal,
          filesProcessed: progress.filesProcessed,
          filesTotal: progress.filesTotal,
          currentFile: progress.currentFile,
        });
        // Hashing still has a short database/grouping step after the final
        // progress event; keep its controls disabled until the command returns.
        if (processed >= total && total > 0 && phase !== "hashing") {
          liveRef.current.library.setBusy(false);
          liveRef.current.library.setProgress(null);
        }
      });
      const unlistenFolderChanged = await events.onFolderChanged((path) => {
        // Debounce rapid filesystem events into a single catalog refresh.
        if (folderChangedTimerRef.current)
          window.clearTimeout(folderChangedTimerRef.current);
        folderChangedTimerRef.current = window.setTimeout(() => {
          liveRef.current.library.loadLibrary().catch(() => {});
        }, 500);
      });
      unlisteners.push(unlistenFolderChanged);
    };
    listen();

    // Keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      const {
        library,
        viewer,
        screen,
        viewerOrigin,
        albumDialogOpen,
        albumPickerOpen,
        albumPendingDelete,
        itemPendingDeleteCount,
        folderPendingRemove,
        sourcesSheetOpen,
      } = liveRef.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // A slideshow owns the keyboard while it is open: its overlay handles
      // Escape/arrows/Space itself, and nothing underneath should react.
      if (useSlideshowStore.getState().isOpen) return;

      // While a modal is open, every key belongs to it (the dialogs own Enter
      // and Escape) instead of the global shortcut map.
      if (
        albumDialogOpen ||
        albumPickerOpen ||
        albumPendingDelete ||
        itemPendingDeleteCount > 0 ||
        folderPendingRemove ||
        sourcesSheetOpen
      )
        return;

      if (mod && key === "o") {
        e.preventDefault();
        handlersRef.current.importFolder();
        return;
      }
      if (mod && key === "i") {
        e.preventDefault();
        handlersRef.current.importFiles();
        return;
      }
      if (mod && key === "e") {
        e.preventDefault();
        handlersRef.current.showNotice("Export - coming soon");
        return;
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        library.toggleSidebar();
        return;
      }
      if (mod && e.altKey && key === "i") {
        e.preventDefault();
        library.toggleInspector();
        return;
      }
      if (mod && key === "a") {
        const target = e.target as HTMLElement;
        const isEditable =
          target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT";
        if (
          !isEditable &&
          (screen === "Library" || screen === "Hidden" || screen === "Albums")
        ) {
          e.preventDefault();
          const items =
            screen === "Hidden" ? library.hiddenItems : library.visibleItems;
          const selectedSet = new Set(library.selectedIds);
          const allSelected =
            items.length > 0 &&
            items.every((item: any) => selectedSet.has(item.id));
          library.setSelectedIds(
            allSelected ? [] : items.map((item: any) => item.id),
          );
          return;
        }
      }
      if (mod && key === "f") {
        const target = e.target as HTMLElement;
        const isEditable =
          target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT";
        if (!isEditable) {
          e.preventDefault();
          const focusSearch = () => {
            const input =
              searchInputRef.current ||
              (document.querySelector(
                ".search-field input",
              ) as HTMLInputElement | null);
            input?.focus();
            input?.select();
          };
          // Both the Library and Hidden screens own a search field. Jump to
          // Library only when neither is on screen, then focus once mounted.
          if (screen !== "Library" && screen !== "Hidden") {
            setScreen("Library");
            let attempts = 0;
            const tryFocus = () => {
              const input =
                searchInputRef.current ||
                (document.querySelector(
                  ".search-field input",
                ) as HTMLInputElement | null);
              if (input) {
                input.focus();
                input.select();
                return;
              }
              if (attempts++ < 10) requestAnimationFrame(tryFocus);
            };
            requestAnimationFrame(tryFocus);
          } else {
            focusSearch();
          }
        }
        return;
      }
      if (screen === "Viewer" && !e.defaultPrevented) {
        const target = e.target as HTMLElement;
        const isEditable =
          target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT";
        if (!isEditable && e.key === "ArrowRight") viewer.navigate(1);
        if (!isEditable && e.key === "ArrowLeft") viewer.navigate(-1);
      }
      if (e.key === "Escape") {
        if (screen === "Viewer") {
          viewer.close();
          setScreen(viewerOrigin || "Library");
        } else if (library.showInspector) {
          library.toggleInspector();
        }
      }
      if (
        e.key === "Enter" &&
        mod &&
        screen === "Hidden" &&
        library.inspectedId
      ) {
        // HiddenScreen owns the reveal confirmation, so route the shortcut
        // through it instead of opening the viewer directly.
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("mac-gallery:open-hidden", {
            detail: { id: library.inspectedId },
          }),
        );
        return;
      }
      if (
        e.key === "Enter" &&
        mod &&
        screen === "Library" &&
        library.inspectedId
      ) {
        setViewerOrigin("Library");
        library.setViewerScope("library");
        viewer.open();
        setScreen("Viewer");
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", handleKeyDown);
      unlisteners.forEach((un) => un());
    };
    // Mount-only. Handlers read fresh state through liveRef / handlersRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pull the authoritative settings from SQLite once at startup so the app
  // chrome (appearance, accent, sidebar width) is correct even if the user
  // never opens Settings.
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);

  // Keep the in-app theme and the native window chrome (traffic lights /
  // window background) in sync with the resolved appearance. This lives here
  // (always mounted) rather than in Settings so closing Settings never leaves
  // the app frame on a stale theme.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (cancelled) return;
        applyTheme({ appearance, accentColor });
        await getCurrentWindow().setTheme(dark ? "dark" : "light");
      } catch {
        /* browser preview - no native window */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dark, appearance, accentColor, systemDark]);

  const showNotice = useCallback(
    (text: string) => {
      library.showNotice(text);
    },
    [library],
  );

  // Single entry point for "open this item in the player". Used by tiles, the
  // inspector and by Play on a video-only selection.
  const openViewer = useCallback(
    (
      id?: string,
      origin: Screen = "Library",
      scope: "library" | "hidden" = "library",
    ) => {
      setViewerOrigin(origin);
      library.setViewerScope(scope);
      viewer.open(id);
      setScreen("Viewer");
    },
    [library, viewer],
  );

  // Slideshow is a mode over the current context, not a separate screen:
  // play the selection when there is one, otherwise the collection on screen
  // (album, folder, filter or search results).
  const playSlideshow = useCallback(
    (ids?: string[]) => {
      const selection = ids && ids.length ? new Set(ids) : null;
      // A selection is authoritative: play every selected item, even one the
      // current filter/album is not showing. Ordering follows the grid for the
      // items on screen, then appends the rest so nothing selected is dropped.
      const visibleSelection = selection
        ? library.visibleItems.filter((item: MediaItem) =>
            selection.has(item.id),
          )
        : [];
      const visibleSelectionIds = new Set(
        visibleSelection.map((item) => item.id),
      );
      const offscreenSelection = selection
        ? library.items.filter(
            (item: MediaItem) =>
              selection.has(item.id) && !visibleSelectionIds.has(item.id),
          )
        : [];
      const scope = selection
        ? [...visibleSelection, ...offscreenSelection]
        : library.visibleItems;
      if (scope.length === 0) {
        showNotice("Add photos or videos to start a slideshow.");
        return;
      }
      // A video-only selection belongs in the player: seeking, volume and
      // auto-advance are what people expect from a video, while a slideshow is
      // built for sequencing photos. Mixed selections still use the slideshow,
      // because it is the only mode that can play both kinds.
      if (selection && scope.every((item) => item.kind === "video")) {
        const slideshow = useSlideshowStore.getState();
        slideshow.setShuffle(false);
        startConfiguredSlideshow(scope, null);
        return;
      }
      // Close any open viewer so its media can't keep playing underneath the show.
      if (viewer.isOpen) {
        viewer.close();
        setScreen(viewerOrigin || "Library");
      }
      // Pause any other playing videos (e.g. inspector preview) to avoid parallel audio.
      document.querySelectorAll("video").forEach((v) => {
        try {
          v.pause();
        } catch {}
      });
      // Read the action off the store instead of subscribing to it: advancing
      // slides should only re-render the overlay, never the whole app.
      // An explicit selection starts at its first item; only the no-selection
      // case resumes from whatever was last inspected, so a video that was
      // playing in the background cannot hijack the start of a new selection.
      if (selection) useSlideshowStore.getState().setShuffle(false);
      startConfiguredSlideshow(scope, selection ? null : library.inspectedId);
    },
    [
      library.items,
      library.visibleItems,
      library.inspectedId,
      showNotice,
      viewer,
      viewerOrigin,
      openViewer,
    ],
  );

  const openAlbumDialog = useCallback((seedIds?: string[]) => {
    setAlbumDialogMode("create");
    setRenamingAlbumId(null);
    setAlbumSeedIds(seedIds && seedIds.length ? seedIds : null);
    setAlbumName("");
    setAlbumDialogOpen(true);
  }, []);

  const openRenameAlbumDialog = useCallback((album: any) => {
    setAlbumDialogMode("rename");
    setRenamingAlbumId(album.id);
    setAlbumSeedIds(null);
    setAlbumName(album.name);
    setAlbumDialogOpen(true);
  }, []);

  const closeAlbumDialog = useCallback(() => {
    if (creatingAlbum) return;
    setAlbumDialogOpen(false);
    setAlbumName("");
    setAlbumSeedIds(null);
    setRenamingAlbumId(null);
    setAlbumDialogMode("create");
  }, [creatingAlbum]);

  // Focus the name field as soon as the dialog mounts, and keep Escape working
  // even if focus somehow leaves the form.
  useEffect(() => {
    if (!albumDialogOpen) return;
    const frame = requestAnimationFrame(() => {
      albumInputRef.current?.focus();
      albumInputRef.current?.select();
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeAlbumDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [albumDialogOpen, closeAlbumDialog]);

  const submitAlbum = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = albumName.trim();
    if (!name || creatingAlbum) return;
    setCreatingAlbum(true);
    try {
      if (albumDialogMode === "rename" && renamingAlbumId) {
        await library.renameAlbum(renamingAlbumId, name);
        showNotice(`Renamed album to "${name}"`);
      } else {
        const seedIds = albumSeedIds ?? undefined;
        // The store updates the album list and posts the success notice.
        await library.createAlbum(name, seedIds);
      }
      setAlbumDialogOpen(false);
      setAlbumName("");
      setAlbumSeedIds(null);
      setRenamingAlbumId(null);
      setAlbumDialogMode("create");
    } catch (error) {
      showNotice(
        `Could not ${albumDialogMode === "rename" ? "rename" : "create"} album: ${describeError(error)}`,
      );
    } finally {
      setCreatingAlbum(false);
    }
  };

  const openAlbumPicker = useCallback(
    (itemIds?: string[]) => {
      const ids = (
        itemIds && itemIds.length ? itemIds : library.selectedIds
      ).filter(Boolean);
      if (!ids.length) {
        showNotice("Select photos first, then add them to an album.");
        return;
      }
      setAlbumPickerItemIds(ids);
      setAlbumSearch("");
      setAlbumPickerOpen(true);
    },
    [library.selectedIds, showNotice],
  );

  useEffect(() => {
    if (!albumPickerOpen) return;
    const frame = requestAnimationFrame(() => albumSearchRef.current?.focus());
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setAlbumPickerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [albumPickerOpen]);

  const addPickedItemsToAlbum = async (album: any) => {
    if (!albumPickerItemIds.length || addingToAlbumId) return;
    setAddingToAlbumId(album.id);
    try {
      await library.addToAlbum(album.id, albumPickerItemIds);
      setAlbumPickerOpen(false);
    } catch (error) {
      showNotice(`Could not add to album: ${describeError(error)}`);
    } finally {
      setAddingToAlbumId(null);
    }
  };

  const createAlbumFromPicker = () => {
    const seedIds = albumPickerItemIds;
    setAlbumPickerOpen(false);
    openAlbumDialog(seedIds);
  };

  const confirmRemoveFromAlbum = async () => {
    if (!albumRemovePending) return;
    try {
      await library.removeFromAlbum(
        albumRemovePending.albumId,
        albumRemovePending.itemIds,
      );
      showNotice(
        `Removed ${albumRemovePending.itemIds.length} item${albumRemovePending.itemIds.length === 1 ? "" : "s"} from album.`,
      );
      setAlbumRemovePending(null);
    } catch (error) {
      showNotice(`Could not remove: ${describeError(error)}`);
    }
  };
  const confirmDeleteItem = () => {
    if (itemPendingDeleteCount === 0 || !itemPendingDeleteRef.current) return;
    const ids = itemPendingDeleteRef.current;
    // Close dialog immediately
    setItemPendingDeleteCount(0);
    itemPendingDeleteRef.current = null;
    // Run delete in background
    void (async () => {
      try {
        await library.deleteItems(ids);
        showNotice(
          `Moved ${ids.length.toLocaleString()} item${ids.length === 1 ? "" : "s"} to Trash.`,
        );
      } catch (error) {
        const msg = String(error);
        if (msg !== "Cancelled") {
          showNotice(`Could not delete: ${describeError(error)}`);
        }
      }
    })();
  };

  useEffect(() => {
    if (itemPendingDeleteCount === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setItemPendingDeleteCount(0);
      itemPendingDeleteRef.current = null;
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [itemPendingDeleteCount]);
  const confirmDeleteAlbum = async () => {
    if (!albumPendingDelete || deletingAlbum) return;
    const wasActiveAlbum = library.activeAlbum === albumPendingDelete.id;
    setDeletingAlbum(true);
    try {
      await library.deleteAlbum(albumPendingDelete.id);
      if (wasActiveAlbum) setScreen("Albums");
      showNotice(
        `Deleted album "${albumPendingDelete.name}". Your photos remain in the library.`,
      );
      setAlbumPendingDelete(null);
    } catch (error) {
      showNotice(`Could not delete album: ${describeError(error)}`);
    } finally {
      setDeletingAlbum(false);
    }
  };

  useEffect(() => {
    if (!albumPendingDelete) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (!deletingAlbum) setAlbumPendingDelete(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [albumPendingDelete, deletingAlbum]);

  const confirmRemoveFolder = async () => {
    if (!folderPendingRemove || removingFolder) return;
    setRemovingFolder(true);
    try {
      const removed = await library.removeFolder(folderPendingRemove.path);
      showNotice(
        removed > 0
          ? `Removed “${folderPendingRemove.name}” from VistoGallery. ${removed.toLocaleString()} item${removed === 1 ? "" : "s"} dropped from the library — your files are still on disk.`
          : `Removed empty folder “${folderPendingRemove.name}” from VistoGallery.`,
      );
      setFolderPendingRemove(null);
    } catch (error) {
      showNotice(`Could not remove folder: ${describeError(error)}`);
    } finally {
      setRemovingFolder(false);
    }
  };

  useEffect(() => {
    if (!folderPendingRemove) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (!removingFolder) setFolderPendingRemove(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [folderPendingRemove, removingFolder]);

  // The sources sheet owns Escape unless the remove-confirmation is stacked on
  // top of it (that dialog has its own handler above).
  useEffect(() => {
    if (!sourcesSheetOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || folderPendingRemove) return;
      e.preventDefault();
      setSourcesSheetOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sourcesSheetOpen, folderPendingRemove]);

  const importPathsIntoAlbum = async (paths: string[], albumId: string) => {
    const album = library.albums.find((a: any) => a.id === albumId);
    if (!album) {
      showNotice("That album no longer exists.");
      return;
    }
    if (!paths.length) return;

    try {
      showNotice(
        `Importing ${paths.length.toLocaleString()} file(s) into "${album.name}"…`,
      );
      library.setBusy(true);
      library.setProgress({
        phase: "importing",
        processed: 0,
        total: paths.length,
      });
      const result = await tauri.library.importFiles(paths);
      if (result.cancelled) {
        if (result.items.length)
          await tauri.albums.addItems(
            albumId,
            result.items.map((item: any) => item.id),
          );
        await library.loadLibrary();
        library.setActiveAlbum(albumId);
        library.setBusy(false);
        library.setProgress(null);
        showNotice(
          `Import cancelled. Kept ${result.items.length.toLocaleString()} item(s) already imported.`,
        );
        return;
      }
      if (!result.items.length) {
        library.setBusy(false);
        library.setProgress(null);
        showNotice("No supported media files selected.");
        return;
      }
      await tauri.albums.addItems(
        albumId,
        result.items.map((item: any) => item.id),
      );
      await library.loadLibrary();
      library.setActiveAlbum(albumId);
      library.setBusy(false);
      library.setProgress(null);
      library.setFilter("All");
      setScreen("Library");
      showNotice(
        `Added ${result.items.length.toLocaleString()} ${result.items.length === 1 ? "item" : "items"} to "${album.name}".`,
      );
    } catch (error) {
      library.setBusy(false);
      library.setProgress(null);
      showNotice(`Could not add items to the album: ${describeError(error)}`);
    }
  };

  const addItemsToAlbum = async (albumId: string) => {
    let paths: string[];
    try {
      const selected = await openFileDialog({
        directory: false,
        multiple: true,
        filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }],
      });
      if (!selected) return;
      paths = Array.isArray(selected) ? selected : [selected];
    } catch (error) {
      showNotice(`Could not open the file picker: ${describeError(error)}`);
      return;
    }
    await importPathsIntoAlbum(paths, albumId);
  };
  importPathsIntoAlbumRef.current = importPathsIntoAlbum;

  // Native Finder drops are window-level events. While an album is open, a
  // drop adds the selected files to that album instead of doing nothing.
  useEffect(() => {
    if (screen !== "Library" || !library.activeAlbum) {
      setAlbumDragOver(false);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const stop = await getCurrentWindow().onDragDropEvent((event: any) => {
          const payload = event.payload;
          if (payload.type === "over") {
            setAlbumDragOver(true);
          } else if (payload.type === "leave") {
            setAlbumDragOver(false);
          } else if (payload.type === "drop") {
            setAlbumDragOver(false);
            const albumId = liveRef.current.library.activeAlbum;
            if (albumId && payload.paths?.length) {
              void importPathsIntoAlbumRef.current(payload.paths, albumId);
            }
          }
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        /* browser preview has no native drag/drop */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      setAlbumDragOver(false);
    };
  }, [screen, library.activeAlbum]);

  // Force WebKit to relayout during macOS live window drags without running an
  // animation-frame loop while the window is idle.
  useEffect(() => {
    let raf: ReturnType<typeof requestAnimationFrame> | null = null;
    let prevW = window.innerWidth;
    let prevH = window.innerHeight;

    const onResize = () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (w !== prevW || h !== prevH) {
          prevW = w;
          prevH = h;
          // Force a synchronous layout read so WebKit recalculates the viewport.
          void document.documentElement.offsetHeight;
        }
      });
    };
    window.addEventListener("resize", onResize, { passive: true });

    return () => {
      window.removeEventListener("resize", onResize);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  const openAlbumMenu = (album: any, e: React.MouseEvent) => {
    openContextMenu(
      [
        {
          label: "Open Album",
          onClick: () => {
            library.setActiveAlbum(album.id);
            library.setFilter("All");
            library.setQuery("");
            setScreen("Library");
          },
        },
        { label: "Rename Album…", onClick: () => openRenameAlbumDialog(album) },
        { label: "Add Items…", onClick: () => addItemsToAlbum(album.id) },
        { divider: true },
        {
          label: "Delete Album…",
          danger: true,
          onClick: () => setAlbumPendingDelete(album),
        },
      ],
      e,
    );
  };

  const openScreen = (next: Screen) => {
    // Below tablet width the sidebar is an overlay drawer. Dismiss it after
    // navigation so it cannot cover the newly opened screen.
    if (window.innerWidth <= 900 && library.sidebarOpen) {
      library.toggleSidebar();
    }
    // The Library item in the sidebar is the way back to the whole
    // collection; without this, an active album kept filtering the grid and
    // Library still looked empty after leaving the album.
    if (next === "Library" && library.activeAlbum) {
      library.setActiveAlbum(null);
    }
    // The Albums screen is an overview, so a previously opened album should
    // not stay highlighted in the sidebar while every album is on screen.
    if (next === "Albums" && library.activeAlbum) {
      library.setActiveAlbum(null);
    }
    // Navigating away from the Viewer does not close it here: a playing video
    // keeps the viewer mounted off-screen so audio survives the tab switch (see
    // the freeze effect above). That effect still closes it for photos and for
    // an idle viewer.
    if (next === "Viewer") {
      // The sidebar Viewer is the library viewer. Ensure it cannot resume on a
      // hidden item the library grid does not contain.
      setViewerOrigin("Library");
      library.setViewerScope("library");
      const inspected = library.items.find(
        (i: MediaItem) => i.id === library.inspectedId,
      );
      if (inspected?.hidden) library.inspectItem(null);
      viewer.open();
    }
    if (next === "Hidden") {
      // Hidden is its own collection; do not carry a Library selection or an
      // inspector for a visible item into it.
      library.setViewerScope("library");
      library.clearSelection();
      library.inspectItem(null);
    } else if (screen === "Hidden") {
      // Leaving Hidden drops the hidden selection and any hidden inspector
      // focus, so the next screen cannot show an item it cannot display.
      library.clearSelection();
      const inspected = library.items.find(
        (i: MediaItem) => i.id === library.inspectedId,
      );
      if (inspected?.hidden) library.inspectItem(null);
    }
    if (next === "Edit") {
      const selectedItem = library.items.find(
        (i) => i.id === library.inspectedId,
      );
      if (selectedItem && selectedItem.kind === "photo") {
        edit.open(selectedItem);
      }
    }
    if (next !== screen) {
      setScreenHistory((prev) => [...prev, screen]);
    }
    setScreen(next);
  };

  const navigatePhoto = (delta: number) => {
    if (library.playableItems.length === 0) return;
    const nextIndex =
      (library.currentIndex + delta + library.playableItems.length) %
      library.playableItems.length;
    // Arrow keys move inspection only - the multi-selection survives.
    library.inspectItem(library.playableItems[nextIndex].id);
  };

  const importFiles = async () => {
    let paths: string[];
    try {
      const selected = await openFileDialog({
        directory: false,
        multiple: true,
        filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }],
      });
      if (!selected) return;
      paths = Array.isArray(selected) ? selected : [selected];
    } catch (e) {
      showNotice(`Could not open the file picker: ${describeError(e)}`);
      return;
    }

    try {
      showNotice(`Importing ${paths.length.toLocaleString()} file(s)…`);
      library.setBusy(true);
      library.setProgress({
        phase: "importing",
        processed: 0,
        total: paths.length,
      });
      const result = await tauri.library.importFiles(paths);
      await library.loadLibrary();
      library.setBusy(false);
      library.setProgress(null);
      showNotice(
        result.cancelled
          ? `Import cancelled. Kept ${result.items.length.toLocaleString()} item(s) already imported.`
          : result.items.length
            ? `Imported ${result.items.length.toLocaleString()} file(s).`
            : "No supported media files selected.",
      );
    } catch (e) {
      library.setBusy(false);
      library.setProgress(null);
      showNotice(`Import failed: ${describeError(e)}`);
    }
  };

  const importFolder = async () => {
    let selectedPaths: string[];
    try {
      const selected = await openFileDialog({
        directory: true,
        multiple: true,
        title: "Choose source folders",
      });
      if (!selected) return;
      selectedPaths = Array.isArray(selected) ? selected : [selected];
    } catch (e) {
      showNotice(`Could not open the folder picker: ${describeError(e)}`);
      return;
    }
    if (!selectedPaths.length) return;

    // Selecting a parent and one of its children would scan the child twice
    // and register two overlapping sources. Keep only the outermost folders.
    const rootPaths = [...new Set(selectedPaths)]
      .sort()
      .filter(
        (path, _index, all) =>
          !all.some(
            (parent) =>
              parent !== path &&
              path.startsWith(`${parent.replace(/\/$/, "")}/`),
          ),
      );

    try {
      showNotice(
        `Scanning ${rootPaths.length.toLocaleString()} source folder(s)…`,
      );
      library.setBusy(true);
      library.setProgress({ phase: "scanning", processed: 0, total: 0 });
      let discoveredCount = 0;
      let cancelled = false;
      for (const rootPath of rootPaths) {
        const result = await tauri.library.scan(rootPath);
        discoveredCount += result.discoveredCount;
        if (result.cancelled) {
          cancelled = true;
          break;
        }
      }
      await library.loadLibrary();
      await library.loadFolders();
      library.setBusy(false);
      library.setProgress(null);
      showNotice(
        cancelled
          ? `Scan cancelled. Indexed ${discoveredCount.toLocaleString()} file(s) so far; you can resume by scanning these sources again.`
          : discoveredCount
            ? `Found ${discoveredCount.toLocaleString()} ${discoveredCount === 1 ? "media file" : "media files"} across ${rootPaths.length.toLocaleString()} source folder(s).`
            : "No media files found in the selected folders.",
      );
    } catch (e) {
      library.setBusy(false);
      library.setProgress(null);
      showNotice(`Scan failed: ${describeError(e)}`);
    }
  };

  const rescanSource = async (folder: any) => {
    if (rescanInProgress.current) return;
    rescanInProgress.current = true;
    try {
      library.setBusy(true);
      await tauri.library.cancelScan();
      library.setProgress({
        phase: "scanning",
        processed: 0,
        total: 1,
        currentFile: folder.path,
      });
      const result = await tauri.library.scan(folder.path, true);
      await library.loadLibrary();
      await library.loadFolders();
      library.setProgress(null);
      library.setBusy(false);
      showNotice(
        result?.cancelled
          ? `Rescan cancelled for ${folder.name}.`
          : `Rescanned ${folder.name}.`,
      );
    } catch (e) {
      showNotice(`Rescan failed: ${describeError(e)}`);
    } finally {
      library.setBusy(false);
      library.setProgress(null);
      rescanInProgress.current = false;
    }
  };

  const rescanSources = async () => {
    // Prevent concurrent rescans (e.g. double-click on the button)
    if (rescanInProgress.current) return;
    rescanInProgress.current = true;
    try {
      library.setBusy(true);
      // Ensure any previous cancel is cleared before starting new scan
      await tauri.library.cancelScan();
      await library.loadFolders();
      const folders = useLibraryStore.getState().folders;
      let cancelled = false;
      let totalDiscovered = 0;

      for (let i = 0; i < folders.length; i++) {
        const folder = folders[i];
        // Show which source is being scanned
        library.setProgress({
          phase: "scanning",
          processed: i,
          total: folders.length,
          currentFile: folder.path,
        });
        const result = await tauri.library.scan(folder.path, true);
        totalDiscovered += result.discoveredCount || 0;
        if (result.cancelled) {
          cancelled = true;
          break;
        }
      }

      await library.loadLibrary();
      await library.loadFolders();
      library.setProgress(null);
      library.setBusy(false);
      rescanInProgress.current = false;
      showNotice(
        cancelled
          ? `Rescan cancelled. ${totalDiscovered.toLocaleString()} ${totalDiscovered === 1 ? "item" : "items"} processed from completed sources.`
          : `Sources rescanned. ${totalDiscovered.toLocaleString()} ${totalDiscovered === 1 ? "item" : "items"} processed.`,
      );
    } catch (e) {
      showNotice(`Rescan failed: ${describeError(e)}`);
    } finally {
      library.setBusy(false);
      library.setProgress(null);
      rescanInProgress.current = false;
    }
  };

  handlersRef.current = { importFolder, importFiles, showNotice };

  return (
    <div
      className={`app-frame ${dark ? "dark" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <a className="skip-to-content" href="#main-content">
        Skip to main content
      </a>
      <header
        className="topbar"
        onMouseDown={beginTopbarDrag}
        onDoubleClick={handleTopbarDoubleClick}
      >
        <div className="topbar-brand">
          <BrandMark size={26} />
          <b>VistoGallery</b>
        </div>
        <div className="topbar-context">
          {(() => {
            const activeAlbumRecord = library.activeAlbum
              ? library.albums.find((a: any) => a.id === library.activeAlbum)
              : null;
            const activeAlbumName = library.activeAlbum
              ? activeAlbumRecord?.name
              : null;
            const inAlbum = Boolean(library.activeAlbum);
            if (screen === "Library") {
              if (inAlbum) return <span>{activeAlbumName ?? "Album"}</span>;
              return <span className="muted">Library</span>;
            }
            if (screen === "Albums") return <span>Albums</span>;
            return <span>{screen}</span>;
          })()}
          {library.busy && (
            <span className="topbar-busy">
              {library.progress?.phase === "hashing"
                ? "Checking duplicates…"
                : library.progress?.phase === "reading"
                  ? "Loading library…"
                  : "Indexing…"}
            </span>
          )}
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button"
            type="button"
            aria-label={library.sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-pressed={library.sidebarOpen}
            title={
              library.sidebarOpen ? "Hide sidebar (⌥⌘S)" : "Show sidebar (⌥⌘S)"
            }
            onClick={() => library.toggleSidebar()}
          >
            <LibraryIcon size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={
              screen !== "Library" && screen !== "Hidden"
                ? "Inspector available in Library and Hidden"
                : library.showInspector
                  ? "Hide inspector"
                  : "Show inspector"
            }
            aria-pressed={
              (screen === "Library" || screen === "Hidden") &&
              library.showInspector
            }
            disabled={screen !== "Library" && screen !== "Hidden"}
            title={
              screen === "Library" || screen === "Hidden"
                ? library.showInspector
                  ? "Hide inspector (⌥⌘I)"
                  : "Show inspector (⌥⌘I)"
                : "Inspector is available in Library and Hidden"
            }
            onClick={() => library.toggleInspector()}
          >
            <InspectorIcon size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={
              dark ? "Switch to light appearance" : "Switch to dark appearance"
            }
            title={
              dark ? "Switch to light appearance" : "Switch to dark appearance"
            }
            onClick={() =>
              settings.update("appearance", dark ? "light" : "dark")
            }
          >
            {dark ? <SunIcon size={18} /> : <MoonIcon size={18} />}
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => openScreen("Settings")}
          >
            <GearIcon size={18} />
          </button>
        </div>
      </header>

      <div
        className={`app-body ${library.sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}
      >
        <aside className="sidebar">
          <div className="sidebar-scroll">
            <div className="sidebar-header">
              <div className="sidebar-label">WORKSPACE</div>
              <nav className="primary-nav" aria-label="Main navigation">
                {[
                  {
                    label: "Library",
                    Icon: LibraryIcon,
                    screen: "Library" as Screen,
                  },
                  {
                    label: "Albums",
                    Icon: AlbumsIcon,
                    screen: "Albums" as Screen,
                  },
                  {
                    label: "Viewer",
                    Icon: ViewerIcon,
                    screen: "Viewer" as Screen,
                  },
                  {
                    label: "Duplicates",
                    Icon: DuplicatesIcon,
                    screen: "Duplicates" as Screen,
                  },
                  { label: "Edit", Icon: EditIcon, screen: "Edit" as Screen },
                  {
                    label: "Batch",
                    Icon: BatchIcon,
                    screen: "Batch" as Screen,
                  },
                  {
                    label: "Hidden",
                    Icon: EyeOffIcon,
                    screen: "Hidden" as Screen,
                  },
                ].map(({ label, Icon, screen: target }) => (
                  <button
                    key={label}
                    type="button"
                    className={`nav-item ${screen === target ? "active" : ""}`}
                    aria-label={label}
                    title={label}
                    aria-current={screen === target ? "page" : undefined}
                    onClick={() => openScreen(target)}
                  >
                    <span className="nav-icon">
                      <Icon size={18} />
                    </span>
                    <span>{label}</span>
                    {(label === "Library" &&
                      library.items.length - library.hiddenCount > 0) ||
                    (label === "Albums" && library.albums.length > 0) ||
                    (label === "Hidden" && library.hiddenCount > 0) ? (
                      <span className="nav-badge">
                        {label === "Library"
                          ? library.items.length - library.hiddenCount
                          : label === "Albums"
                            ? library.albums.length
                            : library.hiddenCount}
                      </span>
                    ) : null}
                  </button>
                ))}
              </nav>
            </div>

            <div className="sidebar-divider" aria-hidden="true" />

            <div className="sidebar-section sources-entry-section">
              <button
                type="button"
                className={`sources-entry${sourcesSheetOpen ? " open" : ""}`}
                onClick={() => setSourcesSheetOpen(true)}
                title="Manage library sources"
                aria-haspopup="dialog"
                aria-expanded={sourcesSheetOpen}
              >
                <span className="sources-entry-icon">
                  <FolderIcon size={16} />
                </span>
                <span className="sources-entry-text">
                  <span className="sources-entry-name">Sources</span>
                  <span className="sources-entry-count">
                    {library.folders.length === 0
                      ? "No sources yet"
                      : `${library.folders.length.toLocaleString()} folder${library.folders.length === 1 ? "" : "s"} · ${library.folders.reduce((total: number, folder: LibraryFolder) => total + folder.itemCount, 0).toLocaleString()} items`}
                  </span>
                </span>
                <span className="sources-entry-action">
                  <span className="sources-entry-chevron" aria-hidden="true">
                    ›
                  </span>
                </span>
              </button>
            </div>

            <div className="sidebar-divider" aria-hidden="true" />

            <div className="sidebar-section">
              <div className="sidebar-section-label">LIBRARY</div>
              <div className="library-stats">
                <div className="stat-row">
                  <KindDot kind="photo" />
                  <span className="stat-label">Photos</span>
                  <span className="stat-value">
                    {libraryStats.photos.toLocaleString()}
                    <span className="stat-size">
                      · {formatBytesSimple(libraryStats.photoSize)}
                    </span>
                  </span>
                </div>
                <div className="stat-row">
                  <KindDot kind="video" />
                  <span className="stat-label">Videos</span>
                  <span className="stat-value">
                    {libraryStats.videos.toLocaleString()}
                    <span className="stat-size">
                      · {formatBytesSimple(libraryStats.videoSize)}
                    </span>
                  </span>
                </div>
                <div className="stat-row">
                  <KindDot kind="raw" />
                  <span className="stat-label">RAW</span>
                  <span className="stat-value">
                    {libraryStats.raws.toLocaleString()}
                    <span className="stat-size">
                      · {formatBytesSimple(libraryStats.rawSize)}
                    </span>
                  </span>
                </div>
                <div className="stat-row">
                  <KindDot kind="photo" />
                  <span className="stat-label">Favorites</span>
                  <span className="stat-value">
                    {libraryStats.favorites.toLocaleString()}
                    <span className="stat-size">
                      · {formatBytesSimple(libraryStats.favoriteSize)}
                    </span>
                  </span>
                </div>
                <div className="stat-row hidden">
                  <KindDot kind="photo" />
                  <span className="stat-label">Hidden</span>
                  <span className="stat-value">
                    {libraryStats.hidden.toLocaleString()}
                    <span className="stat-size">
                      · {formatBytesSimple(libraryStats.hiddenSize)}
                    </span>
                  </span>
                </div>
                <div className="stat-row size">
                  <span className="stat-label">Total</span>
                  <span className="stat-value">
                    {(
                      library.items.length - library.hiddenCount
                    ).toLocaleString()}{" "}
                    · {formatBytesSimple(libraryStats.totalSize)}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="sidebar-footer">
            <span className="sidebar-health">
              <span className="health-dot" aria-hidden="true" />
              Storage Healthy
            </span>
            <span className="sidebar-version">v{appVersion || "0.1.1"}</span>
          </div>
        </aside>

        <main
          id="main-content"
          className="main-content"
          tabIndex={-1}
          style={{ position: "relative" }}
        >
          {screenHistory.length > 0 && (
            <button
              className="icon-button"
              type="button"
              aria-label="Go back"
              title="Go back"
              onClick={goBack}
              style={{
                position: "absolute",
                top: 10,
                right: 10,
                zIndex: 5,
                width: 32,
                height: 32,
                padding: 0,
                borderRadius: 8,
                opacity: 0.8,
              }}
            >
              ←
            </button>
          )}
          {screen === "Library" && (
            <LibraryScreen
              items={library.visibleItems}
              inspectedId={library.inspectedId}
              selectedIds={library.selectedIds}
              filter={library.filter}
              query={library.query}
              layout={library.layout}
              showInspector={library.showInspector}
              activeAlbum={library.activeAlbum}
              albums={library.albums}
              onInspectItem={library.inspectItem}
              onToggleSelect={library.toggleSelection}
              onSelectRange={library.selectRange}
              onSetSelection={library.setSelectedIds}
              onToggleSelectAll={library.toggleSelectAll}
              onClearSelection={library.clearSelection}
              onOpenBatch={() => openScreen("Batch")}
              onChangeFilter={library.setFilter}
              onChangeQuery={library.setQuery}
              onChangeLayout={library.setLayout}
              onToggleInspector={library.toggleInspector}
              onSetActiveAlbum={library.setActiveAlbum}
              onOpenAlbums={() => openScreen("Albums")}
              onAddItems={(albumId: string) => addItemsToAlbum(albumId)}
              onOpenAlbumPicker={(itemIds?: string[]) =>
                openAlbumPicker(itemIds)
              }
              onAlbumMenu={(e: React.MouseEvent) => {
                const album = library.albums.find(
                  (a: any) => a.id === library.activeAlbum,
                );
                if (album) openAlbumMenu(album, e);
              }}
              albumDragOver={albumDragOver}
              onToggleFavorite={library.toggleFavorite}
              onToggleHidden={library.toggleHidden}
              onSetFavoriteForIds={library.setFavoriteForIds}
              onSetHiddenForIds={library.setHiddenForIds}
              onUpdateTags={library.updateItemTags}
              onDeleteItems={library.deleteItems}
              onRequestDeleteItems={(ids: string[]) => {
                itemPendingDeleteRef.current = ids;
                setItemPendingDeleteCount(ids.length);
              }}
              onRequestRemoveFromAlbum={(albumId: string, itemIds: string[]) =>
                setAlbumRemovePending({ albumId, itemIds })
              }
              onOpenViewer={(id?: string) => openViewer(id, "Library")}
              onOpenEdit={(item: any) => {
                edit.open(item);
                setScreen("Edit");
              }}
              onImportFolder={() => importFolder()}
              onImportFiles={() => importFiles()}
              onPlaySlideshow={playSlideshow}
              onCreateAlbum={openAlbumDialog}
              searchInputRef={searchInputRef}
              onContextMenu={openContextMenu}
              busy={library.busy}
              progress={library.progress}
              notice={showNotice}
              assetUrl={assetUrl}
              hiddenCount={library.hiddenCount}
            />
          )}

          {screen === "Albums" && (
            <AlbumsScreen
              albums={library.albums}
              items={library.items}
              assetUrl={assetUrl}
              onCreateAlbum={openAlbumDialog}
              onAlbumContextMenu={openAlbumMenu}
              onOpenAlbum={(albumId: string) => {
                library.setActiveAlbum(albumId);
                library.setFilter("All");
                library.setQuery("");
                setScreen("Library");
              }}
            />
          )}

          {(screen === "Viewer" || viewer.isOpen) && (
            <div
              ref={viewerHostRef}
              className={`viewer-host${screen === "Viewer" ? "" : " viewer-host-hidden"}`}
              aria-hidden={screen !== "Viewer"}
            >
              <ViewerScreen
                active={screen === "Viewer"}
                items={library.viewerItems}
                selected={
                  screen === "Viewer"
                    ? library.viewerSelected
                    : (frozenViewerItem ?? lastViewerItemRef.current)
                }
                zoom={viewer.zoom}
                fitMode={viewer.fitMode}
                rotation={viewer.rotation}
                flipX={viewer.flipX}
                onNavigate={viewer.navigate}
                onSetPhoto={(id: string) => library.inspectItem(id)}
                onSetZoom={viewer.setZoom}
                onZoomIn={viewer.zoomIn}
                onZoomOut={viewer.zoomOut}
                onResetZoom={viewer.resetZoom}
                onToggleFitMode={viewer.toggleFitMode}
                onRotate={viewer.rotate}
                onToggleFlip={viewer.toggleFlip}
                onResetTransform={viewer.resetTransform}
                onToggleFullscreen={viewer.toggleFullscreen}
                onClose={viewer.close}
                onToggleFavorite={library.toggleFavorite}
                onToggleHidden={library.toggleHidden}
                onOpenEdit={(item: any) => {
                  edit.open(item);
                  setScreen("Edit");
                }}
                onContextMenu={openContextMenu}
                assetUrl={assetUrl}
              />
            </div>
          )}

          {screen === "Edit" && (
            <EditScreen
              item={edit.item}
              values={edit.values}
              crop={edit.crop}
              history={edit.history}
              historyIndex={edit.historyIndex}
              onSetValue={edit.setValue}
              onSetValues={edit.setValues}
              onReset={edit.reset}
              onAuto={edit.auto}
              onRotate={edit.rotate}
              onFlip={edit.flip}
              onSetCrop={edit.setCrop}
              onResetCrop={edit.resetCrop}
              onUndo={edit.undo}
              onRedo={edit.redo}
              canUndo={edit.canUndo}
              canRedo={edit.canRedo}
              onClose={edit.close}
              onSaveDraft={edit.saveDraft}
              onBack={() => setScreen("Library")}
              onExport={async (inPlace = false) => {
                const item = edit.item;
                if (!item) return;
                const sourceExtension = String(
                  item.extension || item.name.split(".").pop() || "",
                ).toLowerCase();
                if (inPlace) {
                  if (
                    !["jpg", "jpeg", "png", "webp"].includes(sourceExtension)
                  ) {
                    showNotice(
                      "Replace original supports JPEG, PNG, and WebP. Save a copy instead.",
                    );
                    return;
                  }
                }
                try {
                  const v = edit.values || {};
                  const crop = edit.crop || {
                    enabled: false,
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                  };

                  // Build render request for native backend
                  const request = {
                    sourcePath: item.path,
                    edits: v,
                    outputFormat: (inPlace ? "in_place" : "image/jpeg") as
                      | "jpeg"
                      | "png"
                      | "webp"
                      | "heic"
                      | "avif"
                      | "in_place",
                    quality: 0.92,
                    stripMetadata: false,
                    crop: crop.enabled ? crop : undefined,
                  };

                  const result = await tauri.editing.render(request);

                  if (!inPlace) {
                    // For save-copy, backend wrote to temp; now show save dialog
                    const suggestedName =
                      String(item.name).replace(/\.[^.]+$/, "") + "_edited.jpg";
                    const finalPath = await save({
                      defaultPath: suggestedName,
                      filters: [
                        { name: "JPEG image", extensions: ["jpg", "jpeg"] },
                      ],
                    });
                    if (!finalPath) {
                      showNotice("Export cancelled");
                      return;
                    }
                    // Move temp file to final destination
                    await tauri.editing.moveExportedFile(
                      result.outputPath,
                      finalPath,
                    );
                  }

                  clearEditDraft(item.id);
                  if (inPlace) await library.loadLibrary();
                  showNotice(
                    inPlace ? "Replaced original" : "Exported edited copy",
                  );
                } catch (e) {
                  if (String(e).includes("cancelled")) {
                    showNotice("Export cancelled");
                  } else {
                    showNotice("Export failed: " + String(e));
                  }
                }
              }}
              onClearDraft={edit.clearDraft}
              onNotice={showNotice}
              assetUrl={assetUrl}
              items={library.items.filter(
                (i: any) => i.kind === "photo" && !i.hidden,
              )}
              onOpenEdit={(item: any) => {
                edit.saveDraft();
                edit.open(item);
              }}
            />
          )}

          {screen === "Batch" && (
            <BatchScreen
              items={library.items.filter((i: any) =>
                library.selectedIds.includes(i.id),
              )}
              selectedIds={library.selectedIds}
              config={batch}
              state={batch}
              onSetPattern={batch.setPattern}
              onSetFormat={batch.setFormat}
              onSetQuality={batch.setQuality}
              onSetStripMetadata={batch.setStripMetadata}
              onSetMaxDimension={batch.setMaxDimension}
              onSetStep={batch.setStep}
              onChooseFolder={async () => {
                const folder = await openFileDialog({
                  directory: true,
                  multiple: false,
                  title: "Choose export folder",
                });
                if (typeof folder === "string") batch.setOutputFolder(folder);
              }}
              onOpenFolder={() => {
                if (batch.outputFolder)
                  tauri.items.openFolder(batch.outputFolder);
              }}
              onExportBatch={batch.exportBatch}
              onCancelBatch={batch.cancelBatch}
              onReset={batch.reset}
              onOpenLibrary={() => setScreen("Library")}
              onClearSelection={library.clearSelection}
              onSelectAll={library.selectAll}
              onSetSelection={library.setSelectedIds}
              onRemoveItem={library.toggleSelection}
              busy={batch.busy}
              cancelRequested={batch.cancelRequested}
              progress={batch.progress}
              result={batch.result}
              error={batch.error}
              assetUrl={assetUrl}
            />
          )}

          {screen === "Hidden" && (
            <HiddenScreen
              assetUrl={assetUrl}
              searchInputRef={searchInputRef}
              onContextMenu={openContextMenu}
              onNavigate={openScreen}
              onCreateAlbum={openAlbumDialog}
              onOpenAlbumPicker={(itemIds?: string[]) =>
                openAlbumPicker(itemIds)
              }
              onRequestDeleteItems={(ids: string[]) => {
                itemPendingDeleteRef.current = ids;
                setItemPendingDeleteCount(ids.length);
              }}
              onOpenEdit={(item: any) => {
                edit.open(item);
                setScreen("Edit");
              }}
              onOpenViewer={(id?: string) => openViewer(id, "Hidden", "hidden")}
            />
          )}

          {screen === "Duplicates" && (
            <DuplicatesScreen
              groups={library.duplicates}
              items={library.items}
              onScan={library.scanDuplicates}
              onClear={library.clearDuplicates}
              busy={library.busy}
              assetUrl={assetUrl}
              onRequestDeleteItems={(ids: string[]) => {
                itemPendingDeleteRef.current = ids;
                setItemPendingDeleteCount(ids.length);
              }}
              onHideIds={async (ids: string[]) => {
                if (!ids.length) return;
                library.showNotice(
                  `Hiding ${ids.length.toLocaleString()} item(s)…`,
                );
                await library.setHiddenForIds(ids, true);
                library.showNotice(
                  `Hidden ${ids.length.toLocaleString()} item(s).`,
                );
                await library.scanDuplicates();
              }}
            />
          )}

          {screen === "Settings" && (
            <SettingsScreen
              onAddFolder={() => importFolder()}
              onRemoveFolder={(folder: LibraryFolder) =>
                setFolderPendingRemove(folder)
              }
              onRescan={() => {
                void rescanSources();
              }}
              onRescanFolder={(folder) => {
                void rescanSource(folder);
              }}
            />
          )}
        </main>
      </div>

      {library.busy && library.progress && (
        <div
          className={`busy-indicator ${library.progress.phase === "hashing" ? "busy-indicator-hashing" : ""}`}
          role="status"
        >
          <span className="spinner" />
          {library.progress.phase === "hashing"
            ? (() => {
                const bytesProcessed = library.progress.bytesProcessed ?? 0;
                const bytesTotal = library.progress.bytesTotal ?? 0;
                const filesProcessed =
                  library.progress.filesProcessed ?? library.progress.processed;
                const filesTotal =
                  library.progress.filesTotal ?? library.progress.total;
                const percent =
                  bytesTotal > 0
                    ? Math.min(
                        100,
                        Math.round((bytesProcessed / bytesTotal) * 100),
                      )
                    : 0;
                return (
                  <div className="busy-indicator-progress-copy">
                    <b>
                      {bytesTotal > 0
                        ? `Checking duplicates · ${percent}%`
                        : filesTotal > 0
                          ? "Hashing candidates…"
                          : "Finding duplicate candidates…"}
                    </b>
                    <small>
                      {filesProcessed.toLocaleString()} of{" "}
                      {filesTotal.toLocaleString()} candidate files
                      {bytesTotal > 0 &&
                        ` · ${formatBytesSimple(bytesProcessed)} of ${formatBytesSimple(bytesTotal)}`}
                    </small>
                    <div
                      className="busy-indicator-progress-track"
                      role="progressbar"
                      aria-label="Duplicate scan progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    >
                      <span style={{ width: `${percent}%` }} />
                    </div>
                    {library.progress.currentFile && (
                      <small
                        className="busy-indicator-current-file"
                        title={library.progress.currentFile}
                      >
                        {library.progress.currentFile}
                      </small>
                    )}
                  </div>
                );
              })()
            : library.progress.phase === "trashing"
              ? (() => {
                  const processed = library.progress.processed ?? 0;
                  const total = library.progress.total ?? 0;
                  const percent =
                    total > 0
                      ? Math.min(100, Math.round((processed / total) * 100))
                      : 0;
                  return (
                    <div className="busy-indicator-progress-copy">
                      <b>Moving to Trash · {percent}%</b>
                      <small>
                        {processed.toLocaleString()} of {total.toLocaleString()}{" "}
                        files
                      </small>
                      <div
                        className="busy-indicator-progress-track"
                        role="progressbar"
                        aria-label="Trash progress"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent}
                      >
                        <span style={{ width: `${percent}%` }} />
                      </div>
                    </div>
                  );
                })()
              : library.progress.phase === "reading"
                ? (() => (
                    <div className="busy-indicator-progress-copy">
                      <b>Loading library…</b>
                      <small>Reading database</small>
                      <div
                        className="busy-indicator-progress-track"
                        role="progressbar"
                        aria-label="Loading library"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={0}
                      >
                        <span style={{ width: "0%" }} />
                      </div>
                    </div>
                  ))()
                : library.progress.phase === "scanning"
                  ? (() => {
                      // Distinguish source-level vs file-level progress:
                      // - source-level: total <= number of folders (frontend sets it)
                      // - file-level: total = files in current folder (backend sets it)
                      // Heuristic: if currentFile is a directory path, it's source-level.
                      const isSourceLevel = library.progress.currentFile
                        ? library.progress.currentFile.endsWith("/") ||
                          !library.progress.currentFile.includes(".")
                        : true;
                      const processed = library.progress.processed ?? 0;
                      const total = library.progress.total ?? 0;
                      const percent =
                        total > 0
                          ? Math.min(100, Math.round((processed / total) * 100))
                          : 0;

                      // Extract just the folder/file name from path
                      const getName = (path: string) =>
                        path.split("/").pop() || path;

                      if (isSourceLevel) {
                        return (
                          <div className="busy-indicator-progress-copy">
                            <b>
                              Scanning source {processed + 1} of {total} ·{" "}
                              {percent}%
                            </b>
                            <small>
                              {library.progress.currentFile
                                ? getName(library.progress.currentFile)
                                : "Preparing…"}
                            </small>
                            <div
                              className="busy-indicator-progress-track"
                              role="progressbar"
                              aria-label="Scan progress"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={percent}
                            >
                              <span style={{ width: `${percent}%` }} />
                            </div>
                          </div>
                        );
                      } else {
                        // Show source folder + file progress in two lines
                        const currentFileName = library.progress.currentFile
                          ? library.progress.currentFile.split("/").pop() ||
                            library.progress.currentFile
                          : "files";
                        // Extract source folder from current file path
                        let sourceFolder = "files";
                        if (library.progress.currentFile) {
                          const parts = library.progress.currentFile.split("/");
                          if (parts.length >= 2) {
                            sourceFolder = parts[parts.length - 2]; // parent folder name
                          }
                        }
                        return (
                          <div className="busy-indicator-progress-copy">
                            <b>
                              Scanning {sourceFolder} ·{" "}
                              {processed.toLocaleString()} of{" "}
                              {total.toLocaleString()} · {percent}%
                            </b>
                            <small>{currentFileName}</small>
                            <div
                              className="busy-indicator-progress-track"
                              role="progressbar"
                              aria-label="File scan progress"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={percent}
                            >
                              <span style={{ width: `${percent}%` }} />
                            </div>
                          </div>
                        );
                      }
                    })()
                  : `${library.progress.phase} ${library.progress.processed}/${library.progress.total}`}
          <button
            className="busy-indicator-cancel"
            type="button"
            onClick={() => void library.cancelScan()}
            disabled={library.canceling}
          >
            {library.canceling ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      )}

      {library.notice && (
        <div
          className={`toast ${isWarningNotice(library.notice) ? "toast-warning" : ""}`}
          role={isWarningNotice(library.notice) ? "alert" : "status"}
          aria-live={isWarningNotice(library.notice) ? "assertive" : "polite"}
          onClick={() => library.showNotice("")}
        >
          <span aria-hidden="true">
            {isWarningNotice(library.notice) ? "!" : "✓"}
          </span>
          {library.notice}
        </div>
      )}

      {aboutOpen && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAboutOpen(false);
          }}
        >
          <div
            className="album-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-dialog-title"
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">ABOUT</p>
                <h2 id="about-dialog-title">VistoGallery</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close"
                onClick={() => setAboutOpen(false)}
              >
                ×
              </button>
            </div>
            <p className="dialog-hint">Native macOS photo gallery.</p>
            <p className="dialog-hint">Version {appVersion || "0.1.1"}</p>
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-button"
                onClick={() => setAboutOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {albumDialogOpen && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeAlbumDialog();
          }}
        >
          <form
            ref={albumDialogRef}
            className="album-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="album-dialog-title"
            onSubmit={submitAlbum}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">ORGANISE</p>
                <h2 id="album-dialog-title">
                  {albumDialogMode === "rename" ? "Rename album" : "New album"}
                </h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close"
                onClick={closeAlbumDialog}
                disabled={creatingAlbum}
              >
                ×
              </button>
            </div>
            <div className="dialog-field">
              <label htmlFor="album-name">Album name</label>
              <input
                id="album-name"
                ref={albumInputRef}
                value={albumName}
                onChange={(e) => setAlbumName(e.target.value)}
                placeholder="e.g. Summer 2026"
                maxLength={80}
                autoComplete="off"
                disabled={creatingAlbum}
              />
            </div>
            <p className="dialog-hint">
              {albumDialogMode === "rename"
                ? "This only changes the album name. Photos stay in this album."
                : (() => {
                    const count =
                      albumSeedIds?.length ??
                      (library.selectedIds.length ||
                        (library.inspectedId ? 1 : 0));
                    return count
                      ? `Adds ${count.toLocaleString()} item${count === 1 ? "" : "s"} to the new album.`
                      : "You can add photos to it from the library or an album at any time.";
                  })()}
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={closeAlbumDialog}
                disabled={creatingAlbum}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={!albumName.trim() || creatingAlbum}
              >
                {creatingAlbum
                  ? albumDialogMode === "rename"
                    ? "Saving…"
                    : "Creating…"
                  : albumDialogMode === "rename"
                    ? "Save name"
                    : "Create album"}
              </button>
            </div>
          </form>
        </div>
      )}

      {albumPickerOpen && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !addingToAlbumId)
              setAlbumPickerOpen(false);
          }}
        >
          <div
            className="album-dialog album-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="album-picker-title"
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">ORGANISE</p>
                <h2 id="album-picker-title">Add to album</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close"
                onClick={() => setAlbumPickerOpen(false)}
                disabled={Boolean(addingToAlbumId)}
              >
                ×
              </button>
            </div>
            <p className="album-picker-subtitle">
              {albumPickerItemIds.length.toLocaleString()} selected item
              {albumPickerItemIds.length === 1 ? "" : "s"}
            </p>

            <div className="album-picker-search">
              <SearchIcon size={15} />
              <input
                ref={albumSearchRef}
                value={albumSearch}
                onChange={(e) => setAlbumSearch(e.target.value)}
                placeholder="Search albums"
                aria-label="Search albums"
                disabled={Boolean(addingToAlbumId)}
              />
              {albumSearch && (
                <button
                  type="button"
                  className="album-picker-search-clear"
                  aria-label="Clear album search"
                  onClick={() => {
                    setAlbumSearch("");
                    albumSearchRef.current?.focus();
                  }}
                >
                  ×
                </button>
              )}
            </div>

            <div
              className="album-picker-list"
              role="listbox"
              aria-label="Albums"
            >
              {(() => {
                const selectedItems = library.items.filter((item: any) =>
                  albumPickerItemIds.includes(item.id),
                );
                const query = albumSearch.trim().toLowerCase();
                const matching = library.albums.filter(
                  (album: any) =>
                    !query || album.name.toLowerCase().includes(query),
                );
                if (!matching.length) {
                  return (
                    <div className="album-picker-empty">
                      <AlbumsIcon size={24} />
                      <b>
                        {library.albums.length
                          ? "No matching albums"
                          : "No albums yet"}
                      </b>
                      <p>
                        {library.albums.length
                          ? "Try a different search."
                          : "Create an album and these photos will be added to it."}
                      </p>
                    </div>
                  );
                }
                return matching.map((album: any, index: number) => {
                  const alreadyAdded =
                    selectedItems.length > 0 &&
                    selectedItems.every((item: any) =>
                      item.albumIds?.includes(album.id),
                    );
                  const busy = addingToAlbumId === album.id;
                  return (
                    <button
                      key={album.id}
                      type="button"
                      className="album-picker-row"
                      onClick={() => addPickedItemsToAlbum(album)}
                      disabled={Boolean(addingToAlbumId) || alreadyAdded}
                      role="option"
                      aria-selected="false"
                    >
                      <i
                        className={`album-dot ${["coral", "violet", "blue", "green"][index % 4]}`}
                      />
                      <span className="album-picker-name">{album.name}</span>
                      <span className="album-picker-count">
                        {alreadyAdded
                          ? "Already added"
                          : (() => {
                              const count = album.itemCount || 0;
                              return `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
                            })()}
                      </span>
                      {busy && (
                        <span className="spinner album-picker-spinner" />
                      )}
                    </button>
                  );
                });
              })()}
            </div>

            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setAlbumPickerOpen(false)}
                disabled={Boolean(addingToAlbumId)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={createAlbumFromPicker}
                disabled={Boolean(addingToAlbumId)}
              >
                <PlusIcon size={14} /> New album
              </button>
            </div>
          </div>
        </div>
      )}

      {albumPendingDelete && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !deletingAlbum)
              setAlbumPendingDelete(null);
          }}
        >
          <div
            ref={deleteAlbumDialogRef}
            className="album-dialog delete-album-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-album-title"
            aria-describedby="delete-album-description"
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">ALBUM</p>
                <h2 id="delete-album-title">Delete Album?</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close"
                onClick={() => setAlbumPendingDelete(null)}
                disabled={deletingAlbum}
              >
                ×
              </button>
            </div>
            <p className="delete-album-copy">
              Are you sure you want to delete <b>“{albumPendingDelete.name}”</b>
              ?
            </p>
            <div className="delete-album-safety" id="delete-album-description">
              <span>
                <AlbumsIcon size={19} />
              </span>
              <p>
                <b>Your photos are safe.</b> This only removes the album and its
                grouping.{" "}
                {albumPendingDelete.itemCount
                  ? `${albumPendingDelete.itemCount.toLocaleString()} item${albumPendingDelete.itemCount === 1 ? "" : "s"} will remain in your library.`
                  : "The items remain in your library."}
              </p>
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setAlbumPendingDelete(null)}
                disabled={deletingAlbum}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={confirmDeleteAlbum}
                disabled={deletingAlbum}
              >
                {deletingAlbum ? "Deleting…" : "Delete Album"}
              </button>
            </div>
          </div>
        </div>
      )}

      {itemPendingDeleteCount > 0 && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setItemPendingDeleteCount(0);
              itemPendingDeleteRef.current = null;
            }
          }}
        >
          <div
            ref={deleteItemDialogRef}
            className="album-dialog delete-album-dialog"
            role="alertdialog"
            aria-modal="true"
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">PHOTO</p>
                <h2>Delete Item?</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close"
                onClick={() => {
                  setItemPendingDeleteCount(0);
                  itemPendingDeleteRef.current = null;
                }}
              >
                ×
              </button>
            </div>
            <p className="delete-album-copy">
              Are you sure you want to delete{" "}
              <b>
                {itemPendingDeleteCount} item
                {itemPendingDeleteCount === 1 ? "" : "s"}
              </b>
              ? They will be moved to Trash.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => {
                  setItemPendingDeleteCount(0);
                  itemPendingDeleteRef.current = null;
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={confirmDeleteItem}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {albumRemovePending && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAlbumRemovePending(null);
          }}
        >
          <div
            className="album-dialog delete-album-dialog"
            role="alertdialog"
            aria-modal="true"
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">ALBUM</p>
                <h2>Remove from Album?</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close"
                onClick={() => setAlbumRemovePending(null)}
              >
                ×
              </button>
            </div>
            <p className="delete-album-copy">
              Remove {albumRemovePending.itemIds.length} item
              {albumRemovePending.itemIds.length === 1 ? "" : "s"} from this
              album?
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setAlbumRemovePending(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={confirmRemoveFromAlbum}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {sourcesSheetOpen && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSourcesSheetOpen(false);
          }}
        >
          <div
            className="album-dialog sources-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sources-sheet-title"
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">LIBRARY</p>
                <h2 id="sources-sheet-title">Sources</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close"
                onClick={() => setSourcesSheetOpen(false)}
              >
                ×
              </button>
            </div>
            <SourcesManager
              variant="sheet"
              onAddFolder={() => importFolder()}
              onRemoveFolder={(folder: LibraryFolder) =>
                setFolderPendingRemove(folder)
              }
              onFilterSource={() => {
                setScreen("Library");
                setSourcesSheetOpen(false);
              }}
              onRescan={() => {
                void rescanSources();
              }}
              onRescanFolder={(folder) => {
                void rescanSource(folder);
              }}
            />
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setSourcesSheetOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {folderPendingRemove && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !removingFolder)
              setFolderPendingRemove(null);
          }}
        >
          <div
            ref={removeFolderDialogRef}
            className="album-dialog delete-album-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remove-folder-title"
            aria-describedby="remove-folder-description"
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">FOLDER</p>
                <h2 id="remove-folder-title">Remove Folder?</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close"
                onClick={() => setFolderPendingRemove(null)}
                disabled={removingFolder}
              >
                ×
              </button>
            </div>
            <p className="delete-album-copy">
              Remove <b>“{folderPendingRemove.name}”</b> from VistoGallery?
            </p>
            <div className="delete-album-safety" id="remove-folder-description">
              <span>
                <FolderIcon size={19} />
              </span>
              <p>
                <b>Your files are safe.</b>{" "}
                {folderPendingRemove.itemCount > 0
                  ? `This only unstages the folder and its ${folderPendingRemove.itemCount.toLocaleString()} item${folderPendingRemove.itemCount === 1 ? "" : "s"} from the library.`
                  : "This only removes the empty folder entry from the library."}{" "}
                Nothing is deleted from disk — import the folder again to bring
                it back.
              </p>
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setFolderPendingRemove(null)}
                disabled={removingFolder}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={confirmRemoveFolder}
                disabled={removingFolder}
              >
                {removingFolder ? "Removing…" : "Remove Folder"}
              </button>
            </div>
          </div>
        </div>
      )}

      {screen !== "Viewer" && frozenViewerItem?.kind === "video" && (
        <MiniPlayer
          onExpand={() => {
            library.inspectItem(frozenViewerItem.id);
            setScreen("Viewer");
          }}
          onClose={() => {
            usePlaybackStore.getState().stop();
            viewer.close();
            setFrozenViewerItem(null);
          }}
        />
      )}

      <SlideshowOverlay assetUrl={assetUrl} />

      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

// ===== SCREEN COMPONENTS =====

// A <video> on its own only paints a poster once playback starts, so every video
// tile used to render solid black. Seeking a fraction of a second after the
// metadata arrives makes the webview decode and paint a real frame.

function PickerThumbnail({
  itemId,
  name,
  style,
}: {
  itemId: string;
  name: string;
  style?: React.CSSProperties;
}) {
  return (
    <CachedThumbnail
      itemId={itemId}
      name={name}
      size={256}
      style={style}
      showStatus
      placeholderClassName="edit-picker-thumb"
    />
  );
}

// How many tiles to mount before the user scrolls further. Small enough to
// keep filtering/typing snappy, large enough to fill a tall window.
const GALLERY_PAGE_SIZE = 180;

/**
 * Hidden is the same gallery as Library, but scoped to items with `hidden`.
 * It keeps its own filter/search state so browsing hidden items never changes
 * the Library's view, and it never pretends the files are protected — the
 * disclaimer in the header is the contract.
 */
export default App;
