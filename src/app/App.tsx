import React, { useEffect, useRef, useState, useCallback, useMemo, useDeferredValue, memo } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
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
import { getTypeIdentity, getKindIcon } from "../engine/utils/mediaTypes";

// Helper: render a kind badge using centralized type identity
function KindBadge({ kind }: { kind: "photo" | "video" | "raw" }) {
  const { label, softColor, color } = getTypeIdentity(kind);
  return (
    <span className={`kind-badge ${kind}`} style={{ background: softColor, color }} title={label}>
      {label}
    </span>
  );
}

// Helper: render a kind dot
function KindDot({ kind }: { kind: "photo" | "video" | "raw" }) {
  const { color } = getTypeIdentity(kind);
  return <span className={`kind-dot ${kind}`} style={{ background: color }} />;
}

// Helper: get icon for kind
function KindIcon({ kind, size = 14 }: { kind: "photo" | "video" | "raw"; size?: number }) {
  return <span dangerouslySetInnerHTML={{ __html: getKindIcon(kind, 14) }} />;
}

/**
 * Apply the item's saved edit draft to a preview image. Passing the shared map
 * keeps this synchronous and avoids a localStorage read per tile.
 */
function draftImageStyle(transforms: Map<string, DraftTransform> | undefined, itemId: string) {
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
import type { MediaItem, MediaKind } from "../engine/types/media";
import type { LibraryFolder } from "../engine/types/commands";
import { SettingsScreen } from "../design/components/SettingsScreen";
import { SourcesManager } from "../design/components/SourcesManager";
import { SlideshowOverlay } from "../design/components/SlideshowOverlay";
import { ContextMenu } from "../design/components/ContextMenu";
import { BrandMark } from "../design/components/BrandMark";
import { GearIcon, SunIcon, MoonIcon, LibraryIcon, AlbumsIcon, ViewerIcon, DuplicatesIcon, EditIcon, BatchIcon, SearchIcon, PlusIcon, MinusIcon, MoreIcon, InspectorIcon, FolderIcon, GridIcon, OverviewIcon, DetailsIcon, TimelineIcon, HeartIcon, EyeIcon, EyeOffIcon, FullscreenIcon, RotateIcon, CropIcon, FlipIcon, PlayIcon, PauseIcon, SparkleIcon, UsersIcon, TagIcon, ImageOffIcon, ShareIcon, CheckIcon, StopIcon, TrashIcon, VolumeIcon } from "../design/components/icons";

type Screen = "Library" | "Albums" | "Viewer" | "Duplicates" | "Edit" | "Batch" | "Hidden" | "Settings";

const initialEdits = { exposure: 0, contrast: 0, warmth: 0, shadows: 0, highlights: 0, saturation: 0, rotation: 0, flip: false };

const MEDIA_EXTENSIONS = [
  "avif", "bmp", "gif", "heic", "heif", "jfif", "jpe", "jpeg", "jpg", "jxl", "png", "tif", "tiff", "webp",
  "3fr", "ari", "arw", "bay", "cap", "cr2", "cr3", "dcs", "dcr", "dng", "drf", "eip", "erf", "fff", "gpr", "iiq", "k25", "kdc", "mdc", "mef", "mos", "mrw", "nef", "nrw", "obm", "orf", "pef", "ptx", "pxn", "r3d", "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f",
  "m4v", "mov", "mp4", "mpeg", "mpg", "webm",
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
  return /failed|could not|cannot access|not a folder|could not read|no media files found|no supported media/i.test(text);
}

/** Modifier glyph for the "focus search" hint - Command on macOS, Ctrl elsewhere. */
function searchShortcutLabel(): string {
  if (typeof navigator === "undefined") return "⌘F";
  // `userAgentData` is not in the default TS lib yet, so read it defensively.
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘F" : "Ctrl F";
}

function App() {
  const [screen, setScreen] = useState<Screen>("Library");
  // Context menu state (declared here because the component references it in
  // JSX but it was previously an implicit global, which left the render blank).
  const [contextMenu, setContextMenu] = useState<{ items: any[]; x: number; y: number } | null>(null);
  const systemDark = useSystemDark();
  const appearance = useSettingsStore((s) => s.appearance);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  // Resolved appearance: the user's choice, or the OS setting when "system".
  const dark = appearance === "dark" || (appearance === "system" && systemDark);
  const [albumDialogOpen, setAlbumDialogOpen] = useState(false);
  const [albumDialogMode, setAlbumDialogMode] = useState<"create" | "rename">("create");
  const [albumName, setAlbumName] = useState("");
  const [albumSeedIds, setAlbumSeedIds] = useState<string[] | null>(null);
  const [renamingAlbumId, setRenamingAlbumId] = useState<string | null>(null);
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const albumInputRef = useRef<HTMLInputElement | null>(null);

  const [albumPendingDelete, setAlbumPendingDelete] = useState<any | null>(null);
  const [itemPendingDeleteCount, setItemPendingDeleteCount] = useState<number>(0);
  const itemPendingDeleteRef = useRef<string[] | null>(null);
  const [albumRemovePending, setAlbumRemovePending] = useState<{ albumId: string; itemIds: string[] } | null>(null);
  const [deletingAlbum, setDeletingAlbum] = useState(false);

  // Removing a folder is confirmed through its own dialog so a stray click in
  // the sidebar can never drop a chunk of the library.
  const [folderPendingRemove, setFolderPendingRemove] = useState<LibraryFolder | null>(null);
  const [removingFolder, setRemovingFolder] = useState(false);
  const [sourcesSheetOpen, setSourcesSheetOpen] = useState(false);
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
  const importPathsIntoAlbumRef = useRef<(paths: string[], albumId: string) => Promise<void>>(async () => {});

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
        ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !el.hasAttribute("disabled"));
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
  }, [settingsHydrated, screen, defaultLayout, library.activeAlbum, library.setLayout]);

  // Sidebar summary in one pass. The rows used to run a filter + reduce over
  // the whole library each, i.e. a dozen scans per render, which is costly at
  // 10k+ items and made every unrelated state change feel slow.
  const libraryStats = useMemo(() => {
    const stats = {
      photos: 0, videos: 0, raws: 0, favorites: 0, hidden: 0,
      photoSize: 0, videoSize: 0, rawSize: 0, favoriteSize: 0, hiddenSize: 0, totalSize: 0,
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
      if (item.favorite) { stats.favorites += 1; stats.favoriteSize += item.size; }
      if (item.kind === "photo") { stats.photos += 1; stats.photoSize += item.size; }
      else if (item.kind === "video") { stats.videos += 1; stats.videoSize += item.size; }
      else if (item.kind === "raw") { stats.raws += 1; stats.rawSize += item.size; }
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
  const [frozenViewerItem, setFrozenViewerItem] = useState<MediaItem | null>(null);
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
    if (host) (host as HTMLElement & { inert: boolean }).inert = screen !== "Viewer";
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
  const dragCandidateRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const preFillSizeRef = useRef<{ width: number; height: number } | null>(null);

  const beginTopbarDrag = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, select, textarea, [role='button'], [data-no-drag]")) return;
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
      getCurrentWindow().startDragging().catch(() => {});
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
    if (target?.closest("button, a, input, select, textarea, [role='button']")) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const win = getCurrentWindow();
      const monitor = await currentMonitor();
      if (!monitor) return;
      const work = monitor.workArea ?? { position: monitor.position, size: monitor.size };
      const scale = monitor.scaleFactor || 1;
      const workWidth = work.size.width / scale;
      const workHeight = work.size.height / scale;
      const outer = await win.outerSize();
      const filled = outer.width >= work.size.width - 8 && outer.height >= work.size.height - 8;

      if (filled) {
        const saved = preFillSizeRef.current;
        const width = saved?.width && saved.width < workWidth - 40 ? saved.width : Math.min(1280, workWidth - 80);
        const height = saved?.height && saved.height < workHeight - 40 ? saved.height : Math.min(852, workHeight - 80);
        await win.setSize(new LogicalSize(width, height));
        await win.center();
        preFillSizeRef.current = null;
      } else {
        const inner = await win.innerSize();
        const outerBefore = await win.outerSize();
        const chromeHeight = Math.max(0, (outerBefore.height - inner.height) / scale);
        preFillSizeRef.current = { width: inner.width / scale, height: inner.height / scale };
        await win.setPosition(new PhysicalPosition(work.position.x, work.position.y));
        await win.setSize(new LogicalSize(Math.max(1, workWidth - 2), Math.max(1, workHeight - chromeHeight - 2)));
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
        const work = monitor.workArea ?? { position: monitor.position, size: monitor.size };
        const outer = await win.outerSize();
        const pos = await win.outerPosition();
        const filled = outer.width >= work.size.width - 8 && outer.height >= work.size.height - 8;

        if (filled) {
          wasFilled = true;
          const maxX = Math.max(work.position.x, work.position.x + work.size.width - outer.width);
          const maxY = Math.max(work.position.y, work.position.y + work.size.height - outer.height);
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
    if (path.startsWith("blob:") || path.startsWith("data:") || path.startsWith("http")) return path;
    try {
      return convertFileSrc(path);
    } catch {
      return path;
    }
  }, []);

  // Latest render values, so long-lived event handlers never read stale stores.
  const liveRef = useRef({ library, viewer, edit, settings, screen, viewerOrigin, albumDialogOpen, albumPickerOpen, albumPendingDelete, itemPendingDeleteCount, folderPendingRemove, sourcesSheetOpen });
  liveRef.current = { library, viewer, edit, settings, screen, viewerOrigin, albumDialogOpen, albumPickerOpen, albumPendingDelete, itemPendingDeleteCount, folderPendingRemove, sourcesSheetOpen };

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
      await register("menu-open-folder", () => handlersRef.current.importFolder());
      await register("menu-import-files", () => handlersRef.current.importFiles());
      await register("menu-export", () => handlersRef.current.showNotice("Export - coming soon"));
      await register("menu-toggle-sidebar", () => liveRef.current.library.toggleSidebar());
      await register("menu-toggle-inspector", () => liveRef.current.library.toggleInspector());
      await register("menu-zoom-in", () => liveRef.current.viewer.zoomIn());
      await register("menu-zoom-out", () => liveRef.current.viewer.zoomOut());
      await register("menu-about", () => handlersRef.current.showNotice("VistoGallery v0.1.1 - Native macOS Photo Gallery"));
      await register("menu-check-updates", () => handlersRef.current.showNotice("Check for updates - coming soon"));

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
      unlisteners.push(unlistenProgress);
    };
    listen();

    // Keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      const { library, viewer, screen, viewerOrigin, albumDialogOpen, albumPickerOpen, albumPendingDelete, itemPendingDeleteCount, folderPendingRemove, sourcesSheetOpen } = liveRef.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // A slideshow owns the keyboard while it is open: its overlay handles
      // Escape/arrows/Space itself, and nothing underneath should react.
      if (useSlideshowStore.getState().isOpen) return;

      // While a modal is open, every key belongs to it (the dialogs own Enter
      // and Escape) instead of the global shortcut map.
      if (albumDialogOpen || albumPickerOpen || albumPendingDelete || itemPendingDeleteCount > 0 || folderPendingRemove || sourcesSheetOpen) return;

      if (mod && key === "o") { e.preventDefault(); handlersRef.current.importFolder(); return; }
      if (mod && key === "i") { e.preventDefault(); handlersRef.current.importFiles(); return; }
      if (mod && key === "e") { e.preventDefault(); handlersRef.current.showNotice("Export - coming soon"); return; }
      if (mod && e.key === "\\") { e.preventDefault(); library.toggleSidebar(); return; }
      if (mod && e.altKey && key === "i") { e.preventDefault(); library.toggleInspector(); return; }
      if (mod && key === "a") {
        const target = e.target as HTMLElement;
        const isEditable = target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
        if (!isEditable && (screen === "Library" || screen === "Hidden" || screen === "Albums")) {
          e.preventDefault();
          const items = screen === "Hidden" ? library.hiddenItems : library.visibleItems;
          const selectedSet = new Set(library.selectedIds);
          const allSelected = items.length > 0 && items.every((item: any) => selectedSet.has(item.id));
          library.setSelectedIds(allSelected ? [] : items.map((item: any) => item.id));
          return;
        }
      }
      if (mod && key === "f") {
        const target = e.target as HTMLElement;
        const isEditable = target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
        if (!isEditable) {
          e.preventDefault();
          const focusSearch = () => {
            const input = searchInputRef.current
              || (document.querySelector(".search-field input") as HTMLInputElement | null);
            input?.focus();
            input?.select();
          };
          // Both the Library and Hidden screens own a search field. Jump to
          // Library only when neither is on screen, then focus once mounted.
          if (screen !== "Library" && screen !== "Hidden") {
            setScreen("Library");
            let attempts = 0;
            const tryFocus = () => {
              const input = searchInputRef.current
                || (document.querySelector(".search-field input") as HTMLInputElement | null);
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
        const isEditable = target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
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
      if (e.key === "Enter" && mod && screen === "Hidden" && library.inspectedId) {
        // HiddenScreen owns the reveal confirmation, so route the shortcut
        // through it instead of opening the viewer directly.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("mac-gallery:open-hidden", { detail: { id: library.inspectedId } }));
        return;
      }
      if (e.key === "Enter" && mod && screen === "Library" && library.inspectedId) {
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

  const showNotice = useCallback((text: string) => {
    library.showNotice(text);
  }, [library]);

  // Single entry point for "open this item in the player". Used by tiles, the
  // inspector and by Play on a video-only selection.
  const openViewer = useCallback((id?: string, origin: Screen = "Library", scope: "library" | "hidden" = "library") => {
    setViewerOrigin(origin);
    library.setViewerScope(scope);
    viewer.open(id);
    setScreen("Viewer");
  }, [library, viewer]);

  // Slideshow is a mode over the current context, not a separate screen:
  // play the selection when there is one, otherwise the collection on screen
  // (album, folder, filter or search results).
  const playSlideshow = useCallback((ids?: string[]) => {
    const selection = ids && ids.length ? new Set(ids) : null;
    // A selection is authoritative: play every selected item, even one the
    // current filter/album is not showing. Ordering follows the grid for the
    // items on screen, then appends the rest so nothing selected is dropped.
    const visibleSelection = selection
      ? library.visibleItems.filter((item: MediaItem) => selection.has(item.id))
      : [];
    const visibleSelectionIds = new Set(visibleSelection.map((item) => item.id));
    const offscreenSelection = selection
      ? library.items.filter((item: MediaItem) => selection.has(item.id) && !visibleSelectionIds.has(item.id))
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
      openViewer(scope[0].id);
      return;
    }
    // Close any open viewer so its media can't keep playing underneath the show.
    if (viewer.isOpen) {
      viewer.close();
      setScreen(viewerOrigin || "Library");
    }
    // Pause any other playing videos (e.g. inspector preview) to avoid parallel audio.
    document.querySelectorAll("video").forEach((v) => { try { v.pause(); } catch {} });
    // Read the action off the store instead of subscribing to it: advancing
    // slides should only re-render the overlay, never the whole app.
    // An explicit selection starts at its first item; only the no-selection
    // case resumes from whatever was last inspected, so a video that was
    // playing in the background cannot hijack the start of a new selection.
    startConfiguredSlideshow(scope, selection ? null : library.inspectedId);
  }, [library.items, library.visibleItems, library.inspectedId, showNotice, viewer, viewerOrigin, openViewer]);

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
        `Could not ${albumDialogMode === "rename" ? "rename" : "create"} album: ${describeError(error)}`
      );
    } finally {
      setCreatingAlbum(false);
    }
  };

  const openAlbumPicker = useCallback((itemIds?: string[]) => {
    const ids = (itemIds && itemIds.length ? itemIds : library.selectedIds).filter(Boolean);
    if (!ids.length) {
      showNotice("Select photos first, then add them to an album.");
      return;
    }
    setAlbumPickerItemIds(ids);
    setAlbumSearch("");
    setAlbumPickerOpen(true);
  }, [library.selectedIds, showNotice]);

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
      await library.removeFromAlbum(albumRemovePending.albumId, albumRemovePending.itemIds);
      showNotice(`Removed ${albumRemovePending.itemIds.length} item${albumRemovePending.itemIds.length === 1 ? "" : "s"} from album.`);
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
        showNotice(`Moved ${ids.length.toLocaleString()} item${ids.length === 1 ? "" : "s"} to Trash.`);
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
      showNotice(`Deleted album "${albumPendingDelete.name}". Your photos remain in the library.`);
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
          : `Removed empty folder “${folderPendingRemove.name}” from VistoGallery.`
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
      showNotice(`Importing ${paths.length.toLocaleString()} file(s) into "${album.name}"…`);
      library.setBusy(true);
      library.setProgress({ phase: "importing", processed: 0, total: paths.length });
      const result = await tauri.library.importFiles(paths);
      if (result.cancelled) {
        if (result.items.length) await tauri.albums.addItems(albumId, result.items.map((item: any) => item.id));
        await library.loadLibrary();
        library.setActiveAlbum(albumId);
        library.setBusy(false);
        library.setProgress(null);
        showNotice(`Import cancelled. Kept ${result.items.length.toLocaleString()} item(s) already imported.`);
        return;
      }
      if (!result.items.length) {
        library.setBusy(false);
        library.setProgress(null);
        showNotice("No supported media files selected.");
        return;
      }
      await tauri.albums.addItems(albumId, result.items.map((item: any) => item.id));
      await library.loadLibrary();
      library.setActiveAlbum(albumId);
      library.setBusy(false);
      library.setProgress(null);
      library.setFilter("All");
      setScreen("Library");
      showNotice(
        `Added ${result.items.length.toLocaleString()} ${result.items.length === 1 ? "item" : "items"} to "${album.name}".`
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
        { label: "Delete Album…", danger: true, onClick: () => setAlbumPendingDelete(album) },
      ],
      e
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
      const inspected = library.items.find((i: MediaItem) => i.id === library.inspectedId);
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
      const inspected = library.items.find((i: MediaItem) => i.id === library.inspectedId);
      if (inspected?.hidden) library.inspectItem(null);
    }
    if (next === "Edit") {
      const selectedItem = library.items.find(i => i.id === library.inspectedId);
      if (selectedItem && selectedItem.kind === "photo") {
        edit.open(selectedItem);
      }
    }
    setScreen(next);
  };

  const navigatePhoto = (delta: number) => {
    if (library.playableItems.length === 0) return;
    const nextIndex = (library.currentIndex + delta + library.playableItems.length) % library.playableItems.length;
    // Arrow keys move inspection only - the multi-selection survives.
    library.inspectItem(library.playableItems[nextIndex].id);
  };


const importFiles = async () => {
  let paths: string[];
  try {
    const selected = await openFileDialog({
      directory: false,
      multiple: true,
      filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS }]
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
    library.setProgress({ phase: "importing", processed: 0, total: paths.length });
    const result = await tauri.library.importFiles(paths);
    await library.loadLibrary();
    library.setBusy(false);
    library.setProgress(null);
    showNotice(
      result.cancelled
        ? `Import cancelled. Kept ${result.items.length.toLocaleString()} item(s) already imported.`
        : result.items.length
        ? `Imported ${result.items.length.toLocaleString()} file(s).`
        : "No supported media files selected."
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
  const rootPaths = [...new Set(selectedPaths)].sort().filter((path, _index, all) =>
    !all.some((parent) => parent !== path && path.startsWith(`${parent.replace(/\/$/, "")}/`))
  );

  try {
    showNotice(`Scanning ${rootPaths.length.toLocaleString()} source folder(s)…`);
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
    showNotice(cancelled
      ? `Scan cancelled. Indexed ${discoveredCount.toLocaleString()} file(s) so far; you can resume by scanning these sources again.`
      : discoveredCount
        ? `Found ${discoveredCount.toLocaleString()} ${discoveredCount === 1 ? "media file" : "media files"} across ${rootPaths.length.toLocaleString()} source folder(s).`
        : "No media files found in the selected folders.");
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
      library.setProgress({ phase: "scanning", processed: 0, total: 1, currentFile: folder.path });
      const result = await tauri.library.scan(folder.path, true);
      await library.loadLibrary();
      await library.loadFolders();
      library.setProgress(null);
      library.setBusy(false);
      showNotice(result?.cancelled ? `Rescan cancelled for ${folder.name}.` : `Rescanned ${folder.name}.`);
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
    showNotice(cancelled
      ? `Rescan cancelled. ${totalDiscovered.toLocaleString()} ${totalDiscovered === 1 ? "item" : "items"} processed from completed sources.`
      : `Sources rescanned. ${totalDiscovered.toLocaleString()} ${totalDiscovered === 1 ? "item" : "items"} processed.`);
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
      <a className="skip-to-content" href="#main-content">Skip to main content</a>
      <header className="topbar" onMouseDown={beginTopbarDrag} onDoubleClick={handleTopbarDoubleClick}>
        <div className="topbar-brand"><BrandMark size={26} /><b>VistoGallery</b></div>
        <div className="topbar-context">
          {(() => {
            const activeAlbumRecord = library.activeAlbum
              ? library.albums.find((a: any) => a.id === library.activeAlbum)
              : null;
            const activeAlbumName = library.activeAlbum ? activeAlbumRecord?.name : null;
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
              {library.progress?.phase === "hashing" ? "Checking duplicates…" : library.progress?.phase === "reading" ? "Loading library…" : "Indexing…"}
            </span>
          )}
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button"
            type="button"
            aria-label={library.sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-pressed={library.sidebarOpen}
            title={library.sidebarOpen ? "Hide sidebar (⌥⌘S)" : "Show sidebar (⌥⌘S)"}
            onClick={() => library.toggleSidebar()}
          >
            <LibraryIcon size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={screen !== "Library" && screen !== "Hidden"
              ? "Inspector available in Library and Hidden"
              : (library.showInspector ? "Hide inspector" : "Show inspector")}
            aria-pressed={(screen === "Library" || screen === "Hidden") && library.showInspector}
            disabled={screen !== "Library" && screen !== "Hidden"}
            title={screen === "Library" || screen === "Hidden"
              ? (library.showInspector ? "Hide inspector (⌥⌘I)" : "Show inspector (⌥⌘I)")
              : "Inspector is available in Library and Hidden"}
            onClick={() => library.toggleInspector()}
          >
            <InspectorIcon size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={dark ? "Switch to light appearance" : "Switch to dark appearance"}
            title={dark ? "Switch to light appearance" : "Switch to dark appearance"}
            onClick={() => settings.update("appearance", dark ? "light" : "dark")}
          >
            {dark ? <SunIcon size={18} /> : <MoonIcon size={18} />}
          </button>
          <button className="icon-button" type="button" aria-label="Settings" title="Settings" onClick={() => openScreen("Settings")}>
            <GearIcon size={18} />
          </button>
        </div>
      </header>

      <div className={`app-body ${library.sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
        <aside className="sidebar">
          <div className="sidebar-scroll">
          <div className="sidebar-header">
            <div className="sidebar-label">WORKSPACE</div>
            <nav className="primary-nav" aria-label="Main navigation">
              {[
                { label: "Library", Icon: LibraryIcon, screen: "Library" as Screen },
                { label: "Albums", Icon: AlbumsIcon, screen: "Albums" as Screen },
                { label: "Viewer", Icon: ViewerIcon, screen: "Viewer" as Screen },
                { label: "Duplicates", Icon: DuplicatesIcon, screen: "Duplicates" as Screen },
                { label: "Edit", Icon: EditIcon, screen: "Edit" as Screen },
                { label: "Batch", Icon: BatchIcon, screen: "Batch" as Screen },
                { label: "Hidden", Icon: EyeOffIcon, screen: "Hidden" as Screen },
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
                  <span className="nav-icon"><Icon size={18} /></span>
                  <span>{label}</span>
                  {(label === "Library" && library.items.length - library.hiddenCount > 0) ||
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
              <span className="sources-entry-icon"><FolderIcon size={16} /></span>
              <span className="sources-entry-text">
                <span className="sources-entry-name">Sources</span>
                <span className="sources-entry-count">
                  {library.folders.length === 0
                    ? "No sources yet"
                    : `${library.folders.length.toLocaleString()} folder${library.folders.length === 1 ? "" : "s"} · ${library.folders.reduce((total: number, folder: LibraryFolder) => total + folder.itemCount, 0).toLocaleString()} items`}
                </span>
              </span>
              <span className="sources-entry-action">
                <span className="sources-entry-chevron" aria-hidden="true">›</span>
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
                  <span className="stat-size">· {formatBytesSimple(libraryStats.photoSize)}</span>
                </span>
              </div>
              <div className="stat-row">
                <KindDot kind="video" />
                <span className="stat-label">Videos</span>
                <span className="stat-value">
                  {libraryStats.videos.toLocaleString()}
                  <span className="stat-size">· {formatBytesSimple(libraryStats.videoSize)}</span>
                </span>
              </div>
              <div className="stat-row">
                <KindDot kind="raw" />
                <span className="stat-label">RAW</span>
                <span className="stat-value">
                  {libraryStats.raws.toLocaleString()}
                  <span className="stat-size">· {formatBytesSimple(libraryStats.rawSize)}</span>
                </span>
              </div>
              <div className="stat-row">
                <KindDot kind="photo" />
                <span className="stat-label">Favorites</span>
                <span className="stat-value">
                  {libraryStats.favorites.toLocaleString()}
                  <span className="stat-size">· {formatBytesSimple(libraryStats.favoriteSize)}</span>
                </span>
              </div>
              <div className="stat-row hidden">
                <KindDot kind="photo" />
                <span className="stat-label">Hidden</span>
                <span className="stat-value">
                  {libraryStats.hidden.toLocaleString()}
                  <span className="stat-size">· {formatBytesSimple(libraryStats.hiddenSize)}</span>
                </span>
              </div>
              <div className="stat-row size">
                <span className="stat-label">Total</span>
                <span className="stat-value">
                  {(library.items.length - library.hiddenCount).toLocaleString()} · {formatBytesSimple(libraryStats.totalSize)}
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
            <span className="sidebar-version">v0.1.1</span>
          </div>
        </aside>

        <main id="main-content" className="main-content" tabIndex={-1}>
          {screen === "Library" && <LibraryScreen
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
            onOpenAlbumPicker={(itemIds?: string[]) => openAlbumPicker(itemIds)}
            onAlbumMenu={(e: React.MouseEvent) => {
              const album = library.albums.find((a: any) => a.id === library.activeAlbum);
              if (album) openAlbumMenu(album, e);
            }}
            albumDragOver={albumDragOver}
            onToggleFavorite={library.toggleFavorite}
            onToggleHidden={library.toggleHidden}
            onSetFavoriteForIds={library.setFavoriteForIds}
            onSetHiddenForIds={library.setHiddenForIds}
            onUpdateTags={library.updateItemTags}
            onDeleteItems={library.deleteItems}
            onRequestDeleteItems={(ids: string[]) => { itemPendingDeleteRef.current = ids; setItemPendingDeleteCount(ids.length); }}
            onRequestRemoveFromAlbum={(albumId: string, itemIds: string[]) => setAlbumRemovePending({ albumId, itemIds })}
            onOpenViewer={(id?: string) => openViewer(id, "Library")}
            onOpenEdit={(item: any) => { edit.open(item); setScreen("Edit"); }}
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
          />}

          {screen === "Albums" && <AlbumsScreen
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
          />}

          {(screen === "Viewer" || viewer.isOpen) && (
            <div
              ref={viewerHostRef}
              className={`viewer-host${screen === "Viewer" ? "" : " viewer-host-hidden"}`}
              aria-hidden={screen !== "Viewer"}
            >
              <ViewerScreen
                active={screen === "Viewer"}
                items={library.viewerItems}
                selected={screen === "Viewer" ? library.viewerSelected : (frozenViewerItem ?? lastViewerItemRef.current)}
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
                onOpenEdit={(item: any) => { edit.open(item); setScreen("Edit"); }}
                onContextMenu={openContextMenu}
                assetUrl={assetUrl}
              />
            </div>
          )}

          {screen === "Edit" && <EditScreen
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
              const sourceExtension = String(item.extension || item.name.split(".").pop() || "").toLowerCase();
              if (inPlace) {
                if (!(["jpg", "jpeg", "png", "webp"].includes(sourceExtension))) {
                  showNotice("Replace original supports JPEG, PNG, and WebP. Save a copy instead.");
                  return;
                }
                }
              try {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.src = assetUrl(item.path);
                await new Promise((res, rej) => { img.onload = () => res(null); img.onerror = rej; });
              const v = edit.values || {};
              const crop = edit.crop || { enabled: false, x:0,y:0,width:1,height:1 };
              const useCrop = !!crop.enabled;
               if (useCrop && (((v.rotation || 0) % 360) !== 0 || !!v.flip)) {
                 showNotice("Crop cannot be combined with rotation or flip. Reset transforms first.");
                 return;
               }
              const srcX = useCrop ? crop.x * img.naturalWidth : 0;
              const srcY = useCrop ? crop.y * img.naturalHeight : 0;
              const srcW = useCrop ? crop.width * img.naturalWidth : img.naturalWidth;
              const srcH = useCrop ? crop.height * img.naturalHeight : img.naturalHeight;
              const rot = ((v.rotation || 0) % 360 + 360) % 360;
              const swap = rot === 90 || rot === 270;
              const baseW = srcW;
              const baseH = srcH;
              const canvas = document.createElement("canvas");
              canvas.width = swap ? baseH : baseW;
              canvas.height = swap ? baseW : baseH;
              const ctx = canvas.getContext("2d");
              if (!ctx) { showNotice("Export failed"); return; }
              ctx.translate(canvas.width / 2, canvas.height / 2);
              ctx.rotate((rot * Math.PI) / 180);
              ctx.scale(v.flip ? -1 : 1, 1);
              const warmth = Number(v.warmth || 0);
              ctx.filter = "none";
              ctx.drawImage(img, srcX, srcY, srcW, srcH, -baseW / 2, -baseH / 2, baseW, baseH);
              // Manual color adjustments (WebKit-compatible fallback; avoids ctx.filter gaps).
              try {
                const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const d = imgData.data;
                const brightness = 100 + (v.exposure || 0) + (v.shadows || 0) * 0.22 + (v.highlights || 0) * 0.1;
                const contrast = 100 + (v.contrast || 0) - (v.shadows || 0) * 0.08 + (v.highlights || 0) * 0.12;
                const saturation = 100 + (v.saturation || 0);
                const bf = brightness / 100;
                const cf = contrast / 100;
                const sf = saturation / 100;
                for (let i = 0; i < d.length; i += 4) {
                  let r = d[i], g = d[i+1], b = d[i+2];
                  r *= bf; g *= bf; b *= bf;
                  r = (r - 128) * cf + 128;
                  g = (g - 128) * cf + 128;
                  b = (b - 128) * cf + 128;
                  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                  r = gray + (r - gray) * sf;
                  g = gray + (g - gray) * sf;
                  b = gray + (b - gray) * sf;
                  if (warmth > 0) { r += warmth * 0.3; b -= warmth * 0.3; }
                  else if (warmth < 0) { b += -warmth * 0.3; r -= -warmth * 0.3; }
                  d[i] = Math.max(0, Math.min(255, r));
                  d[i+1] = Math.max(0, Math.min(255, g));
                  d[i+2] = Math.max(0, Math.min(255, b));
                }
                ctx.putImageData(imgData, 0, 0);
              } catch (e) { /* ignore */ }
                const outputType = inPlace
                  ? sourceExtension === "png" ? "image/png" : sourceExtension === "webp" ? "image/webp" : "image/jpeg"
                  : "image/jpeg";
                const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, outputType, 0.92));
                if (!blob) { showNotice("Export failed"); return; }
                if (inPlace && blob.type !== outputType) {
                  showNotice("This image format cannot be preserved here. Save a copy instead.");
                  return;
                }
                let path: any;
                if (inPlace) {
                  path = item.path;
                } else {
                  path = await save({
                    defaultPath: String(item.name).replace(/\.[^.]+$/, "") + "_edited.jpg",
                    filters: [{ name: "JPEG image", extensions: ["jpg", "jpeg"] }],
                  });
                  if (!path) { showNotice("Export cancelled"); return; }
                }
                const buf = await blob.arrayBuffer();
                const suggestedName = String(item.name).replace(/\.[^.]+$/, "") + (inPlace ? "" : "_edited") + ".jpg";
                await tauri.app.exportBytes(suggestedName, new Uint8Array(buf), inPlace);
                clearEditDraft(item.id);
                if (inPlace) await library.loadLibrary();
                showNotice(inPlace ? "Replaced original" : "Exported edited copy");
              } catch (e) {
                showNotice("Export failed");
              }
            }}
            onClearDraft={edit.clearDraft}
            onNotice={showNotice}
            assetUrl={assetUrl}
            items={library.items.filter((i: any) => i.kind === "photo" && !i.hidden)}
            onOpenEdit={(item: any) => { edit.saveDraft(); edit.open(item); }}
          />}

          {screen === "Batch" && <BatchScreen
            items={library.items.filter((i: any) => library.selectedIds.includes(i.id))}
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
              const folder = await openFileDialog({ directory: true, multiple: false, title: "Choose export folder" });
              if (typeof folder === "string") batch.setOutputFolder(folder);
            }}
            onOpenFolder={() => { if (batch.outputFolder) tauri.items.openFolder(batch.outputFolder); }}
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
          />}

          {screen === "Hidden" && <HiddenScreen
            assetUrl={assetUrl}
            searchInputRef={searchInputRef}
            onContextMenu={openContextMenu}
            onNavigate={openScreen}
            onCreateAlbum={openAlbumDialog}
            onOpenAlbumPicker={(itemIds?: string[]) => openAlbumPicker(itemIds)}
            onRequestDeleteItems={(ids: string[]) => { itemPendingDeleteRef.current = ids; setItemPendingDeleteCount(ids.length); }}
            onOpenEdit={(item: any) => { edit.open(item); setScreen("Edit"); }}
            onOpenViewer={(id?: string) => openViewer(id, "Hidden", "hidden")}
          />}


          {screen === "Duplicates" && <DuplicatesScreen
            groups={library.duplicates}
            items={library.items}
            onScan={library.scanDuplicates}
            onClear={library.clearDuplicates}
            busy={library.busy}
            assetUrl={assetUrl}
            onRequestDeleteItems={(ids: string[]) => { itemPendingDeleteRef.current = ids; setItemPendingDeleteCount(ids.length); }}
            onHideIds={async (ids: string[]) => {
              if (!ids.length) return;
              library.showNotice(`Hiding ${ids.length.toLocaleString()} item(s)…`);
              await library.setHiddenForIds(ids, true);
              library.showNotice(`Hidden ${ids.length.toLocaleString()} item(s).`);
              await library.scanDuplicates();
            }}
          />}

          {screen === "Settings" && <SettingsScreen
            onAddFolder={() => importFolder()}
            onRemoveFolder={(folder: LibraryFolder) => setFolderPendingRemove(folder)}
            onRescan={() => { void rescanSources(); }}
            onRescanFolder={(folder) => { void rescanSource(folder); }}
          />}
        </main>
      </div>

      {library.busy && library.progress && (
        <div className={`busy-indicator ${library.progress.phase === "hashing" ? "busy-indicator-hashing" : ""}`} role="status">
          <span className="spinner" />
          {library.progress.phase === "hashing" ? (() => {
            const bytesProcessed = library.progress.bytesProcessed ?? 0;
            const bytesTotal = library.progress.bytesTotal ?? 0;
            const filesProcessed = library.progress.filesProcessed ?? library.progress.processed;
            const filesTotal = library.progress.filesTotal ?? library.progress.total;
            const percent = bytesTotal > 0 ? Math.min(100, Math.round((bytesProcessed / bytesTotal) * 100)) : 0;
            return (
              <div className="busy-indicator-progress-copy">
                <b>
                  {bytesTotal > 0
                    ? `Checking duplicates · ${percent}%`
                    : filesTotal > 0 ? "Hashing candidates…" : "Finding duplicate candidates…"}
                </b>
                <small>
                  {filesProcessed.toLocaleString()} of {filesTotal.toLocaleString()} candidate files
                  {bytesTotal > 0 && ` · ${formatBytesSimple(bytesProcessed)} of ${formatBytesSimple(bytesTotal)}`}
                </small>
                <div className="busy-indicator-progress-track" role="progressbar" aria-label="Duplicate scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                  <span style={{ width: `${percent}%` }} />
                </div>
                {library.progress.currentFile && <small className="busy-indicator-current-file" title={library.progress.currentFile}>{library.progress.currentFile}</small>}
              </div>
            );
          })() : library.progress.phase === "trashing" ? (() => {
            const processed = library.progress.processed ?? 0;
            const total = library.progress.total ?? 0;
            const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
            return (
              <div className="busy-indicator-progress-copy">
                <b>Moving to Trash · {percent}%</b>
                <small>{processed.toLocaleString()} of {total.toLocaleString()} files</small>
                <div className="busy-indicator-progress-track" role="progressbar" aria-label="Trash progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                  <span style={{ width: `${percent}%` }} />
                </div>
              </div>
            );
          })() : library.progress.phase === "reading" ? (() => (
            <div className="busy-indicator-progress-copy">
              <b>Loading library…</b>
              <small>Reading database</small>
              <div className="busy-indicator-progress-track" role="progressbar" aria-label="Loading library" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}>
                <span style={{ width: "0%" }} />
              </div>
            </div>
          ))() : library.progress.phase === "scanning" ? (() => {
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
            const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
            
            // Extract just the folder/file name from path
            const getName = (path: string) => path.split("/").pop() || path;
            
            if (isSourceLevel) {
              return (
                <div className="busy-indicator-progress-copy">
                  <b>Scanning source {processed + 1} of {total} · {percent}%</b>
                  <small>{library.progress.currentFile ? getName(library.progress.currentFile) : "Preparing…"}</small>
                  <div className="busy-indicator-progress-track" role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </div>
              );
            } else {
              // Show source folder + file progress in two lines
              const currentFileName = library.progress.currentFile
                ? library.progress.currentFile.split("/").pop() || library.progress.currentFile
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
                  <b>Scanning {sourceFolder} · {processed.toLocaleString()} of {total.toLocaleString()} · {percent}%</b>
                  <small>{currentFileName}</small>
                  <div className="busy-indicator-progress-track" role="progressbar" aria-label="File scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </div>
              );
            }
          })() : `${library.progress.phase} ${library.progress.processed}/${library.progress.total}`}
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
          <span aria-hidden="true">{isWarningNotice(library.notice) ? "!" : "✓"}</span>{library.notice}
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
                    const count = albumSeedIds?.length ?? (library.selectedIds.length || (library.inspectedId ? 1 : 0));
                    return count
                      ? `Adds ${count.toLocaleString()} item${count === 1 ? "" : "s"} to the new album.`
                      : "You can add photos to it from the library or an album at any time.";
                  })()}
            </p>
            <div className="dialog-actions">
              <button type="button" className="quiet-button" onClick={closeAlbumDialog} disabled={creatingAlbum}>
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={!albumName.trim() || creatingAlbum}>
                {creatingAlbum
                  ? albumDialogMode === "rename" ? "Saving…" : "Creating…"
                  : albumDialogMode === "rename" ? "Save name" : "Create album"}
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
            if (e.target === e.currentTarget && !addingToAlbumId) setAlbumPickerOpen(false);
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
              {albumPickerItemIds.length.toLocaleString()} selected item{albumPickerItemIds.length === 1 ? "" : "s"}
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

            <div className="album-picker-list" role="listbox" aria-label="Albums">
              {(() => {
                const selectedItems = library.items.filter((item: any) =>
                  albumPickerItemIds.includes(item.id)
                );
                const query = albumSearch.trim().toLowerCase();
                const matching = library.albums.filter((album: any) =>
                  !query || album.name.toLowerCase().includes(query)
                );
                if (!matching.length) {
                  return (
                    <div className="album-picker-empty">
                      <AlbumsIcon size={24} />
                      <b>{library.albums.length ? "No matching albums" : "No albums yet"}</b>
                      <p>
                        {library.albums.length
                          ? "Try a different search."
                          : "Create an album and these photos will be added to it."}
                      </p>
                    </div>
                  );
                }
                return matching.map((album: any, index: number) => {
                  const alreadyAdded = selectedItems.length > 0 && selectedItems.every((item: any) =>
                    item.albumIds?.includes(album.id)
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
                      <i className={`album-dot ${["coral", "violet", "blue", "green"][index % 4]}`} />
                      <span className="album-picker-name">{album.name}</span>
                      <span className="album-picker-count">
                        {alreadyAdded
                          ? "Already added"
                          : (() => {
                              const count = album.itemCount || 0;
                              return `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
                            })()}
                      </span>
                      {busy && <span className="spinner album-picker-spinner" />}
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
            if (e.target === e.currentTarget && !deletingAlbum) setAlbumPendingDelete(null);
          }}
        >
          <div
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
              Are you sure you want to delete <b>“{albumPendingDelete.name}”</b>?
            </p>
            <div className="delete-album-safety" id="delete-album-description">
              <span><AlbumsIcon size={19} /></span>
              <p>
                <b>Your photos are safe.</b> This only removes the album and its grouping.
                {" "}
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
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setItemPendingDeleteCount(0); itemPendingDeleteRef.current = null; } }}
        >
          <div className="album-dialog delete-album-dialog" role="alertdialog" aria-modal="true">
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">PHOTO</p>
                <h2>Delete Item?</h2>
              </div>
              <button type="button" className="dialog-close" aria-label="Close" onClick={() => { setItemPendingDeleteCount(0); itemPendingDeleteRef.current = null; }}>×</button>
            </div>
            <p className="delete-album-copy">
              Are you sure you want to delete <b>{itemPendingDeleteCount} item{itemPendingDeleteCount === 1 ? "" : "s"}</b>? They will be moved to Trash.
            </p>
            <div className="dialog-actions">
              <button type="button" className="quiet-button" onClick={() => { setItemPendingDeleteCount(0); itemPendingDeleteRef.current = null; }}>Cancel</button>
              <button type="button" className="danger-button" onClick={confirmDeleteItem}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {albumRemovePending && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setAlbumRemovePending(null); }}>
          <div className="album-dialog delete-album-dialog" role="alertdialog" aria-modal="true">
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">ALBUM</p>
                <h2>Remove from Album?</h2>
              </div>
              <button type="button" className="dialog-close" aria-label="Close" onClick={() => setAlbumRemovePending(null)}>×</button>
            </div>
            <p className="delete-album-copy">
              Remove {albumRemovePending.itemIds.length} item{albumRemovePending.itemIds.length === 1 ? "" : "s"} from this album?
            </p>
            <div className="dialog-actions">
              <button type="button" className="quiet-button" onClick={() => setAlbumRemovePending(null)}>Cancel</button>
              <button type="button" className="danger-button" onClick={confirmRemoveFromAlbum}>Remove</button>
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
              onRemoveFolder={(folder: LibraryFolder) => setFolderPendingRemove(folder)}
              onFilterSource={() => { setScreen("Library"); setSourcesSheetOpen(false); }}
              onRescan={() => { void rescanSources(); }}
             onRescanFolder={(folder) => { void rescanSource(folder); }}
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
            if (e.target === e.currentTarget && !removingFolder) setFolderPendingRemove(null);
          }}
        >
          <div
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
              <span><FolderIcon size={19} /></span>
              <p>
                <b>Your files are safe.</b>{" "}
                {folderPendingRemove.itemCount > 0
                  ? `This only unstages the folder and its ${folderPendingRemove.itemCount.toLocaleString()} item${folderPendingRemove.itemCount === 1 ? "" : "s"} from the library.`
                  : "This only removes the empty folder entry from the library."}{" "}
                Nothing is deleted from disk — import the folder again to bring it back.
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
function VideoThumb({ src, name, className }: { src: string; name?: string; className?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: "180px" });
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video || !nearViewport) return;
    const seek = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      try {
        video.currentTime = Math.min(0.15, duration / 2);
      } catch {
        /* seeking can fail on very short or broken files; the frame stays blank */
      }
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [src, nearViewport]);

  return (
    <video
      ref={ref}
      className={className}
      src={nearViewport ? src : undefined}
      title={name}
      muted
      playsInline
      preload={nearViewport ? "metadata" : "none"}
    />
  );
}

// Shared, size-aware thumbnail cache. Both the editor picker and the library
// grid used to request multi-megabyte originals; cached JPEGs make scrolling a
// large library cheap. Keys include the size because the backend caches each
// rendering separately.
const thumbnailCache = new Map<string, string>();
const thumbnailRequests = new Map<string, Promise<string>>();
const thumbnailQueue: Array<() => void> = [];
// Roughly one screenful of large tiles plus the editor picker. The DOM keeps
// mounted thumbnails alive on its own, so this only needs to cover navigation
// between views without holding the whole library in JS memory.
const THUMBNAIL_CACHE_LIMIT = 256;
const MAX_CONCURRENT_THUMBNAIL_REQUESTS = 6;
type CachedThumbnailSize = 64 | 128 | 256 | 512 | 1024;
let activeThumbnailRequests = 0;

function loadThumbnail(itemId: string, size: CachedThumbnailSize): Promise<string> {
  const key = `${itemId}:${size}`;
  const cached = thumbnailCache.get(key);
  if (cached) {
    // Refresh insertion order so the least recently used entry is evicted first.
    thumbnailCache.delete(key);
    thumbnailCache.set(key, cached);
    return Promise.resolve(cached);
  }
  const inFlight = thumbnailRequests.get(key);
  if (inFlight) return inFlight;

  const request = new Promise<string>((resolve, reject) => {
    thumbnailQueue.push(() => {
      activeThumbnailRequests += 1;
      void tauri.library.getThumbnail({ itemId, size }).then((response) => {
        thumbnailCache.set(key, response.dataUrl);
        if (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT) {
          const oldest = thumbnailCache.keys().next().value;
          if (oldest) thumbnailCache.delete(oldest);
        }
        resolve(response.dataUrl);
      }).catch(reject).finally(() => {
        thumbnailRequests.delete(key);
        activeThumbnailRequests -= 1;
        while (activeThumbnailRequests < MAX_CONCURRENT_THUMBNAIL_REQUESTS && thumbnailQueue.length) {
          thumbnailQueue.shift()?.();
        }
      });
    });
  });
  thumbnailRequests.set(key, request);
  while (activeThumbnailRequests < MAX_CONCURRENT_THUMBNAIL_REQUESTS && thumbnailQueue.length) {
    thumbnailQueue.shift()?.();
  }
  return request;
}

function CachedThumbnail({
  itemId,
  name,
  size,
  style,
  showStatus = false,
  placeholderClassName,
  fallbackSrc,
}: {
  itemId: string;
  name: string;
  size: CachedThumbnailSize;
  style?: React.CSSProperties;
  showStatus?: boolean;
  placeholderClassName?: string;
  fallbackSrc?: string;
}) {
  const placeholderRef = useRef<HTMLSpanElement | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const requestKey = `${itemId}:${size}`;
  // Never paint a thumbnail for a previous item or size while the new request
  // is in flight (e.g. switching the grid density or layout).
  const src = loaded?.key === requestKey ? loaded.src : null;
  const failed = failedKey === requestKey;

  useEffect(() => {
    const placeholder = placeholderRef.current;
    if (!placeholder) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    // Scrollable panels clip their contents, so observing against the viewport
    // would ignore the prefetch margin. Use the nearest panel as the root.
    const root = placeholder.closest(".library-grid-container, .edit-picker-grid");
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { root, rootMargin: "240px" });
    observer.observe(placeholder);
    return () => observer.disconnect();
  }, [itemId, size]);

  useEffect(() => {
    if (!nearViewport) return;
    let current = true;
    loadThumbnail(itemId, size).then((value) => {
      if (current) setLoaded({ key: requestKey, src: value });
    }).catch(() => {
      if (current) setFailedKey(requestKey);
    });
    return () => { current = false; };
  }, [itemId, size, nearViewport, requestKey]);

  if (failed && fallbackSrc) {
    return <img src={fallbackSrc} alt={name} loading="lazy" decoding="async" style={style} />;
  }
  if (src) {
    return <img src={src} alt={name} loading="lazy" decoding="async" fetchPriority="low" style={style} />;
  }
  return (
    <span
      ref={placeholderRef}
      className={`cached-thumb-placeholder${failed ? " is-failed" : " is-loading"}${placeholderClassName ? ` ${placeholderClassName}` : ""}`}
      aria-hidden="true"
    >
      {showStatus ? (failed ? "Preview unavailable" : nearViewport ? "Loading preview…" : "") : null}
    </span>
  );
}

function PickerThumbnail({ itemId, name, style }: { itemId: string; name: string; style?: React.CSSProperties }) {
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

function VideoPlayer({ itemId, active = true, src, name, onFullscreen, onNext }: { itemId: string; active?: boolean; src: string; name?: string; onFullscreen?: () => void; onNext?: () => void }) {
  const videoAutoPlay = useSettingsStore((s) => s.videoAutoPlay);
  const videoLoop = useSettingsStore((s) => s.videoLoop);
  const registerPlayback = usePlaybackStore((s) => s.register);
  const unregisterPlayback = usePlaybackStore((s) => s.unregister);
  const syncPlayback = usePlaybackStore((s) => s.sync);
  const ref = useRef<HTMLVideoElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [pip, setPip] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);

  // Expose this element to the mini-player that takes over when the user
  // navigates away from the Viewer. The viewer is kept mounted off-screen, so
  // the media element is never torn down during tab switches.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    registerPlayback(video, { itemId, name: name || "Video" });
    syncPlayback({
      playing: !video.paused,
      time: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      muted: video.muted,
      volume: video.volume,
    });
    return () => unregisterPlayback(video);
  }, [itemId, name, registerPlayback, unregisterPlayback, syncPlayback]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setVolume(1);
    setMuted(false);

    const onMetadata = () => {
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(nextDuration);
      try { video.currentTime = Math.min(0.15, (video.duration || 1) / 2); } catch { /* ignore */ }
      syncPlayback({
        duration: nextDuration,
        time: video.currentTime,
        playing: !video.paused,
      });
    };
    const onTimeUpdate = () => {
      setTime(video.currentTime);
      syncPlayback({ time: video.currentTime });
    };
    const onPlay = () => {
      setPlaying(true);
      syncPlayback({ playing: true });
    };
    const onPause = () => {
      setPlaying(false);
      syncPlayback({ playing: false });
    };

    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    if (video.readyState >= 1) onMetadata();
    return () => {
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [src, syncPlayback]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const onEnded = () => {
      if (autoAdvance && active && onNext) {
        // Auto-advance is a foreground affordance: background playback must
        // not silently navigate the library while another tab is on screen.
        onNext();
      } else {
        setPlaying(false);
        syncPlayback({ playing: false });
      }
    };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, [src, autoAdvance, active, onNext, syncPlayback]);

  // Pause the video when the viewer is torn down so the Tauri webview does not
  // keep media alive briefly while React removes the element. Navigation away
  // from the Viewer does not unmount it (see the viewer host in App).
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    return () => {
      if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
      video.pause();
    };
  }, []);

  // Keyboard shortcuts for video (when focused)
  const adjustVolume = useCallback((delta: number) => {
    setVolume((current) => {
      const next = Math.min(1, Math.max(0, current + delta));
      if (next > 0) setMuted(false);
      return next;
    });
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        seek(Math.max(0, video.currentTime - 5));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        seek(Math.min(video.duration || 0, video.currentTime + 5));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        adjustVolume(0.1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        adjustVolume(-0.1);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        e.stopPropagation();
        adjustVolume(0.1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        e.stopPropagation();
        adjustVolume(-0.1);
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        e.stopPropagation();
        onFullscreen?.();
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        e.stopPropagation();
        setMuted((m) => !m);
      }
    };
    video.addEventListener("keydown", handleKeyDown);
    return () => video.removeEventListener("keydown", handleKeyDown);
  }, [onFullscreen, adjustVolume]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setPipSupported(
      Boolean((document as any).pictureInPictureEnabled || (video as any).webkitSupportsPresentationMode?.("picture-in-picture"))
    );
    const onEnter = () => setPip(true);
    const onLeave = () => setPip(false);
    const onWebKitMode = () => setPip((video as any).webkitPresentationMode === "picture-in-picture");
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    video.addEventListener("webkitpresentationmodechanged", onWebKitMode);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
      video.removeEventListener("webkitpresentationmodechanged", onWebKitMode);
    };
  }, [src]);

  const togglePip = async () => {
    const video = ref.current;
    if (!video) return;
    try {
      const v = video as any;
      if (v.webkitSupportsPresentationMode?.("picture-in-picture")) {
        v.webkitSetPresentationMode(
          v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture"
        );
        return;
      }
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else if (typeof video.requestPictureInPicture === "function") {
        await video.requestPictureInPicture();
      }
    } catch (err) {
      console.warn("Picture-in-picture unavailable", err);
    }
  };

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
    syncPlayback({ volume, muted });
  }, [volume, muted, syncPlayback]);

  // Wire media keys / PiP transport controls to the player.
  useEffect(() => {
    const video = ref.current;
    if (!video || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({ title: name || "Video", artist: "VistoGallery" });
    const play = () => void video.play().catch(() => {});
    const pause = () => video.pause();
    const seekBy = (delta: number) => {
      const next = Math.min(Math.max(0, video.currentTime + delta), video.duration || 0);
      video.currentTime = next;
      setTime(next);
    };
    session.setActionHandler("play", play);
    session.setActionHandler("pause", pause);
    session.setActionHandler("seekbackward", (details) => seekBy(-(details?.seekOffset || 10)));
    session.setActionHandler("seekforward", (details) => seekBy(details?.seekOffset || 10));
    const onPlay = () => { session.playbackState = "playing"; };
    const onPause = () => { session.playbackState = "paused"; };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      session.setActionHandler("play", null);
      session.setActionHandler("pause", null);
      session.setActionHandler("seekbackward", null);
      session.setActionHandler("seekforward", null);
    };
  }, [src, name]);

  const toggle = () => {
    const video = ref.current;
    if (!video) return;
    if (video.paused) {
      if (video.ended) video.currentTime = 0;
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const seek = (value: number) => {
    const video = ref.current;
    if (!video) return;
    video.currentTime = value;
    setTime(value);
  };

  // A double-click means "fullscreen". Delay the single-click toggle briefly so
  // the second click of a double-click does not pause and resume the video.
  const handleVideoClick = () => {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      return;
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      toggle();
    }, 220);
  };

  return (
    <>
      <video ref={ref} className="viewer-video" src={src} title={name} autoPlay={videoAutoPlay} loop={videoLoop && !autoAdvance} playsInline preload="metadata" onClick={handleVideoClick} onDoubleClick={() => onFullscreen?.()} tabIndex={0} />
      {/* macOS hides a video's native control bar unless the pointer is over the
          frame, so playback gets a permanent bar of our own instead. */}
      <div className="viewer-video-controls">
        <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"}>
          {playing ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
        </button>
        <button
          type="button"
          onClick={() => setAutoAdvance((v) => !v)}
          aria-pressed={autoAdvance}
          aria-label="Auto-advance to the next item"
          title={autoAdvance ? "Auto-advance on: play the next item when this ends" : "Auto-advance off: stop at the end"}
        >
          {autoAdvance ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="5 4 15 12 5 20 5 4" />
              <line x1="19" y1="5" x2="19" y2="19" />
            </svg>
          ) : (
            <StopIcon size={14} />
          )}
        </button>
        <span className="video-time">{formatDuration(time)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={time}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Seek"
        />
        <span className="video-time">{formatDuration(duration)}</span>
        <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
          <VolumeIcon size={14} muted={muted || volume === 0} />
        </button>
        <button type="button" onClick={() => adjustVolume(-0.1)} aria-label="Volume down" title="Volume down">
          <MinusIcon size={12} />
        </button>
        <input
          type="range"
          className="video-volume"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            if (v > 0) setMuted(false);
          }}
          aria-label="Volume"
        />
        <button type="button" onClick={() => adjustVolume(0.1)} aria-label="Volume up" title="Volume up">
          <PlusIcon size={12} />
        </button>
        {pipSupported && (
          <button type="button" onClick={togglePip} aria-label={pip ? "Exit picture in picture" : "Picture in picture"} title="Picture in picture">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <rect x="12" y="12" width="8" height="6" fill={pip ? "currentColor" : "none"} />
            </svg>
          </button>
        )}
        {onFullscreen && (
          <button type="button" onClick={onFullscreen} aria-label="Full screen" title="Full screen"><FullscreenIcon size={14} /></button>
        )}
      </div>
    </>
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
function HiddenScreen(props: any) {
  const library = useLibraryStore();
  const filter = library.hiddenFilter;
  const query = library.hiddenQuery;
  const [pendingReveal, setPendingReveal] = useState<
    | { kind: "viewer"; id?: string }
    | { kind: "edit"; item: MediaItem }
    | { kind: "slideshow"; ids: string[] }
    | null
  >(null);

  const items = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return library.hiddenItems.filter((item: MediaItem) => {
      if (filter === "Photos" && item.kind !== "photo") return false;
      if (filter === "Videos" && item.kind !== "video") return false;
      if (filter === "RAW" && item.kind !== "raw") return false;
      if (filter === "Favorites" && !item.favorite) return false;
      if (!normalized) return true;
      return `${item.name} ${item.path} ${item.extension} ${item.kind} ${item.camera || ""} ${item.lens || ""} ${(item.tags || []).join(" ")}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [library.hiddenItems, filter, query]);

  useEffect(() => {
    const onOpenHidden = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      setPendingReveal({ kind: "viewer", id });
    };
    window.addEventListener("mac-gallery:open-hidden", onOpenHidden);
    return () => window.removeEventListener("mac-gallery:open-hidden", onOpenHidden);
  }, []);

  useEffect(() => {
    if (!pendingReveal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPendingReveal(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pendingReveal]);

  const requestViewer = (id?: string) => setPendingReveal({ kind: "viewer", id });
  const requestEdit = (item: MediaItem) => setPendingReveal({ kind: "edit", item });

  const requestSlideshow = (ids?: string[]) => {
    const selection = ids && ids.length ? new Set(ids) : null;
    const scope = selection ? items.filter((item) => selection.has(item.id)) : items;
    if (scope.length === 0) {
      library.showNotice("Add photos or videos to start a slideshow.");
      return;
    }
    setPendingReveal({ kind: "slideshow", ids: scope.map((item) => item.id) });
  };

  const confirmReveal = () => {
    const request = pendingReveal;
    if (!request) return;
    setPendingReveal(null);
    if (request.kind === "slideshow") {
      const ids = new Set(request.ids);
      const scope = library.hiddenItems.filter((item) => ids.has(item.id));
      if (scope.length) startConfiguredSlideshow(scope, library.inspectedId);
      return;
    }
    if (request.kind === "edit") {
      props.onOpenEdit(request.item);
      return;
    }
    props.onOpenViewer(request.id);
  };

  const revealCopy = (() => {
    if (!pendingReveal) return { title: "", body: "", action: "Show" };
    if (pendingReveal.kind === "slideshow") {
      const count = pendingReveal.ids.length;
      return {
        title: `Play ${count} hidden ${count === 1 ? "item" : "items"}?`,
        body: "They will be visible on screen until you stop the slideshow. Hidden items remain on disk at their original paths and are not encrypted.",
        action: "Play slideshow",
      };
    }
    if (pendingReveal.kind === "edit") {
      return {
        title: "Open this hidden item in the editor?",
        body: "The item will be visible in the editor. Hidden items remain on disk at their original paths and are not encrypted.",
        action: "Open editor",
      };
    }
    return {
      title: "Show this hidden item?",
      body: "It will be visible on screen. Hidden items remain on disk at their original paths and are not encrypted.",
      action: "Show item",
    };
  })();

  const toggleSelectAll = () => {
    const allSelected = items.length > 0 && items.every((item) => library.selectedIds.includes(item.id));
    if (allSelected) {
      const visible = new Set(items.map((item) => item.id));
      library.setSelectedIds(library.selectedIds.filter((id) => !visible.has(id)));
    } else {
      library.setSelectedIds([...library.selectedIds, ...items.map((item) => item.id)]);
    }
  };

  const selectRange = (startId: string, endId: string) => {
    const start = items.findIndex((item) => item.id === startId);
    const end = items.findIndex((item) => item.id === endId);
    if (start < 0 || end < 0) return;
    const [from, to] = start <= end ? [start, end] : [end, start];
    library.setSelectedIds([...library.selectedIds, ...items.slice(from, to + 1).map((item) => item.id)]);
  };

  return (
    <>
      <LibraryScreen
        hiddenView
        items={items}
        inspectedId={library.inspectedId}
        selectedIds={library.selectedIds}
        filter={filter}
        query={query}
        layout={library.layout}
        showInspector={library.showInspector}
        activeAlbum={null}
        albums={library.albums}
        hiddenCount={library.hiddenCount}
        onInspectItem={library.inspectItem}
        onToggleSelect={library.toggleSelection}
        onSelectRange={selectRange}
        onSetSelection={library.setSelectedIds}
        onToggleSelectAll={toggleSelectAll}
        onClearSelection={library.clearSelection}
        onChangeFilter={library.setHiddenFilter}
        onChangeQuery={library.setHiddenQuery}
        onChangeLayout={library.setLayout}
        onToggleInspector={library.toggleInspector}
        onSetActiveAlbum={library.setActiveAlbum}
        onOpenAlbums={() => props.onNavigate("Albums")}
        onOpenAlbumPicker={props.onOpenAlbumPicker}
        onToggleFavorite={library.toggleFavorite}
        onToggleHidden={library.toggleHidden}
        onSetFavoriteForIds={library.setFavoriteForIds}
        onSetHiddenForIds={library.setHiddenForIds}
        onUpdateTags={library.updateItemTags}
        onDeleteItems={library.deleteItems}
        onRequestDeleteItems={props.onRequestDeleteItems}
        onOpenViewer={requestViewer}
        onOpenEdit={requestEdit}
        onPlaySlideshow={requestSlideshow}
        onCreateAlbum={props.onCreateAlbum}
        searchInputRef={props.searchInputRef}
        onContextMenu={props.onContextMenu}
        busy={library.busy}
        progress={library.progress}
        notice={library.showNotice}
        assetUrl={props.assetUrl}
        onBrowseLibrary={() => props.onNavigate("Library")}
      />

      {pendingReveal && (
        <div className="dialog-backdrop" onClick={() => setPendingReveal(null)}>
          <div
            className="album-dialog confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hidden-reveal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">HIDDEN ITEM</p>
                <h2 id="hidden-reveal-title">{revealCopy.title}</h2>
              </div>
              <button type="button" className="dialog-close" onClick={() => setPendingReveal(null)} aria-label="Cancel">×</button>
            </div>
            <p className="dialog-body">{revealCopy.body}</p>
            <div className="dialog-actions">
              <button className="quiet-button" type="button" onClick={() => setPendingReveal(null)}>Cancel</button>
              <button className="primary-button" type="button" autoFocus onClick={confirmReveal}>{revealCopy.action}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function LibraryScreen(props: any) {
  const library = useLibraryStore();
  const draftTransforms = useDraftTransforms();
  const thumbnailSize = useThumbnailSize();
  const settingsStore = useSettingsStore();
  // The grid can request a cached JPEG instead of decoding the original. Use
  // roughly 2x the CSS tile width so retina displays stay sharp; the details
  // preview is only 42-52 px, so a 128 px thumbnail is plenty there.
  const thumbnailPixels = props.layout === "overview" ? 1024 : props.layout === "details" ? 128 : 512;
  // Hidden items are masked by default. A pointer-down reveals just that tile
  // while it is held; releasing (or leaving the tile) puts the veil back.
  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => new Set());
  const concealAll = useCallback(() => {
    setRevealedIds((prev) => (prev.size ? new Set() : prev));
  }, []);
  const revealItem = useCallback((id: string) => {
    setRevealedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const concealItem = useCallback((id: string) => {
    setRevealedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  useEffect(() => {
    concealAll();
  }, [props.hiddenView, props.filter, props.query, props.layout, concealAll]);
  useEffect(() => {
    if (!props.hiddenView) return;
    // A pointer released outside the tile still ends the reveal. Window blur
    // covers alt-tab, which should never leave hidden media exposed.
    window.addEventListener("pointerup", concealAll);
    window.addEventListener("blur", concealAll);
    return () => {
      window.removeEventListener("pointerup", concealAll);
      window.removeEventListener("blur", concealAll);
    };
  }, [props.hiddenView, concealAll]);
  const masked = (item: any) => Boolean(props.hiddenView) && !revealedIds.has(item.id);
  const tileAlt = (item: any) => (masked(item) ? "Hidden item" : item.name);
  const holdHandlers = (id: string) => props.hiddenView ? {
    onPointerDown: () => revealItem(id),
    onPointerUp: () => concealItem(id),
    onPointerLeave: () => concealItem(id),
    onPointerCancel: () => concealItem(id),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === " " || event.key === "Enter") revealItem(id);
    },
    onKeyUp: (event: React.KeyboardEvent) => {
      if (event.key === " " || event.key === "Enter") concealItem(id);
    },
  } : {};
  const assetUrl = props.assetUrl;
  // `activeAlbum` is the album id; the heading needs its display name.
  const activeAlbumRecord = props.activeAlbum
    ? props.albums?.find((album: any) => album.id === props.activeAlbum)
    : null;
  const activeAlbumName = props.activeAlbum ? activeAlbumRecord?.name ?? "Album" : null;
  const inAlbum = Boolean(props.activeAlbum);
  const activeAlbumItems = useMemo(
    () => props.activeAlbum
      ? library.items.filter((item: any) => item.albumIds?.includes(props.activeAlbum) && !item.hidden)
      : [],
    [library.items, props.activeAlbum],
  );
  const activeAlbumPhotos = useMemo(
    () => activeAlbumItems
      .filter((item: any) => item.kind === "photo" || item.kind === "video")
      .slice(0, 3),
    [activeAlbumItems],
  );
  // Hidden items do not count toward an album while they are hidden; the
  // backend applies the same rule, so a reload and the live UI agree.
  const activeAlbumCount = activeAlbumItems.length;
  const albumEmpty = inAlbum && activeAlbumCount === 0;
  // Filter counts should describe the collection on screen, not the whole
  // library while an album or a source is selected.
  const sourceItems = useMemo(() => {
    if (props.hiddenView) return library.hiddenItems;
    if (!library.activeSource) return library.items;
    const prefix = `${library.activeSource.replace(/\/$/, "")}/`;
    return library.items.filter(
      (item: any) => item.path === library.activeSource || item.path.startsWith(prefix),
    );
  }, [library.items, library.hiddenItems, library.activeSource, props.hiddenView]);
  const filterSource = inAlbum ? activeAlbumItems : sourceItems;
  // The SHOW row used to run one full filter pass per chip on every render.
  // One pass keeps the counts in sync and is O(n) instead of 6 × O(n).
  const filterCounts = useMemo(() => {
    const counts = { All: 0, Photos: 0, Videos: 0, RAW: 0, Favorites: 0 };
    for (const item of filterSource) {
      if (!props.hiddenView && item.hidden) continue;
      counts.All += 1;
      if (item.kind === "photo") counts.Photos += 1;
      else if (item.kind === "video") counts.Videos += 1;
      else if (item.kind === "raw") counts.RAW += 1;
      if (item.favorite) counts.Favorites += 1;
    }
    return counts;
  }, [filterSource, props.hiddenView]);
  const clearEmptyView = () => {
    props.onChangeQuery("");
    props.onChangeFilter("All");
    if (!props.hiddenView) library.setActiveSource(null);
  };

  const emptyView = () => {
    if (props.hiddenView) {
      const nothingHidden = props.hiddenCount === 0;
      return (
        <div className="empty-state" style={{ gridColumn: "1/-1" }}>
          <span>{nothingHidden ? <EyeOffIcon size={28} /> : <ImageOffIcon size={28} />}</span>
          <b>{nothingHidden ? "Nothing is hidden" : "No hidden items match"}</b>
          <p>
            {nothingHidden
              ? "Select items in Library and choose Hide. Hidden items stay on disk at their original paths and are not encrypted."
              : "Try another filter or search."}
          </p>
          {nothingHidden ? (
            <button className="primary-button" type="button" onClick={() => props.onBrowseLibrary?.()}>
              Browse Library
            </button>
          ) : (
            <button type="button" onClick={clearEmptyView}>Clear filters</button>
          )}
        </div>
      );
    }
    return (
      <div
        className={`empty-state${albumEmpty ? " album-empty-dropzone" : ""}${albumEmpty && props.albumDragOver ? " is-dragging" : ""}`}
        style={{ gridColumn: "1/-1" }}
      >
        <span>{albumEmpty ? <AlbumsIcon size={30} /> : <ImageOffIcon size={28} />}</span>
        <b>{albumEmpty ? (props.albumDragOver ? "Drop to add to this album" : "This album is empty") : "No photos match"}</b>
        <p>
          {albumEmpty
            ? "Drag files here or use Add Items. You can also select photos in Library and choose Add to album."
            : "Try another filter or search."}
        </p>
        {albumEmpty ? (
          <div className="album-empty-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => props.onAddItems?.(props.activeAlbum)}
            >
              <PlusIcon size={14} /> Add Items
            </button>
            <button
              className="quiet-button"
              type="button"
              onClick={() => {
                props.onSetActiveAlbum?.(null);
                props.onChangeFilter?.("All");
                props.onChangeQuery?.("");
              }}
            >
              Browse Library
            </button>
          </div>
        ) : (
          <button type="button" onClick={clearEmptyView}>Clear filters</button>
        )}
      </div>
    );
  };

  // Progressive rendering. A library can hold tens of thousands of items and
  // mounting a tile for every one makes typing, clicking and filtering janky
  // (the whole grid reconciles on each state change). Render a page at a time
  // and extend it as the user scrolls, so the DOM stays small.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [renderLimit, setRenderLimit] = useState(GALLERY_PAGE_SIZE);

  // A new view starts at the top of the list again.
  useEffect(() => {
    setRenderLimit(GALLERY_PAGE_SIZE);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [props.filter, props.query, props.activeAlbum, library.activeSource, props.layout]);

  const loadMore = () => {
    setRenderLimit((n) => Math.min(n + GALLERY_PAGE_SIZE, props.items.length));
  };

  const handleGridScroll = () => {
    const el = scrollRef.current;
    if (!el || renderLimit >= props.items.length) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) loadMore();
  };
  const handleGridKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const rawTarget = (e.target as HTMLElement) || (document.activeElement as HTMLElement);
    const button = (rawTarget?.closest?.(".tile-open-button") as HTMLButtonElement | null)
      || (document.activeElement as HTMLElement | null)?.closest?.(".tile-open-button") as HTMLButtonElement | null;
    if (!button) return;
    const buttons = Array.from(scrollRef.current?.querySelectorAll<HTMLButtonElement>(".tile-open-button") ?? []);
    const currentIndex = buttons.indexOf(button);
    if (currentIndex < 0) return;
    let columns = 1;
    const firstTop = buttons[0]?.offsetTop;
    for (let i = 1; i < buttons.length; i++) {
      if (buttons[i].offsetTop === firstTop) columns += 1;
      else break;
    }
    if (columns < 1) columns = 1;
    let nextIndex = currentIndex;
    if (e.key === "ArrowRight") nextIndex = currentIndex + 1;
    else if (e.key === "ArrowLeft") nextIndex = currentIndex - 1;
    else if (e.key === "ArrowDown") nextIndex = currentIndex + columns;
    else if (e.key === "ArrowUp") nextIndex = currentIndex - columns;
    else return;
    if (nextIndex < 0 || nextIndex >= buttons.length) return;
    e.preventDefault();
    const nextButton = buttons[nextIndex];
    nextButton.focus();
    const itemId = nextButton.getAttribute("data-item-id");
    if (itemId) props.onInspectItem?.(itemId);
  }, [props.onInspectItem]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      handleGridKeyDown(e as unknown as React.KeyboardEvent<HTMLDivElement>);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleGridKeyDown]);

  const renderedItems = useMemo(() => props.items.slice(0, renderLimit), [props.items, renderLimit]);
  const selectedIdSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds]);

  // Timeline groups use the photo's capture date when available, with file
  // modification time as a reliable fallback for screenshots and videos.
  const timelineGroups: { key: string; label: string; items: any[]; count: number }[] = useMemo(() => props.layout === "timeline"
    ? (() => {
        const grouped = new Map<string, { timestamp: number; items: any[] }>();
        for (const item of props.items) {
          const timestamp = item.capturedAt ?? item.modifiedAt;
          const date = new Date(timestamp);
          const key = `${date.getFullYear()}-${date.getMonth()}`;
          const group = grouped.get(key) ?? { timestamp, items: [] as any[] };
          group.timestamp = Math.max(group.timestamp, timestamp);
          group.items.push(item);
          grouped.set(key, group);
        }
        return [...grouped.entries()]
          .sort((a, b) => b[1].timestamp - a[1].timestamp)
          .map(([key, group]) => ({
            key,
            label: new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(group.timestamp),
            items: group.items,
            count: group.items.length,
          }));
      })()
    : [], [props.items, props.layout]);
  const visibleTimelineGroups = useMemo(() => {
    if (!timelineGroups.length) return [];
    const visibleItemsByMonth = new Map<string, any[]>();
    for (const item of renderedItems) {
      const timestamp = item.capturedAt ?? item.modifiedAt;
      const date = new Date(timestamp);
      const key = `${date.getFullYear()}-${date.getMonth()}`;
      const items = visibleItemsByMonth.get(key) ?? [];
      items.push(item);
      visibleItemsByMonth.set(key, items);
    }
    return timelineGroups.flatMap((group) => {
      const visibleItems = visibleItemsByMonth.get(group.key);
      return visibleItems?.length ? [{ ...group, visibleItems }] : [];
    });
  }, [renderedItems, timelineGroups]);

  const captureDate = (item: any) => item.capturedAt ?? item.modifiedAt;
  const sortDetailsBy = (sortBy: typeof library.sortBy) => {
    library.setSort(sortBy, library.sortBy === sortBy && library.sortOrder === "asc" ? "desc" : "asc");
  };
  const detailsHeader = (label: string, sortBy?: typeof library.sortBy) => (
    <div className="details-col">
      {sortBy ? (
        <button type="button" className="details-sort-header" onClick={() => sortDetailsBy(sortBy)}>
          {label}<span aria-hidden="true">{library.sortBy === sortBy ? (library.sortOrder === "asc" ? "↑" : "↓") : "↕"}</span>
        </button>
      ) : label}
    </div>
  );
  const toggleTimelineGroup = (items: any[]) => {
    const groupIds = items.map((item) => item.id);
    const groupIdSet = new Set(groupIds);
    const allSelected = groupIds.length > 0 && groupIds.every((id) => selectedIdSet.has(id));
    const next = allSelected
      ? props.selectedIds.filter((id: string) => !groupIdSet.has(id))
      : [...new Set([...props.selectedIds, ...groupIds])];
    props.onSetSelection?.(next);
  };

  const lastClickedRef = useRef<string | null>(null);

  // Interaction contract:
  //  - plain single click → inspect the item (Inspector follows; selection untouched)
  //  - shift-click → range-select from the last clicked tile
  //  - Cmd/Ctrl-click → toggle selection membership (inspection untouched)
  //  - double click → inspect + open the viewer on exactly that item
  //  - checkbox → toggle selection membership only
  const handleTileClick = (item: any, e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedRef.current && lastClickedRef.current !== item.id) {
      props.onSelectRange?.(lastClickedRef.current, item.id);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      props.onToggleSelect?.(item.id);
      lastClickedRef.current = item.id;
      return;
    }
    props.onInspectItem?.(item.id);
    lastClickedRef.current = item.id;
  };

  const handleTileDoubleClick = (item: any) => {
    lastClickedRef.current = item.id;
    props.onInspectItem?.(item.id);
    props.onOpenViewer?.(item.id);
  };

  const tileClass = (item: any) =>
    `gallery-tile${props.inspectedId === item.id ? " inspected" : ""}${selectedIdSet.has(item.id) ? " selected" : ""}${item.favorite ? " is-favorite" : ""}${masked(item) ? " hidden-obscured" : ""}`;

  // Right-clicking a photo is the most direct place to manage its album
  // membership. The picker itself carries the album list and search.
  const itemContextMenu = (item: any) => [
    { label: "Open", onClick: () => props.onOpenViewer(item.id) },
    ...(item.kind === "photo" ? [{ label: "Edit", onClick: () => { props.onOpenEdit?.(item); } }] : []),
    { label: "Open in Finder", onClick: () => tauri.items.revealInFinder(item.path) },
    { divider: true },
    { label: "Add to Album…", onClick: () => props.onOpenAlbumPicker?.([item.id]) },
    ...(props.activeAlbum
      ? [{
          label: "Remove from this Album",
          danger: true,
          onClick: () => props.onRequestRemoveFromAlbum?.(props.activeAlbum, [item.id]),
        }]
      : []),
    { label: "New Album…", onClick: () => props.onCreateAlbum?.([item.id]) },
    { divider: true },
    { label: "Favorite", onClick: () => props.onToggleFavorite(item.id) },
    { label: item.hidden ? "Unhide" : "Hide", onClick: () => props.onToggleHidden(item.id) },
    { label: "Delete", danger: true, onClick: () => props.onRequestDeleteItems?.([item.id]) },
  ];

  // Batch actions live in the contextual selection bar, so resolve the
  // selected items once and derive the toggled labels from them.
  const selectedItems = useMemo(() => {
    if (!props.selectedIds.length) return [];
    const ids = new Set(props.selectedIds);
    return library.items.filter((i: any) => ids.has(i.id));
  }, [library.items, props.selectedIds]);
  const anySelectedFavorite = selectedItems.some((i: any) => i.favorite);
  const anySelectedHidden = selectedItems.some((i: any) => i.hidden);
  // Play on a video-only selection opens the player; anything with a photo
  // starts a slideshow. The label follows the action so it is never a surprise.
  const selectionPlaysInViewer = selectedItems.length > 0 && selectedItems.every((i: any) => i.kind === "video");
  // Say what is actually in the selection: "3 photos · 2 videos" explains the
  // Play/Slideshow label and avoids surprises when a filter hides some of them.
  const selectedKindCounts = useMemo(() => {
    const counts: Record<string, number> = { photo: 0, video: 0, raw: 0 };
    for (const item of selectedItems) counts[item.kind] = (counts[item.kind] || 0) + 1;
    return counts;
  }, [selectedItems]);
  const selectedKindSummary = [
    selectedKindCounts.photo ? `${selectedKindCounts.photo} photo${selectedKindCounts.photo === 1 ? "" : "s"}` : "",
    selectedKindCounts.video ? `${selectedKindCounts.video} video${selectedKindCounts.video === 1 ? "" : "s"}` : "",
    selectedKindCounts.raw ? `${selectedKindCounts.raw} RAW` : "",
  ].filter(Boolean).join(" · ");
  // Select-all now lives in the selection bar and is scoped to the items the
  // screen is actually showing (including the Hidden and album views).
  const allVisibleSelected = props.items.length > 0 && props.items.every((item: any) => selectedIdSet.has(item.id));
  const toggleSelectAllVisible = () => {
    props.onSetSelection?.(allVisibleSelected ? [] : props.items.map((item: any) => item.id));
  };

  return (
    <div className={`library-layout ${props.showInspector ? "with-inspector" : ""}`}>
      <section className="library-center">
        <header className="library-header">
          {inAlbum ? (
            <div className="album-detail-top">
              <button className="album-breadcrumb" type="button" onClick={() => props.onOpenAlbums?.()}>
                <AlbumsIcon size={15} /> All albums
              </button>
              <div className="album-detail-heading">
                <div className={`album-detail-cover${activeAlbumPhotos.length ? "" : " is-empty"}`}>
                  {activeAlbumPhotos.length ? (
                    <AlbumPhotoStack photos={activeAlbumPhotos} assetUrl={assetUrl} albumItems={activeAlbumItems} />
                  ) : (
                    <AlbumsIcon size={27} />
                  )}
                </div>
                <div className="album-detail-copy">
                  <p className="eyebrow">ALBUM</p>
                  <h1>{activeAlbumName}</h1>
                  <p className="page-subtitle">
                    {activeAlbumCount.toLocaleString()} {activeAlbumCount === 1 ? "item" : "items"}
                    {" · "}
                    {props.items.length.toLocaleString()} shown
                  </p>
                </div>
                <div className="album-detail-actions">
                  <button
                    className="play-button"
                    type="button"
                    onClick={() => props.onPlaySlideshow?.(props.selectedIds)}
                    disabled={props.busy || props.items.length === 0}
                    title={props.selectedIds.length ? "Play the selected items" : "Play this album as a slideshow"}
                  >
                    <PlayIcon size={14} /> Play
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => props.onAddItems?.(props.activeAlbum)}
                    disabled={props.busy}
                  >
                    <PlusIcon size={15} /> Add Items
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    onClick={(e) => props.onAlbumMenu?.(e)}
                    title="Album options"
                    aria-label="Album options"
                  >
                    <MoreIcon size={18} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <header className="library-header-row">
              <div className="header-left">
                <p className="eyebrow">{props.hiddenView ? "OUT OF THE GALLERY" : "YOUR COLLECTION"}</p>
                <div className="header-title-row">
                  <h1>{props.hiddenView ? "Hidden" : "All Photos"}</h1>
                  <p className="page-subtitle">
                    {props.items.length.toLocaleString()} shown ·{" "}
                    {props.hiddenView
                      ? `${(props.hiddenCount || 0).toLocaleString()} hidden`
                      : `${(library.items.length - library.hiddenCount).toLocaleString()} in library`}
                    {!props.hiddenView && props.hiddenCount ? ` · ${props.hiddenCount.toLocaleString()} hidden` : ""}
                  </p>
                </div>
              </div>
              <div className="header-actions">
                <button
                  className="quiet-button icon-only"
                  type="button"
                  onClick={() => props.onPlaySlideshow?.(props.selectedIds)}
                  disabled={props.busy || props.items.length === 0}
                  title="Play the current view as a slideshow (Space)"
                  aria-label="Play slideshow"
                >
                  <PlayIcon size={16} />
                </button>
                {!props.hiddenView && (
                  <>
                    <label className="source-select" title="Filter the library by source">
                      <FolderIcon size={14} />
                      <span className="source-select-label">Source</span>
                      <select
                        value={library.activeSource ?? ""}
                        onChange={(e) => library.setActiveSource(e.target.value || null)}
                        aria-label="Filter the library by source"
                      >
                        <option value="">All sources</option>
                        {library.folders.map((folder: LibraryFolder) => (
                          <option key={folder.path} value={folder.path}>{folder.name}</option>
                        ))}
                      </select>
                    </label>
                    <button className="quiet-button" type="button" onClick={() => props.onImportFolder?.()} disabled={props.busy} title="Open folder (⌘O)" aria-label="Open folder">
                      <FolderIcon size={15} /><span className="btn-label">Open folder</span>
                    </button>
                    <button className="primary-button" type="button" onClick={() => props.onImportFiles?.()} disabled={props.busy} title="Add files (⌘I)" aria-label="Add files">
                      <PlusIcon size={15} /><span className="btn-label">Add files</span>
                    </button>
                  </>
                )}
              </div>
            </header>
          )}

          {props.hiddenView && (
            <div className="hidden-disclaimer" role="note">
              <EyeOffIcon size={15} />
              <span>
                Hidden from the gallery only. Files stay on disk at their original paths and
                are not encrypted.
              </span>
            </div>
          )}

          <div className="collection-toolbar">
            <div className="search-field">
              <span className="search-icon"><SearchIcon size={15} /></span>
              <input
                ref={props.searchInputRef}
                value={props.query}
                onChange={(e) => props.onChangeQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape" && props.query) props.onChangeQuery(""); }}
                placeholder={props.hiddenView ? "Search hidden items…" : "Search filenames, tags, camera…"}
                aria-label={props.hiddenView ? "Search hidden items" : "Search library"}
              />
              {props.query ? (
                <button
                  type="button"
                  className="clear-btn visible"
                  onClick={() => { props.onChangeQuery(""); }}
                  aria-label="Clear search"
                  title="Clear (Esc)"
                >
                  ×
                </button>
              ) : (
                <kbd title="Focus search">{searchShortcutLabel()}</kbd>
              )}
            </div>
            <div className="toolbar-right">
              <div className="toolbar-actions">
                {!props.hiddenView && (
                  <button className="toolbar-button" type="button" onClick={() => props.onCreateAlbum?.()} title="Create album (⌘N)"><PlusIcon size={14} /> Album</button>
                )}
                <span className="toolbar-divider" aria-hidden="true" />
                <div className="layout-switcher" aria-label="Gallery layout">
                  {(["grid", "details", "timeline"] as const).map((l) => {
                    const Icon = l === "grid" ? GridIcon : l === "details" ? DetailsIcon : TimelineIcon;
                    return (
                      <button key={l} type="button" aria-label={l} title={l} className={props.layout === l ? "selected" : ""} onClick={() => props.onChangeLayout(l)}><Icon size={14} /></button>
                    );
                  })}
                </div>
                <div className="zoom-control" aria-label="Thumbnail size">
                  {(["small", "medium", "large"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`zoom-step ${thumbnailSize === s ? "selected" : ""}`}
                      onClick={() => settingsStore.update("thumbnailSize", s)}
                      title={s === "small" ? "Small thumbnails" : s === "medium" ? "Medium thumbnails" : "Large thumbnails"}
                    >
                      {s === "small" ? "S" : s === "medium" ? "M" : "L"}
                    </button>
                  ))}
                </div>
                {!props.hiddenView && (
                  <div className="sort-control">
                    <select
                      aria-label="Sort library"
                      value={library.sortBy}
                      onChange={(e) => library.setSort(e.target.value as typeof library.sortBy, library.sortOrder)}
                    >
                      <option value="capturedAt">Date captured</option>
                      <option value="modifiedAt">Date modified</option>
                      <option value="name">Name</option>
                      <option value="size">File size</option>
                      <option value="kind">Media type</option>
                    </select>
                    <button
                      type="button"
                      aria-label={library.sortOrder === "asc" ? "Sort ascending" : "Sort descending"}
                      title={library.sortOrder === "asc" ? "Ascending" : "Descending"}
                      onClick={() => library.setSort(library.sortBy, library.sortOrder === "asc" ? "desc" : "asc")}
                    >
                      {library.sortOrder === "asc" ? "↑" : "↓"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="filter-cluster">
            <span className="smart-label">SHOW</span>
            {(["All", "Photos", "Videos", "RAW", "Favorites"] as string[]).map((f) => {
              const count = filterCounts[f as keyof typeof filterCounts] ?? 0;
              return (
                <button key={f} type="button" className={`quick-filter ${props.filter === f ? "active" : ""}`} onClick={() => props.onChangeFilter(f)}>
                  {f}
                  <span className="filter-count">{count}</span>
                </button>
              );
            })}
          </div>

          {props.selectedIds.length > 0 && (
            <div className="selection-bar" role="toolbar" aria-label="Selection actions">
              <div className="selection-bar-left">
                <span className="selection-bar-count">
                  {props.selectedIds.length.toLocaleString()} selected
                </span>
                <span className="selection-bar-divider" aria-hidden="true" />
                <span className="selection-bar-size">
                  {formatBytesSimple(selectedItems.reduce((sum: number, item: any) => sum + (item.size || 0), 0))} selected
                </span>
                {selectedKindSummary && (
                  <>
                    <span className="selection-bar-divider" aria-hidden="true" />
                    <span className="selection-bar-kinds">{selectedKindSummary}</span>
                  </>
                )}
              </div>
              <div className="selection-bar-actions">
                <button
                  type="button"
                  className="selection-bar-action selection-bar-clear"
                  onClick={() => props.onClearSelection?.()}
                  title="Clear selection (inspection is kept)"
                >
                  Clear
                </button>
                <span className="selection-bar-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={toggleSelectAllVisible}
                  title={allVisibleSelected ? "Deselect all shown items" : "Select all shown items"}
                >
                  <CheckIcon size={12} />
                  {allVisibleSelected ? "Deselect all" : "Select all"}
                </button>
              <button
                type="button"
                className="selection-bar-action"
                onClick={() => props.onPlaySlideshow?.(props.selectedIds)}
                title={selectionPlaysInViewer ? "Play the selected videos in the viewer" : "Play selected items as a slideshow"}
              >
                <PlayIcon size={13} /> {selectionPlaysInViewer ? "Play" : "Slideshow"}
              </button>
              <button
                type="button"
                className="selection-bar-action"
                onClick={() => props.onSetFavoriteForIds(props.selectedIds, !anySelectedFavorite)}
                title={anySelectedFavorite ? "Remove favorite from all selected" : "Favorite all selected"}
              >
                <HeartIcon size={13} filled={anySelectedFavorite} />
                {anySelectedFavorite ? "Unfavorite" : "Favorite"}
              </button>
              <button
                type="button"
                className="selection-bar-action"
                onClick={() => props.onSetHiddenForIds(props.selectedIds, !anySelectedHidden)}
                title={anySelectedHidden ? "Unhide all selected" : "Hide all selected"}
              >
                {anySelectedHidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                {anySelectedHidden ? "Unhide" : "Hide"}
              </button>
              <button
                type="button"
                className="selection-bar-action"
                onClick={() => props.onOpenAlbumPicker?.(props.selectedIds)}
                title="Add selected items to an album"
              >
                <AlbumsIcon size={13} /> Add to album
              </button>
              {inAlbum && (
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={() => library.removeFromAlbum(props.activeAlbum, props.selectedIds)}
                  title="Remove selected items from this album (photos stay in the library)"
                >
                  <MinusIcon size={13} /> Remove from album
                </button>
              )}
              {!props.hiddenView && (
                <button
                  type="button"
                  className="selection-bar-action"
                  onClick={() => props.onOpenBatch?.(props.selectedIds)}
                  title="Send the selected items to Batch export"
                >
                  <BatchIcon size={13} /> Batch
                </button>
              )}
{!props.hiddenView && (
                <button
                  type="button"
                  className="selection-bar-action selection-bar-action-danger"
                  onClick={() => props.onRequestDeleteItems?.(props.selectedIds)}
                  title="Move selected items to Trash"
                >
                  <TrashIcon size={13} /> Delete
                </button>
              )}
            </div>
          </div>
          )}
        </header>

        <div className="library-grid-container" ref={scrollRef} onScroll={handleGridScroll} onKeyDown={handleGridKeyDown}>
          {props.layout === "details" && (
            <div className="details-header-sticky">
              <div className="details-col details-preview-heading">Preview</div>
              {detailsHeader("Name", "name")}
              {detailsHeader("Captured", "capturedAt")}
              {detailsHeader("Kind", "kind")}
              {detailsHeader("Size", "size")}
            </div>
          )}
          {(() => {
            if (props.layout === "details") {
              return (
                <div className="gallery-grid layout-details">
                    {renderedItems.map((item: any) => (
                    <article key={item.id} className={tileClass(item)} onContextMenu={(e: any) => { concealItem(item.id); props.onContextMenu(itemContextMenu(item), e); }}>
                      <div className="tile-select-check">
                        <input type="checkbox" checked={selectedIdSet.has(item.id)} onChange={() => props.onToggleSelect(item.id)} title={selectedIdSet.has(item.id) ? "Remove from selection" : "Add to selection"} onClick={(e: any) => e.stopPropagation()} />
                        <CheckIcon size={12} />
                      </div>
                      <button type="button" className="tile-open-button" data-item-id={item.id} onClick={(e) => { e.currentTarget.focus(); handleTileClick(item, e); }} onDoubleClick={() => handleTileDoubleClick(item)} {...holdHandlers(item.id)}>
                        <span className="tile-image">
                          {item.kind === "video" ? <VideoThumb src={assetUrl(item.path)} name={tileAlt(item)} /> : item.kind === "photo" ? <CachedThumbnail itemId={item.id} name={tileAlt(item)} size={thumbnailPixels} style={draftImageStyle(draftTransforms, item.id)} fallbackSrc={assetUrl(item.path)} /> : <span className="raw-tile"><KindBadge kind={item.kind} /></span>}
                          {item.kind === "video" && <span className="video-label"><PlayIcon size={10} /></span>}
                          {item.kind === "raw" && <span className="format-label"><KindBadge kind={item.kind} /></span>}
                          {item.favorite && !masked(item) ? (
                            <span className="tile-favorite" aria-label="Favorite"><HeartIcon size={11} filled /></span>
                          ) : null}
                        </span>
                        <span className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}>
                                <b>{masked(item) ? "Hidden item" : item.name}</b>
                                <small className="tile-date">{new Date(captureDate(item)).toLocaleDateString()}</small>
                                <small className="tile-kind">
                                  <KindDot kind={item.kind} />
                                  {item.kind === 'video' ? 'Video' : item.kind === 'raw' ? 'RAW' : 'Photo'}
                                </small>
                                <small className="tile-size">{formatBytesSimple(item.size)}</small>
                              </span>
                      </button>
                    </article>
                  ))}
                  {props.items.length === 0 && emptyView()}
                </div>
              );
            }
            if (props.layout === "timeline") {
              return (
                <div className={`gallery-grid layout-timeline thumb-${thumbnailSize}`}>
                  {timelineGroups.length === 0 ? emptyView() : (
                    visibleTimelineGroups.map(({ key, label, items, count, visibleItems }) => {
                      const allSelected = items.length > 0 && items.every((item: any) => selectedIdSet.has(item.id));
                      return <React.Fragment key={key}>
                        <div className="timeline-group">
                          <div className="timeline-date-marker" aria-hidden="true"><span /></div>
                          <h3>{label}</h3>
                          <span className="timeline-count">{count} {count === 1 ? "item" : "items"}</span>
                          <button
                            type="button"
                            className="timeline-select-group"
                            aria-pressed={allSelected}
                            onClick={() => toggleTimelineGroup(items)}
                            title={`Select or deselect all ${label} items`}
                          >
                            <span className="timeline-select-box">{allSelected ? <CheckIcon size={11} /> : null}</span>{allSelected ? "Selected" : "Select all"}
                          </button>
                        </div>
                        {visibleItems.map((item: any) => (
                          <article key={item.id} className={tileClass(item)} onContextMenu={(e: any) => { concealItem(item.id); props.onContextMenu(itemContextMenu(item), e); }}>
                            <div className="tile-select-check">
                              <input type="checkbox" checked={selectedIdSet.has(item.id)} onChange={() => props.onToggleSelect(item.id)} title={selectedIdSet.has(item.id) ? "Remove from selection" : "Add to selection"} onClick={(e: any) => e.stopPropagation()} />
                        <CheckIcon size={12} />
                            </div>
                            <button type="button" className="tile-open-button" data-item-id={item.id} onClick={(e) => { e.currentTarget.focus(); handleTileClick(item, e); }} onDoubleClick={() => handleTileDoubleClick(item)} {...holdHandlers(item.id)}>
                              <span className="tile-image">
                                {item.kind === "video" ? <VideoThumb src={assetUrl(item.path)} name={tileAlt(item)} /> : item.kind === "photo" ? <CachedThumbnail itemId={item.id} name={tileAlt(item)} size={thumbnailPixels} style={draftImageStyle(draftTransforms, item.id)} fallbackSrc={assetUrl(item.path)} /> : <span className="raw-tile"><KindBadge kind={item.kind} /></span>}
                                {item.kind === "video" && <span className="video-label"><PlayIcon size={10} /></span>}
                                {item.kind === "raw" && <span className="format-label"><KindBadge kind={item.kind} /></span>}
                          {item.favorite && !masked(item) ? (
                            <span className="tile-favorite" aria-label="Favorite"><HeartIcon size={11} filled /></span>
                          ) : null}
                              </span>
                              <span className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}>
                                  <b>{item.name}</b>
                                  <small className="tile-date">{new Date(captureDate(item)).toLocaleDateString()}</small>
                                  <small className="tile-kind">
                                    <KindDot kind={item.kind} />
                                    {item.kind === 'video' ? 'Video' : item.kind === 'raw' ? 'RAW' : 'Photo'}
                                  </small>
                                  <small className="tile-size">{formatBytesSimple(item.size)}</small>
                                </span>
                            </button>
                          </article>
                        ))}
                      </React.Fragment>;
                    })
                  )}
                </div>
              );
            }
            return (
              <div className={`gallery-grid layout-${props.layout} thumb-${thumbnailSize}`}>
                {renderedItems.map((item: any) => (
                  <article key={item.id} className={tileClass(item)} onContextMenu={(e: any) => { concealItem(item.id); props.onContextMenu(itemContextMenu(item), e); }}>
                    <div className="tile-select-check">
                      <input type="checkbox" checked={selectedIdSet.has(item.id)} onChange={() => props.onToggleSelect(item.id)} title={selectedIdSet.has(item.id) ? "Remove from selection" : "Add to selection"} onClick={(e: any) => e.stopPropagation()} />
                        <CheckIcon size={12} />
                    </div>
                    <button type="button" className="tile-open-button" data-item-id={item.id} onClick={(e) => { e.currentTarget.focus(); handleTileClick(item, e); }} onDoubleClick={() => handleTileDoubleClick(item)} {...holdHandlers(item.id)}>
                      <span className="tile-image">
                        {item.kind === "video" ? <VideoThumb src={assetUrl(item.path)} name={tileAlt(item)} /> : item.kind === "photo" ? <CachedThumbnail itemId={item.id} name={tileAlt(item)} size={thumbnailPixels} style={draftImageStyle(draftTransforms, item.id)} fallbackSrc={assetUrl(item.path)} /> : <span className="raw-tile"><KindBadge kind={item.kind} /></span>}
                        {item.kind === "video" && <span className="video-label"><PlayIcon size={10} /></span>}
                        {item.kind === "raw" && <span className="format-label"><KindBadge kind={item.kind} /></span>}
                          {item.favorite && !masked(item) ? (
                            <span className="tile-favorite" aria-label="Favorite"><HeartIcon size={11} filled /></span>
                          ) : null}
                      </span>
                      <span className={`tile-caption${masked(item) ? " hidden-caption" : ""}`}>
                                <b>{item.name}</b>
                                <small className="tile-date">{new Date(captureDate(item)).toLocaleDateString()}</small>
                                <small className="tile-kind">{item.kind === 'video' ? 'Video' : item.kind === 'raw' ? 'RAW' : 'Photo'}</small>
                                <small className="tile-size">{formatBytesSimple(item.size)}</small>
                              </span>
                    </button>
                  </article>
                ))}
                {props.items.length === 0 && emptyView()}
              </div>
            );
          })()}
          {renderLimit < props.items.length && (
            <div className="grid-more">
              <button type="button" className="quiet-button" onClick={loadMore}>
                Show more · {(props.items.length - renderLimit).toLocaleString()} remaining
              </button>
            </div>
          )}
        </div>
      </section>

      {props.showInspector && (
        <aside className="photo-inspector">
          {props.inspectedId && library.items.find((i: any) => i.id === props.inspectedId) ? (
            (() => {
              const sel = library.items.find((i: any) => i.id === props.inspectedId);
              if (!sel) return null;
              // Inspection is independent of selection: the Inspector always
              // shows the inspected item, even when a larger multi-selection
              // exists (already-selected items stay inspectable).
              const isSelected = selectedIdSet.has(sel.id);
              return (
                <>
                  <div className="inspector-top">
                    <div>
                      <small>{props.selectedIds.length > 1 && isSelected ? "SELECTED · INSPECTING" : "INSPECTING"}</small>
                      <h2 title={masked(sel) ? "Hidden item" : sel.name}>{masked(sel) ? "Hidden item" : sel.name}</h2>
                      {props.selectedIds.length > 1 && (
                        <span className="inspector-selection-note">{props.selectedIds.length} selected · inspection independent</span>
                      )}
                    </div>
                    <button type="button" className="inspector-close-btn" onClick={props.onToggleInspector} title="Close Inspector (⌥⌘I)">×</button>
                  </div>
                  <button className={`inspector-image${masked(sel) ? " hidden-obscured" : ""}`} type="button" aria-label={masked(sel) ? "Hold to reveal preview; double-click to open" : `Open ${sel.name} in viewer`} onDoubleClick={() => props.onOpenViewer(sel.id)} title={masked(sel) ? "Hold to reveal preview · double-click to open" : "Double-click to open in viewer"} {...holdHandlers(sel.id)}>
                    {sel.kind === "photo" ? (
                      <img src={assetUrl(sel.path)} alt={tileAlt(sel)} style={draftImageStyle(draftTransforms, sel.id)} />
                    ) : sel.kind === "video" ? (
                      <video src={assetUrl(sel.path)} controls />
                    ) : (
                      <span className="raw-tile"><KindBadge kind={sel.kind} /></span>
                    )}
                    <span>Double-click to view</span>
                    <span className="inspector-type-badge">{sel.kind === "video" ? "Video" : sel.kind === "raw" ? "RAW" : "Photo"}</span>
                  </button>
                  <div className="inspector-actions">
                    <button
                      className={`inspector-action ${sel.favorite ? "favorite active" : ""}`}
                      onClick={() => props.onToggleFavorite(props.inspectedId)}
                      title={sel.favorite ? "Unfavorite" : "Favorite"}
                    >
                      <HeartIcon size={14} filled={!!sel.favorite} />
                      <span>{sel.favorite ? "Unfavorite" : "Favorite"}</span>
                    </button>
                    <button
                      className="inspector-action"
                      onClick={() => props.onToggleHidden(props.inspectedId)}
                      title={sel.hidden ? "Unhide" : "Hide"}
                    >
                      {sel.hidden ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                      <span>{sel.hidden ? "Unhide" : "Hide"}</span>
                    </button>
                    <button
                      className={`inspector-action ${isSelected ? "active" : ""}`}
                      onClick={() => props.onToggleSelect(sel.id)}
                      title={isSelected ? "Remove from selection" : "Add to selection"}
                    >
                      {isSelected ? <CheckIcon size={14} /> : <PlusIcon size={14} />}
                      <span>{isSelected ? "Selected" : "Select"}</span>
                    </button>
                  </div>
                  <div className="inspector-section">
                    <div className="inspector-section-head"><b>File Info</b></div>
                    <div className="info-card">
                      {masked(sel) ? (
                        <div className="inspector-hidden-note">Hold the preview to reveal file details.</div>
                      ) : <>
                      <div className="info-row">
                        <span className="info-label">Name</span>
                        <span className="info-value" title={sel.name}>{sel.name}</span>
                      </div>
                      <div className="info-row">
                        <span className="info-label">Kind</span>
                        <span className="info-value"><KindBadge kind={sel.kind} /></span>
                      </div>
                      <div className="info-row">
                        <span className="info-label">Format</span>
                        <span className="info-value">{sel.extension.toUpperCase()}</span>
                      </div>
                      <div className="info-row">
                        <span className="info-label">Dimensions</span>
                        <span className="info-value">{sel.width && sel.height ? `${sel.width} × ${sel.height}` : "Unknown"}</span>
                      </div>
                      <div className="info-row">
                        <span className="info-label">Size</span>
                        <span className="info-value">{formatBytesSimple(sel.size)}</span>
                      </div>
                      {sel.camera && <div className="info-row"><span className="info-label">Camera</span><span className="info-value" title={sel.camera}>{sel.camera}</span></div>}
                      {sel.lens && <div className="info-row"><span className="info-label">Lens</span><span className="info-value" title={sel.lens}>{sel.lens}</span></div>}
                      {sel.capturedAt && <div className="info-row"><span className="info-label">Captured</span><span className="info-value">{new Date(sel.capturedAt).toLocaleString()}</span></div>}
                      <div className="info-row"><span className="info-label">Modified</span><span className="info-value">{new Date(sel.modifiedAt).toLocaleString()}</span></div>
                      </>}
                    </div>
                  </div>
                  {!masked(sel) && <div className="inspector-tags">
                    <div className="inspector-section-head"><b>App Tags</b></div>
                    <div className="tags-list">
                      {sel.tags?.map((tag: string) => (
                        <span className="app-tag" key={tag}>
                          {tag}
                          <button type="button" onClick={() => props.onUpdateTags(props.inspectedId, (sel.tags || []).filter((t: string) => t !== tag))}>×</button>
                        </span>
                      ))}
                    </div>
                    <input
                      className="tag-input"
                      aria-label="Add tag"
                      placeholder="Add tag and press Enter…"
                      onKeyDown={(e: any) => {
                        if (e.key === "Enter" && e.currentTarget.value.trim()) {
                          const newTag = e.currentTarget.value.trim();
                          const currentTags = sel.tags || [];
                          if (!currentTags.includes(newTag)) {
                            props.onUpdateTags(props.inspectedId, [...currentTags, newTag]);
                          }
                          e.currentTarget.value = "";
                        }
                      }}
                    />
                  </div>}
                </>
              );
            })()
          ) : (
            <div className="inspector-empty-state">
              <div className="inspector-top">
                <div><small>INSPECTOR</small><h2>No Inspection</h2></div>
                <button type="button" className="inspector-close-btn" onClick={props.onToggleInspector} title="Close Inspector">×</button>
              </div>
              <div className="inspector-empty-placeholder">
                <span className="inspector-empty-icon"><DetailsIcon size={26} /></span>
                <p>Single-click a photo or video to inspect its details. Selection is separate — use the checkbox or + to multi-select.</p>
              </div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

function ViewerScreen(props: any) {
  const selected = props.selected;
  const draftTransforms = useDraftTransforms();
  // Folder context: the pill shows the containing folder, the subtle line the
  // full path. Deriving both from the media path keeps it honest (no fake
  // "LOCAL FILE" label).
  const folderPath = selected?.path
    ? String(selected.path).replace(/\\/g, "/").split("/").slice(0, -1).join("/")
    : "";
  const folderName = folderPath.split("/").filter(Boolean).pop() || "Local Files";
  const [hintsVisible, setHintsVisible] = useState(true);
  const [stripStart, setStripStart] = useState(() => Math.max(0, props.items.findIndex((item: any) => item.id === selected?.id) - 18));
  const hideTimerRef = useRef<number | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollRef = useRef(false);
  const stripWindowSize = 50;
  const selectedIndex = props.items.findIndex((item: any) => item.id === selected?.id);
  const stripEnd = Math.min(props.items.length, stripStart + stripWindowSize);
  const imageRotation = (props.rotation + (draftTransforms.get(selected?.id)?.rotation || 0)) % 360;

  // Shortcut hints are shown on open and whenever the pointer moves over the
  // stage, then fade away after a short pause so the frame stays clean.
  const flashHints = useCallback(() => {
    setHintsVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500);
  }, []);

  useEffect(() => {
    flashHints();
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [props.selected?.id, flashHints]);

  // Keep the active thumbnail in view as you navigate a long filmstrip.
  // Keep the active thumbnail in view as you navigate a long filmstrip.
  useEffect(() => {
    if (selectedIndex < 0) return;
    let nextStart = stripStart;
    if (selectedIndex < stripStart) {
      nextStart = selectedIndex;
    } else if (selectedIndex >= stripStart + stripWindowSize) {
      nextStart = Math.max(0, Math.min(selectedIndex - stripWindowSize + 1, props.items.length - stripWindowSize));
    }
    if (nextStart !== stripStart) {
      const delta = (nextStart - stripStart) * 60;
      programmaticScrollRef.current = true;
      if (stripRef.current) stripRef.current.scrollLeft = Math.max(0, stripRef.current.scrollLeft + delta);
      window.setTimeout(() => { programmaticScrollRef.current = false; }, 0);
      setStripStart(nextStart);
    }
  }, [selectedIndex, stripStart, props.items.length]);

  // On open, align scroll position with the initial window (no smooth animation).
  useEffect(() => {
    if (stripRef.current) {
      programmaticScrollRef.current = true;
      stripRef.current.scrollLeft = stripStart * 60;
      window.setTimeout(() => { programmaticScrollRef.current = false; }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilmstripScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const strip = stripRef.current;
    if (!strip || props.items.length <= stripWindowSize) return;
    const nextStart = Math.max(0, Math.min(
      Math.floor(Math.max(0, strip.scrollLeft - 68) / 60) - 10,
      props.items.length - stripWindowSize,
    ));
    setStripStart((current) => Math.abs(nextStart - current) > 5 ? nextStart : current);
  }, [props.items.length]);


  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // The viewer stays mounted off-screen to keep a video playing; its
      // shortcuts must not fire while another tab is on screen.
      if (!props.active) return;
      // Ignore if typing in an input, or if the slideshow overlay is driving.
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (useSlideshowStore.getState().isOpen) return;

      switch (e.key) {
        case "ArrowUp":
          if (selected.kind === "photo") {
            e.preventDefault();
            props.onSetZoom(Math.min(300, props.zoom + 25));
          }
          break;
        case "ArrowDown":
          if (selected.kind === "photo") {
            e.preventDefault();
            props.onSetZoom(Math.max(25, props.zoom - 25));
          }
          break;
        case "r":
        case "R":
          if (selected.kind === "photo") {
            e.preventDefault();
            props.onRotate(90);
          }
          break;
        case "x":
        case "X":
          if (selected.kind === "photo") {
            e.preventDefault();
            props.onToggleFlip();
          }
          break;
        case "0":
          e.preventDefault();
          props.onSetZoom(100);
          break;
        case "1":
          e.preventDefault();
          props.onSetZoom(200);
          break;
        case "f":
        case "F":
          e.preventDefault();
          props.onToggleFavorite(selected.id);
          break;
        case " ":
          if (selected.kind === "video") {
            e.preventDefault();
            // VideoPlayer handles space internally via click
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selected, props]);

  if (!selected) return <div className="viewer-empty-state"><div className="first-run-art"><ViewerIcon size={30} /></div><h2>No viewable media yet</h2><p>Import photos or videos to start viewing.</p></div>;

  return (
    <div className="viewer-screen">
      <div className="page-heading viewer-heading">
        <div className="viewer-title-block">
          <p className="eyebrow">VIEWER</p>
          <h1 title={selected.name}>{selected.name}</h1>
          <div className="viewer-meta">
            <div className="meta-row">
              <span className="meta-chip">
                <svg className="meta-icon" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M8 2v4M8 10v4M2 8h4M10 8h4"/></svg>
                {new Date(selected.modifiedAt).toLocaleDateString()}
              </span>
              <span className="meta-chip">
                <svg className="meta-icon" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h8v8H4z"/><path d="M4 8h8"/></svg>
                {selected.extension.toUpperCase()}
              </span>
              <span className="meta-chip">
                <svg className="meta-icon" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 3"/></svg>
                {formatBytesSimple(selected.size)}
              </span>
              {selected.kind === "photo" && selected.width && selected.height && (
                <span className="meta-chip">
                  <svg className="meta-icon" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 2v12M10 2v12M2 6h12M2 10h12"/></svg>
                  {selected.width} × {selected.height}
                </span>
              )}
              {selected.kind === "video" && selected.duration && (
                <span className="meta-chip">
                  <svg className="meta-icon" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="8" cy="8" r="7"/><path d="M8 4v4l3 3"/></svg>
                  {formatDuration(selected.duration)}
                </span>
              )}
            </div>
            {folderPath && (
              <span className="meta-chip path-chip" title={selected.path}>
                <svg className="meta-icon" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h8v8H4z"/><path d="M4 8h8"/></svg>
                {folderPath}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="viewer-stage" onMouseMove={() => flashHints()} onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button, input")) return;
        if (selected.kind === "video") {
          void props.onToggleFullscreen();
          return;
        }
        if (selected.kind !== "photo") return;
        props.onSetZoom(props.zoom === 100 ? 200 : 100);
      }}>
        <button className={`viewer-arrow left${hintsVisible ? "" : " hidden"}`} type="button" onMouseEnter={() => { setHintsVisible(true); if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current); }} onMouseLeave={() => { hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500); }} onClick={() => props.onNavigate(-1)} aria-label="Previous">‹</button>
        {selected.kind === "video" ? <VideoPlayer
          itemId={selected.id}
          active={!!props.active}
          src={props.assetUrl(selected.path)}
          name={selected.name}
          onFullscreen={() => void props.onToggleFullscreen()}
          onNext={() => props.onNavigate(1)}
        /> : selected.kind === "photo" ? <img key={selected.id} src={props.assetUrl(selected.path)} alt={selected.name} decoding="async" onError={(e) => { const target = e.currentTarget; if (target.dataset.fallback === "1") { target.dataset.failed = "1"; target.alt = "Preview unavailable"; target.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="; return; } target.dataset.fallback = "1"; void tauri.library.getThumbnail({ itemId: selected.id, size: 1024 }).then((response) => { if (response?.dataUrl) target.src = response.dataUrl; }).catch(() => { target.dataset.failed = "1"; target.alt = "Preview unavailable"; target.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="; }); }} style={{ maxWidth: imageRotation % 180 ? "min(100%, 100cqh)" : undefined, maxHeight: imageRotation % 180 ? "min(100%, 100cqw)" : undefined, transform: [`rotate(${props.rotation || 0}deg)`, `scaleX(${props.flipX ? -1 : 1})`, draftTransformStyle(draftTransforms.get(selected.id)), `scale(${props.zoom / 100})`].filter(Boolean).join(" ") }} /> : <div className="raw-viewer"><b>{selected.extension.toUpperCase()}</b><span>RAW preview requires native backend</span></div>}
        <button className={`viewer-arrow right${hintsVisible ? "" : " hidden"}`} type="button" onMouseEnter={() => { setHintsVisible(true); if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current); }} onMouseLeave={() => { hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500); }} onClick={() => props.onNavigate(1)} aria-label="Next">›</button>
        <div className={`viewer-overlay-top${hintsVisible ? "" : " hidden"}`} onMouseEnter={() => { setHintsVisible(true); if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current); }} onMouseLeave={() => { hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500); }}>
          <span className="viewer-transform-state">
            {props.rotation ? `${props.rotation}°` : ""}
            {props.rotation && props.flipX ? " · " : ""}
            {props.flipX ? "Flipped" : ""}
            {selectedIndex + 1} / {props.items.length}
          </span>
        </div>
        {/* Compact shortcut hints live in the stage corner so the frame keeps
            all of its room for the media and the control bar. */}
        <div className={`viewer-hints${hintsVisible ? "" : " hidden"}`} aria-hidden="true">
          <span><kbd>←</kbd><kbd>→</kbd> Navigate</span>
          {selected.kind !== "video" && <span><kbd>↑</kbd><kbd>↓</kbd> Zoom</span>}
          {selected.kind === "video" && <span><kbd>↑</kbd><kbd>↓</kbd> Volume</span>}
          {selected.kind === "photo" && <span><kbd>R</kbd><kbd>X</kbd> Rotate/Flip</span>}
          <span><kbd>Space</kbd> Play</span>
          <span><kbd>F</kbd> Fullscreen</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
        {selected.kind !== "video" && (
          <div className={`viewer-overlay-bottom${hintsVisible ? "" : " hidden"}`} onMouseEnter={() => { setHintsVisible(true); if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current); }} onMouseLeave={() => { hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500); }}>
          <button type="button" onClick={() => props.onSetZoom(Math.max(25, props.zoom - 25))} aria-label="Zoom out"><MinusIcon size={15} /></button>
          <span>{props.zoom}%</span>
          <button type="button" onClick={() => props.onSetZoom(Math.min(300, props.zoom + 25))} aria-label="Zoom in"><PlusIcon size={15} /></button>
          <span className="viewer-divider" />
          {selected.kind === "photo" && <button type="button" onClick={() => props.onRotate(90)} aria-label="Rotate 90 degrees" title="Rotate 90°"><RotateIcon size={14} /> Rotate</button>}
          {selected.kind === "photo" && <button type="button" onClick={() => props.onToggleFlip()} aria-label="Flip horizontally" title="Flip horizontal" className={props.flipX ? "active" : ""}><FlipIcon size={14} /> Flip</button>}
          {selected.kind === "photo" && (props.rotation !== 0 || props.flipX) && <button type="button" onClick={() => props.onResetTransform()} aria-label="Reset rotation and flip" title="Reset rotation & flip">Reset</button>}
          <button type="button" onClick={() => props.onToggleFavorite(selected.id)}><HeartIcon size={14} filled={!!selected.favorite} /> Favorite</button>
          {selected.kind === "photo" && <button type="button" onClick={() => props.onOpenEdit(selected)}><EditIcon size={14} /> Edit</button>}
          <button type="button" onClick={() => void props.onToggleFullscreen()}><FullscreenIcon size={14} /> Full screen</button>
          </div>
        )}
      </div>
      <div className="filmstrip" ref={stripRef} onScroll={handleFilmstripScroll}>
        <span className="filmstrip-label">FOLDER</span>
        {stripStart > 0 && <span className="filmstrip-spacer" aria-hidden="true" style={{ flexBasis: `${stripStart * 60}px` }} />}
        {props.items.slice(stripStart, stripEnd).map((item: any) => (
          <button type="button" title={item.name} className={item.id === props.selected?.id ? "active" : ""} key={item.id} onClick={() => props.onSetPhoto(item.id)}>
            {item.kind === "photo" ? <CachedThumbnail itemId={item.id} name={item.name} size={128} style={draftImageStyle(draftTransforms, item.id)} />
              : item.kind === "video" ? <VideoThumb src={props.assetUrl(item.path)} name={item.name} />
              : <span>{item.extension.toUpperCase()}</span>}
            <KindDot kind={item.kind} />
          </button>
        ))}
        {stripEnd < props.items.length && <span className="filmstrip-spacer" aria-hidden="true" style={{ flexBasis: `${(props.items.length - stripEnd) * 60}px` }} />}
      </div>
    </div>
  );
}

function EditScreen(props: any) {
  const [pickerQuery, setPickerQuery] = useState("");
  const deferredPickerQuery = useDeferredValue(pickerQuery);
  const [pickerLimit, setPickerLimit] = useState(24);
  const [pickerDraftLimit, setPickerDraftLimit] = useState(12);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [showOriginalPreview, setShowOriginalPreview] = useState(false);
  const [draftTrayOpen, setDraftTrayOpen] = useState(false);
  const draftTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [draftPopoverPos, setDraftPopoverPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (draftTrayOpen && draftTriggerRef.current) {
      const rect = draftTriggerRef.current.getBoundingClientRect();
      setDraftPopoverPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    } else {
      setDraftPopoverPos(null);
    }
  }, [draftTrayOpen]);
  const draftTransforms = useDraftTransforms();
  const draftIds = useDraftIds();
  const stageRef = useRef<any>(null);
  const [drag, setDrag] = useState<any>(null);
  const values = props.values || {};
  const hasAdjustments = Object.entries(initialEdits).some(([key, value]) => values[key] !== value);
  const crop = props.crop || { enabled:false, x:0,y:0,width:1,height:1 };
  const savedDraftItems = useMemo(
    () => (props.items || []).filter((item: any) => draftIds.has(item.id) && !item.hidden),
    [props.items, draftIds],
  );
  const pickerItems = useMemo(() => {
    const query = deferredPickerQuery.trim().toLowerCase();
    return (props.items || []).filter((item: any) =>
      item.kind === "photo" &&
      !item.hidden &&
      !draftIds.has(item.id) &&
      (!query || String(item.name || "").toLowerCase().includes(query)),
    );
  }, [props.items, draftIds, deferredPickerQuery]);
  const previewValues = showOriginalPreview ? initialEdits : values;
  const warmth = Number(previewValues.warmth || 0);
  const previewFilter = [
    `brightness(${100 + (previewValues.exposure || 0) + (previewValues.shadows || 0) * 0.22 + (previewValues.highlights || 0) * 0.1}%)`,
    `contrast(${100 + (previewValues.contrast || 0) - (previewValues.shadows || 0) * 0.08 + (previewValues.highlights || 0) * 0.12}%)`,
    `saturate(${100 + (previewValues.saturation || 0)}%)`,
    `sepia(${Math.abs(warmth) * 0.004})`,
    `hue-rotate(${warmth < 0 ? 180 : 0}deg)`,
  ].join(" ");
  useEffect(() => { setShowOriginalPreview(false); }, [props.item?.id]);
  useEffect(() => { setPickerLimit(24); }, [deferredPickerQuery]);
  useEffect(() => {
    if (!drag || !props.item) return;
    const onMove = (e: any) => {
      const dx = (e.clientX - drag.startX) / drag.rect.width;
      const dy = (e.clientY - drag.startY) / drag.rect.height;
      if (drag.type === "move") {
        const nx = Math.min(Math.max(drag.crop.x + dx, 0), 1 - drag.crop.width);
        const ny = Math.min(Math.max(drag.crop.y + dy, 0), 1 - drag.crop.height);
        props.onSetCrop({ x: nx, y: ny });
      } else if (typeof drag.crop.aspectRatio === "number") {
        const ratio = drag.crop.aspectRatio;
        const widthDeltaFromHeight = dy * ratio / (drag.rect.width / drag.rect.height);
        const widthDelta = Math.abs(dx) >= Math.abs(widthDeltaFromHeight) ? dx : widthDeltaFromHeight;
        const maxWidth = Math.min(1 - drag.crop.x, (1 - drag.crop.y) * ratio / (drag.rect.width / drag.rect.height));
        const width = Math.min(maxWidth, Math.max(0.04, drag.crop.width + widthDelta));
        const height = width * (drag.rect.width / drag.rect.height) / ratio;
        props.onSetCrop({ width, height });
      } else {
        const nw = Math.min(Math.max(drag.crop.width + dx, 0.05), 1 - drag.crop.x);
        const nh = Math.min(Math.max(drag.crop.height + dy, 0.05), 1 - drag.crop.y);
        props.onSetCrop({ width: nw, height: nh });
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [drag, props]);
  const startDrag = (type: string, e: any) => {
    e.preventDefault(); e.stopPropagation();
    const rect = stageRef.current.getBoundingClientRect();
    setDrag({ type, startX: e.clientX, startY: e.clientY, crop: { ...crop }, rect });
  };
  const setCropRatio = (ratio: number | "free") => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect?.height || ratio === "free") {
      props.onSetCrop({ aspectRatio: ratio });
      return;
    }
    const stageRatio = rect.width / rect.height;
    const cropRatio = ratio;
    let width = Math.min(0.78, 0.78 * stageRatio / cropRatio);
    let height = width * stageRatio / cropRatio;
    if (height > 0.78) { height = 0.78; width = height * cropRatio / stageRatio; }
    props.onSetCrop({ aspectRatio: ratio, x: (1 - width) / 2, y: (1 - height) / 2, width, height });
  };
  if (!props.item) {
    const filtered = pickerItems;
    const browse = async () => {
      try {
        const sel = await openFileDialog({ multiple: false, filters: [{ name: "Images", extensions: ["jpg","jpeg","png","webp","heic","heif","tif","tiff"] }] });
        if (!sel) return;
        const path = Array.isArray(sel) ? sel[0] : sel;
        const name = String(path).split(/[\\/]/).pop() || "photo";
        props.onOpenEdit?.({ id: path, name, path, kind: "photo" });
      } catch (e) { props.onNotice?.("Could not open file"); }
    };
    return (
      <div className="edit-page">
        <div className="page-heading">
          <div><p className="eyebrow">NON-DESTRUCTIVE EDITING</p><h1>Select a photo to edit</h1><p className="page-subtitle">Choose a browser-supported photo from your library or browse from disk, then open the editor.</p></div>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
          <button className="quiet-button" type="button" onClick={() => props.onBack?.()}>Back to Library</button>
          <div className="search-field" style={{ flex: 1 }}>
            <span className="search-icon"><SearchIcon size={15} /></span>
          <input value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)} placeholder="Search photos..." aria-label="Search photos" />
          </div>
          <button className="quiet-button" type="button" onClick={browse}>Browse from Finder…</button>
        </div>
        {(() => {
          const drafts = savedDraftItems.slice(0, pickerDraftLimit);
          const remainingDrafts = Math.max(0, savedDraftItems.length - pickerDraftLimit);
          const nextDrafts = Math.min(12, remainingDrafts);
          if (!drafts.length) return null;
          return (
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ margin: "0 0 8px", color: "var(--text)" }}>Drafts</h3>
              <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8, marginBottom: 8 }}>
                {drafts.map((item: any) => (
                  <button key={item.id} type="button" className="edit-picker-tile" style={{ minWidth: 140, width: 140 }} onClick={() => props.onOpenEdit?.(item)}>
                    <PickerThumbnail itemId={item.id} name={item.name} style={draftImageStyle(draftTransforms, item.id)} />
                    <span>{item.name}</span>
                    <span className="draft-badge">Draft</span>
                    <span className="draft-remove" onClick={(e) => { e.stopPropagation(); clearEditDraft(item.id); props.onNotice?.("Draft removed"); }} title="Remove draft">×</span>
                  </button>
                ))}
              </div>
              {remainingDrafts > 0 && <button className="quiet-button" type="button" onClick={() => setPickerDraftLimit((limit) => limit + 12)}>Show {nextDrafts} more draft{nextDrafts === 1 ? "" : "s"}</button>}
            </div>
          );
        })()}
        {filtered.length > 0 ? (<>
          <div className="edit-picker-grid">{filtered.slice(0, pickerLimit).map((item:any)=> {
  const hasDraft = draftIds.has(item.id);
  return (
    <button key={item.id} type="button" className="edit-picker-tile" onClick={()=>props.onOpenEdit?.(item)}>
      <PickerThumbnail itemId={item.id} name={item.name} style={draftImageStyle(draftTransforms, item.id)} />
      <span>{item.name}</span>
      {hasDraft && <span className="draft-badge">Draft</span>}
      {hasDraft && <span className="draft-remove" onClick={(e) => { e.stopPropagation(); clearEditDraft(item.id); props.onNotice?.("Draft removed"); }} title="Remove draft">×</span>}
    </button>
  );
})}</div>
          {filtered.length > pickerLimit && <button className="quiet-button" type="button" style={{ marginTop: 12 }} onClick={() => setPickerLimit((limit) => limit + 24)}>Show 24 more photos ({filtered.length - pickerLimit} remaining)</button>}
        </>) : (<div className="viewer-empty-state"><div style={{ marginBottom: 16 }}><BrandMark size={56} /></div><h2>No photos found</h2><p>Import a folder or browse from disk.</p></div>) }
      </div>
    );
  }
  return (
    <div className="edit-page">
      <div className="page-heading">
        <div><p className="eyebrow">NON-DESTRUCTIVE EDITING</p><h1>{props.item.name}</h1><p className="page-subtitle">Adjustments are applied only when you export a new copy.</p></div>
        <div className="edit-heading-actions">
          {savedDraftItems.length > 0 && <div className="edit-drafts-menu">
            <button ref={draftTriggerRef} className="quiet-button edit-drafts-trigger" type="button" aria-expanded={draftTrayOpen} onClick={() => setDraftTrayOpen((open) => !open)}>
              Drafts <span>{savedDraftItems.length}</span>
            </button>
            {draftTrayOpen && draftPopoverPos && createPortal(
              <div className="edit-drafts-popover" style={{ position: "fixed", top: draftPopoverPos.top, right: draftPopoverPos.right, left: "auto", zIndex: 1001 }} aria-label="Saved edit drafts">
                <div className="edit-drafts-popover-head"><b>Saved drafts</b><small>{savedDraftItems.length} {savedDraftItems.length === 1 ? "photo" : "photos"}</small></div>
                <div className="edit-drafts-list">
                  {savedDraftItems.map((item: any) => (
                    <div key={item.id} className="edit-draft-card">
                      <button className="edit-draft-open" type="button" onClick={() => { props.onSaveDraft?.(); props.onOpenEdit?.(item); setDraftTrayOpen(false); }} title={`Open draft for ${item.name}`}>
                        <CachedThumbnail itemId={item.id} name={item.name} size={256} style={draftImageStyle(draftTransforms, item.id)} />
                        <span>{item.name}</span>
                      </button>
                      <button className="edit-draft-remove" type="button" aria-label={`Remove draft for ${item.name}`} title="Remove draft" onClick={() => { clearEditDraft(item.id); props.onNotice?.("Draft removed"); }}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>,
              document.querySelector(".app-frame") || document.body
            )}
          </div>}
          <button className="primary-button" type="button" onClick={() => props.onClose?.()}>Select photo</button>
          <span className="saved-indicator"><i /> Original unchanged</span>
        </div>
      </div>
      <div className="editor-layout">
        <div className="edit-canvas">
          <div className="edit-preview-toolbar">
            <span title={props.item.name}>{props.item.name}</span>
            <div className="edit-history-controls" aria-label="Edit history">
              <button type="button" onClick={() => { setShowOriginalPreview(false); props.onUndo(); }} disabled={!props.canUndo} aria-label="Undo" title="Undo">↶</button>
              <button type="button" onClick={() => { setShowOriginalPreview(false); props.onRedo(); }} disabled={!props.canRedo} aria-label="Redo" title="Redo">↷</button>
            </div>
            <button type="button" className={showOriginalPreview ? "active" : ""} aria-pressed={showOriginalPreview} onClick={() => setShowOriginalPreview((value) => !value)}>
              {showOriginalPreview ? "Show edits" : "Compare"}
            </button>
          </div>
          <div ref={stageRef} className={`crop-stage${showOriginalPreview ? " is-original" : ""}`}>
            <img src={props.assetUrl(props.item.path)} alt={props.item.name} style={{ transform: `rotate(${previewValues.rotation}deg) scaleX(${previewValues.flip ? -1 : 1})`, filter: previewFilter }} />
            {crop.enabled && !showOriginalPreview && (
              <div className="crop-overlay" style={{ position: "absolute", left: `${crop.x*100}%`, top: `${crop.y*100}%`, width: `${crop.width*100}%`, height: `${crop.height*100}%`, border: "2px solid #fff", boxShadow: "0 0 0 9999px rgba(0,0,0,.45)", cursor: "move" }} onPointerDown={(e) => startDrag("move", e)}>
                <span className="crop-handle br" style={{ position: "absolute", right: -6, bottom: -6, width: 12, height: 12, background: "#fff", border: "1px solid #333", cursor: "nwse-resize", borderRadius: 2 }} onPointerDown={(e) => { e.stopPropagation(); startDrag("resize", e); }} />
              </div>
            )}
          </div>
          <div className="canvas-actions">
            <button type="button" onClick={() => { setShowOriginalPreview(false); props.onRotate(90); }}><RotateIcon size={14} /> Rotate</button>
            <button type="button" className={values.flip ? "active" : ""} aria-pressed={!!values.flip} onClick={() => { setShowOriginalPreview(false); props.onFlip(); }}><FlipIcon size={14} /> Flip</button>
            <button type="button" className={props.crop.enabled ? "active" : ""} aria-pressed={!!props.crop.enabled} onClick={() => { setShowOriginalPreview(false); props.crop.enabled ? props.onResetCrop?.() : props.onSetCrop({ enabled: true }); }}><CropIcon size={14} /> {props.crop.enabled ? "Reset crop" : "Crop"}</button>
          </div>
        </div>
        <aside className="edit-controls">
          <div className="edit-tabs" role="group" aria-label="Edit tools">
            <button type="button" className={!props.crop.enabled ? "active" : ""} aria-pressed={!props.crop.enabled} onClick={() => props.onSetCrop({ enabled: false })}>Light &amp; color</button>
            <button type="button" className={props.crop.enabled ? "active" : ""} aria-pressed={props.crop.enabled} onClick={() => props.onSetCrop({ enabled: true })}>Crop</button>
          </div>
          {props.crop.enabled ? (
            <div className="edit-crop-panel">
              <div className="edit-panel-heading"><div><b>Crop &amp; straighten</b><small>Drag the frame to reposition it</small></div><button type="button" onClick={props.onResetCrop}>Reset</button></div>
              <span className="edit-option-label">Aspect ratio</span>
              <div className="crop-ratio-options" role="group" aria-label="Crop aspect ratio">
                {[{ label: "Free", value: "free" as const }, { label: "1:1", value: 1 }, { label: "4:3", value: 4 / 3 }, { label: "3:2", value: 3 / 2 }, { label: "16:9", value: 16 / 9 }].map((ratio) => (
                  <button type="button" key={ratio.label} className={crop.aspectRatio === ratio.value ? "active" : ""} aria-pressed={crop.aspectRatio === ratio.value} onClick={() => setCropRatio(ratio.value)}>{ratio.label}</button>
                ))}
              </div>
              <p className="edit-crop-help">Resize from the lower-right handle. The crop stays inside the photo.</p>
            </div>
          ) : <>
          <div className="edit-adjustment-header">
            <div className="edit-adjustment-heading">
              <span className="edit-adjustment-mark"><SparkleIcon size={15} /></span>
              <div><b>Adjustments</b><small>Live preview · non-destructive</small></div>
            </div>
            <div className="edit-adjustment-actions">
              <button className="edit-auto-button" type="button" onClick={() => { setShowOriginalPreview(false); props.onAuto(); }}><SparkleIcon size={13} /> Auto</button>
              <button className="edit-reset-button" type="button" onClick={() => { setShowOriginalPreview(false); props.onReset(); }} disabled={!hasAdjustments}>Reset all</button>
            </div>
          </div>
          {[
            { title: "Light", controls: [{ key: "exposure" as const, label: "Exposure" }, { key: "shadows" as const, label: "Shadows" }, { key: "highlights" as const, label: "Highlights" }, { key: "contrast" as const, label: "Contrast" }] },
            { title: "Color", controls: [{ key: "warmth" as const, label: "Warmth" }, { key: "saturation" as const, label: "Saturation" }] },
          ].map((group) => (
            <section className="edit-adjustment-group" key={group.title} aria-label={`${group.title} adjustments`}>
              <h3>{group.title}</h3>
              {group.controls.map(({ key, label }) => (
                <div className="slider-control" key={key}>
                  <span><label htmlFor={`edit-${key}`}>{label}</label><button type="button" className="slider-value-reset" aria-label={`Reset ${label}`} title={`Reset ${label}`} onClick={() => { setShowOriginalPreview(false); props.onSetValue(key, 0); }}>{values[key] > 0 ? "+" : ""}{values[key] || 0}<i>%</i></button></span>
                  <input id={`edit-${key}`} type="range" min={-80} max={80} value={values[key]} aria-label={label} onChange={(e) => { setShowOriginalPreview(false); props.onSetValue(key, Number(e.target.value)); }} />
                </div>
              ))}
            </section>
          ))}
          </>}
          <div className="edit-footer">
            <button className="quiet-button" type="button" onClick={props.onClearDraft}>Discard draft</button>
            <button className="quiet-button" type="button" onClick={props.onSaveDraft}>Save draft</button>
            <button className="quiet-button" type="button" style={{ color: "#d33" }} disabled={!(["jpg", "jpeg", "png", "webp"].includes(String(props.item.extension || props.item.name.split(".").pop() || "").toLowerCase()))} title="Replace original is available for JPEG, PNG, and WebP files" onClick={() => setConfirmReplace(true)}>Replace original</button>
            <button className="primary-button" type="button" onClick={() => props.onExport(false)}>Save copy</button>
          </div>
        </aside>
      </div>
      <p className="browser-capability-warning">Browser canvas export supports JPEG, PNG, and WebP input when the browser can decode it. HEIC and RAW need native macOS image frameworks. Metadata is removed from re-encoded exports.</p>
      {confirmReplace && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "var(--surface)", padding: 20, borderRadius: 8, maxWidth: 420, width: "90%" }}>
            <h3 style={{ margin: "0 0 8px", color: "var(--text)" }}>Replace original file?</h3>
            <p style={{ margin: "0 0 16px", color: "var(--muted)" }}>This will overwrite the original image with the edited version. This cannot be undone.</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="quiet-button" type="button" onClick={() => setConfirmReplace(false)}>Cancel</button>
              <button className="primary-button" type="button" style={{ background: "#d33", borderColor: "#d33" }} onClick={() => { setConfirmReplace(false); props.onExport(true); }}>Replace</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const BATCH_FORMATS: Array<{ value: "source" | "jpeg" | "png" | "webp"; label: string; detail: string }> = [
  { value: "source", label: "Keep source", detail: "Copy, or re-encode in the same format" },
  { value: "jpeg", label: "JPEG", detail: "Smallest files · quality control" },
  { value: "png", label: "PNG", detail: "Lossless · larger files" },
  { value: "webp", label: "WebP", detail: "Lossless · modern and compact" },
];

const BATCH_MAX_DIMENSIONS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "Original size" },
  { value: 4096, label: "Longest edge 4096 px" },
  { value: 2560, label: "Longest edge 2560 px" },
  { value: 2048, label: "Longest edge 2048 px" },
  { value: 1600, label: "Longest edge 1600 px" },
  { value: 1080, label: "Longest edge 1080 px" },
];

function batchExtension(format: string, item: any) {
  if (format === "source") {
    const ext = String(item.extension || "jpg").toLowerCase();
    return ext === "jpeg" ? "jpg" : ext;
  }
  return format === "jpeg" ? "jpg" : format;
}

function sanitizeBatchPart(value: string) {
  const cleaned = value
    .replace(/[/\\:]/g, "-")
    .replace(/[\u0000-\u001f]/g, "-")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return cleaned || "export";
}

function batchDateLabel(ms?: number) {
  const date = new Date(ms || Date.now());
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Mirrors `render_batch_filename` in src-tauri so the preview matches reality. */
function batchPreviewName(item: any, pattern: string, index: number, format: string) {
  const extension = batchExtension(format, item);
  const stem = String(item.name || "export").replace(/\.[^.]+$/, "");
  const template = pattern.trim() || "{name}_{number}";
  const rendered = sanitizeBatchPart(
    template
      .replace(/\{name\}/g, sanitizeBatchPart(stem))
      .replace(/\{number\}/g, String(index + 1).padStart(3, "0"))
      .replace(/\{date\}/g, batchDateLabel(item.capturedAt ?? item.modifiedAt))
      .replace(/\{ext\}/g, extension),
  );
  const dot = rendered.lastIndexOf(".");
  const existing = dot > -1 ? rendered.slice(dot + 1).toLowerCase() : "";
  if (!existing) return `${rendered}.${extension}`;
  if (existing === extension || (extension === "jpg" && existing === "jpeg")) return rendered;
  return `${rendered.slice(0, dot)}.${extension}`;
}

function folderDisplayName(path: string) {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function BatchScreen(props: any) {
  const [showAllFailures, setShowAllFailures] = React.useState(false);
  const items: any[] = props.items || [];
  const total = items.length;
  const busy = Boolean(props.state.busy);
  const result = props.state.result;
  const progress = props.state.progress;
  const error = props.state.error;
  const cancelRequested = Boolean(props.cancelRequested);
  const config = props.config;
  const outputFolder = String(config.outputFolder || "");
  const step = result ? 3 : busy ? 3 : total > 0 ? 2 : 1;

  const folders = items.filter((item) => item.kind === "photo").length;
  const videos = items.filter((item) => item.kind === "video").length;
  const raws = items.filter((item) => item.kind === "raw").length;
  const totalSize = items.reduce((sum, item) => sum + (item.size || 0), 0);
  const converting = config.format !== "source";
  const resizing = Boolean(config.maxDimension);
  const cannotConvert = converting || resizing || config.stripMetadata;
  const unsupportedItems = cannotConvert
    ? items.filter((item) => item.kind === "video" || item.kind === "raw")
    : [];
  const unsupported = unsupportedItems.length;
  const disabledReason = !total
    ? "Select at least one file in the Library."
    : !outputFolder.trim()
      ? "Choose an output folder to enable export."
      : busy
        ? "An export is already running."
        : "";

  const summaryStats = [
    { label: "Files", value: total.toLocaleString() },
    { label: "Source size", value: formatBytesSimple(totalSize) },
    { label: "Format", value: config.format === "source" ? "Keep source" : config.format.toUpperCase() },
    { label: "Resize", value: config.maxDimension ? `≤ ${config.maxDimension} px` : "Original" },
    { label: "Metadata", value: config.stripMetadata ? "Stripped" : "Kept when copied" },
  ];

  const failed = result?.failed || [];
  const cancelled = Boolean(result?.cancelled);
  const skipped = cancelled && result ? Math.max(0, total - result.exported - failed.length) : 0;
  const failedName = (itemId: string) => items.find((item) => item.id === itemId)?.name || "Export";

  const addToken = (token: string) => {
    const pattern = String(config.pattern || "");
    const separator = !pattern || /[_\-. ]$/.test(pattern) ? "" : "_";
    props.onSetPattern(`${pattern}${separator}${token}`);
  };

  const removeUnsupported = () => {
    props.onSetSelection?.(items.filter((item) => item.kind !== "video" && item.kind !== "raw").map((item) => item.id));
  };

  return (
    <div className="feature-page batch-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">BATCH EXPORT</p>
          <h1>Prepare a batch export.</h1>
          <p className="page-subtitle">Rename, convert, resize, or strip metadata. Originals are never modified.</p>
        </div>
        {total > 0 && !busy && (
          <button className="quiet-button" type="button" onClick={props.onOpenLibrary}>
            Change selection
          </button>
        )}
      </div>

      <div className="batch-stepper" aria-label={`Step ${step} of 3`}>
        <span className={step === 1 ? "current" : step > 1 ? "done" : ""}><i>1</i>Select files</span>
        <b />
        <span className={step === 2 ? "current" : step > 2 ? "done" : ""}><i>2</i>Choose actions</span>
        <b />
        <span className={step === 3 ? "current" : ""}><i>3</i>Export copies</span>
      </div>

      {busy ? (
        <div className="batch-progress-panel">
          <div className="batch-progress-head">
            <span className="batch-spinner" aria-hidden="true" />
            <div>
              <b>Exporting copies…</b>
              <small>{progress?.currentFile || "Preparing the first file"}</small>
            </div>
            <span className="batch-progress-count">
              {Math.min(progress?.current || 0, progress?.total || total)} / {progress?.total || total}
            </span>
          </div>
          <div className="batch-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.total ? Math.round(((progress.current || 0) / progress.total) * 100) : 0}>
            <span style={{ width: `${progress?.total ? Math.max(3, Math.round(((progress.current || 0) / progress.total) * 100)) : 4}%` }} />
          </div>
          <div className="batch-progress-actions">
            <button className="quiet-button batch-cancel" type="button" onClick={props.onCancelBatch} disabled={cancelRequested}>
              <StopIcon size={13} /> {cancelRequested ? "Cancelling…" : "Cancel export"}
            </button>
            <span>{cancelRequested ? "Finishing the current file, then stopping." : "Finished copies are kept. The current file finishes before the export stops."}</span>
          </div>
          <p className="batch-note">Files are written one at a time. Keep this window open until the export finishes.</p>
        </div>
      ) : result ? (
        <div className="batch-result">
          <div className={`batch-result-hero${failed.length ? " has-failures" : ""}${cancelled ? " is-cancelled" : ""}`}>
            <span className="batch-result-icon">{cancelled ? <StopIcon size={22} /> : <CheckIcon size={24} />}</span>
            <div>
              <p className="eyebrow">{cancelled ? "EXPORT CANCELLED" : result.exported > 0 ? "BATCH COMPLETE" : "EXPORT STOPPED"}</p>
              <h2>
                {cancelled
                  ? `${result.exported.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? "copy" : "copies"} exported before cancelling`
                  : `${result.exported.toLocaleString()} ${result.exported === 1 ? "copy" : "copies"} exported`}
                {failed.length > 0 && <span> · {failed.length} failed</span>}
              </h2>
              <p>{cancelled ? "Stopped before the remaining files were written." : outputFolder || "Output folder"}</p>
            </div>
            <button className="quiet-button" type="button" onClick={props.onOpenFolder} disabled={!outputFolder}>
              <FolderIcon size={14} /> Open folder
            </button>
          </div>

          <div className="batch-result-stats">
            <div><span>Exported</span><b>{result.exported.toLocaleString()}</b></div>
            <div><span>Failed</span><b>{failed.length.toLocaleString()}</b></div>
            {cancelled && <div><span>Skipped</span><b>{skipped.toLocaleString()}</b></div>}
            <div><span>Destination</span><b>{folderDisplayName(outputFolder) || "—"}</b></div>
          </div>

          {result.outputs?.length > 0 && (
            <div className="batch-result-section">
              <div className="batch-preview-head"><b>Written files</b><small>originals untouched</small></div>
              <div className="batch-result-files">
                {result.outputs.slice(0, 8).map((path: string) => (
                  <div key={path} className="batch-result-file">
                    <CheckIcon size={12} />
                    <span title={path}>{path.split("/").pop()}</span>
                  </div>
                ))}
                {result.outputs.length > 8 && <small className="batch-result-more">+{result.outputs.length - 8} more</small>}
              </div>
            </div>
          )}

          {failed.length > 0 && (
            <div className="batch-result-section">
              <div className="batch-preview-head"><b>Couldn’t export</b><small>{failed.length} {failed.length === 1 ? "file" : "files"}</small></div>
              <div className="batch-failure-list">
                {(showAllFailures ? failed : failed.slice(0, 5)).map((failure: any, index: number) => (
                  <div key={`${failure.itemId}-${index}`} className="batch-failure">
                    <b>{failure.itemId ? failedName(failure.itemId) : "Export"}</b>
                    <small>{failure.error}</small>
                  </div>
                ))}
                {failed.length > 5 && (
                  <button className="batch-link-button" type="button" onClick={() => setShowAllFailures((value) => !value)}>
                    {showAllFailures ? "Show fewer" : `Show all ${failed.length} failures`}
                  </button>
                )}
              </div>
            </div>
          )}

          {error && <p className="batch-error">{error}</p>}

          <div className="batch-result-actions">
            <button className="primary-button" type="button" onClick={props.onReset}>{cancelled ? "Review settings" : "Export another batch"}</button>
            <button className="quiet-button" type="button" onClick={props.onOpenLibrary}>Back to Library</button>
          </div>
        </div>
      ) : (
        <div className="batch-layout">
          <div className="batch-main">
            <section className="batch-panel">
              <div className="batch-panel-head">
                <span className="batch-step-badge">1</span>
                <div>
                  <h2>Files in this batch</h2>
                  <p>Pick items in the Library, then return here. Removing a file only removes it from this batch.</p>
                </div>
                {total > 0 && <span className="batch-count-pill">{total.toLocaleString()} selected</span>}
              </div>

              {total === 0 ? (
                <div className="batch-empty">
                  <span className="batch-empty-icon"><BatchIcon size={22} /></span>
                  <b>No files in this batch yet</b>
                  <p>Select items in the Library grid and choose <strong>Batch</strong> from the selection bar, or select everything visible.</p>
                  <div className="batch-empty-actions">
                    <button className="primary-button" type="button" onClick={props.onOpenLibrary}>Go to Library</button>
                    <button className="quiet-button" type="button" onClick={props.onSelectAll}>Select all visible</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="batch-tray">
                    {items.slice(0, 10).map((item, index) => (
                      <button
                        key={item.id}
                        type="button"
                        className="batch-thumb"
                        onClick={() => props.onRemoveItem?.(item.id)}
                        title={`Remove ${item.name} from this batch`}
                      >
                        {item.kind === "photo" ? (
                          <CachedThumbnail itemId={item.id} name={item.name} size={128} />
                        ) : (
                          <span className={`batch-thumb-kind ${item.kind}`}>{item.kind === "raw" ? "RAW" : "VID"}</span>
                        )}
                        <span className="batch-thumb-remove" aria-hidden="true">×</span>
                        <span className="batch-thumb-number">{index + 1}</span>
                      </button>
                    ))}
                    {items.length > 10 && <span className="batch-thumb-more">+{items.length - 10}</span>}
                  </div>
                  <div className="batch-tray-actions">
                    <button className="quiet-button" type="button" onClick={props.onOpenLibrary}>Add more</button>
                    <button className="quiet-button" type="button" onClick={props.onSelectAll}>Select all visible</button>
                    <button className="quiet-button" type="button" onClick={props.onClearSelection}>Clear batch</button>
                  </div>
                  <div className="batch-tray-meta">
                    <span>{folders} photo{folders === 1 ? "" : "s"}</span>
                    {videos > 0 && <span>{videos} video{videos === 1 ? "" : "s"}</span>}
                    {raws > 0 && <span>{raws} RAW</span>}
                    <span>{formatBytesSimple(totalSize)}</span>
                    {unsupported > 0 && (
                      <button type="button" className="batch-tray-unsupported" onClick={removeUnsupported}>
                        {unsupported} unsupported · remove
                      </button>
                    )}
                    <span className="batch-tray-order">Exported in this order</span>
                  </div>
                </>
              )}
            </section>

            <section className="batch-panel">
              <div className="batch-panel-head">
                <span className="batch-step-badge">2</span>
                <div>
                  <h2>Output settings</h2>
                  <p>Choose where copies go, how they are named, and how they are encoded.</p>
                </div>
              </div>

              <div className={`batch-destination${outputFolder ? "" : " is-empty"}`}>
                <span className="batch-destination-icon"><FolderIcon size={17} /></span>
                <div className="batch-destination-copy">
                  <b>{outputFolder ? folderDisplayName(outputFolder) : "No destination chosen"}</b>
                  <small title={outputFolder}>{outputFolder || "Choose a folder for the exported copies."}</small>
                </div>
                <div className="batch-destination-actions">
                  <button className="quiet-button" type="button" onClick={props.onChooseFolder}>Choose…</button>
                  {outputFolder && <button className="quiet-button" type="button" onClick={props.onOpenFolder}>Open</button>}
                </div>
              </div>

              <div className="batch-field">
                <span className="batch-field-label"><span>Filename pattern</span></span>
                <input
                  className="batch-input"
                  value={config.pattern}
                  onChange={(event) => props.onSetPattern(event.target.value)}
                  spellCheck={false}
                  placeholder="{name}_{number}"
                  aria-label="Filename pattern"
                />
                <div className="batch-tokens">
                  <span className="batch-token-label">Insert</span>
                  {["{name}", "{number}", "{date}", "{ext}"].map((token) => (
                    <button key={token} type="button" className="batch-token" onClick={() => addToken(token)}>{token}</button>
                  ))}
                  <button type="button" className="batch-token batch-token-reset" onClick={() => props.onSetPattern("{name}_{number}")}>Reset</button>
                </div>
                <small className="batch-help">Live preview is on the right. Existing files are never overwritten — duplicates get a numeric suffix.</small>
              </div>

              <div className="batch-field">
                <span className="batch-field-label"><span>Output format</span></span>
                <div className="batch-format-grid" role="radiogroup" aria-label="Output format">
                  {BATCH_FORMATS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={config.format === option.value}
                      className={`batch-format-card${config.format === option.value ? " is-selected" : ""}`}
                      onClick={() => props.onSetFormat(option.value)}
                    >
                      <span className="batch-format-name">{option.label}</span>
                      <span className="batch-format-detail">{option.detail}</span>
                    </button>
                  ))}
                </div>
              </div>

              {config.format === "jpeg" ? (
                <div className="batch-field">
                  <span className="batch-field-label"><span>JPEG quality</span><b>{config.quality}%</b></span>
                  <input
                    className="batch-range"
                    type="range"
                    min={40}
                    max={100}
                    value={config.quality}
                    onChange={(event) => props.onSetQuality(Number(event.target.value))}
                    aria-label="JPEG quality"
                  />
                  <small className="batch-help">85–90 is a good balance between file size and detail. PNG and WebP export losslessly.</small>
                </div>
              ) : (
                <p className="batch-note">
                  {config.format === "source"
                    ? "Files that need no changes are copied byte-for-byte. If resizing or metadata stripping is on, they are re-encoded in their original format."
                    : config.format === "webp"
                      ? "WebP exports losslessly here, so the quality slider does not apply."
                      : "PNG exports losslessly, so the quality slider does not apply."}
                </p>
              )}

              <div className="batch-field">
                <span className="batch-field-label"><span>Maximum size</span></span>
                <select
                  className="batch-select"
                  value={config.maxDimension ?? "original"}
                  onChange={(event) => props.onSetMaxDimension(event.target.value === "original" ? null : Number(event.target.value))}
                  aria-label="Maximum image size"
                >
                  {BATCH_MAX_DIMENSIONS.map((option) => (
                    <option key={String(option.value)} value={option.value ?? "original"}>{option.label}</option>
                  ))}
                </select>
                <small className="batch-help">Images are scaled down proportionally; smaller images are never enlarged.</small>
              </div>

              <label className="batch-toggle">
                <input
                  type="checkbox"
                  checked={config.stripMetadata}
                  onChange={(event) => props.onSetStripMetadata(event.target.checked)}
                />
                <span className="batch-switch" aria-hidden="true"><span /></span>
                <span className="batch-toggle-copy">
                  <b>Strip metadata</b>
                  <small>Removes EXIF, GPS, and camera information when a file is re-encoded. Copies that need no changes keep their metadata.</small>
                </span>
              </label>

              <p className="batch-note batch-note-honest">
                <SparkleIcon size={14} />
                <span>Converting, resizing, or stripping always re-encodes the image. RAW and video files can only be copied unchanged in “Keep source” mode.</span>
              </p>

              {(videos > 0 || raws > 0) && unsupported > 0 && (
                <div className="batch-warning">
                  <span>
                    {unsupported} selected {unsupported === 1 ? "file needs" : "files need"} native macOS image support and will be reported as failed unless you choose “Keep source”, turn off resizing, and turn off metadata stripping.
                  </span>
                  <button
                    type="button"
                    className="batch-warning-action"
                    onClick={removeUnsupported}
                  >
                    Remove {unsupported} unsupported
                  </button>
                </div>
              )}
            </section>
          </div>

          <aside className="batch-summary">
            <div className="batch-summary-head">
              <b>Summary</b>
              <span>{total.toLocaleString()} {total === 1 ? "file" : "files"}</span>
            </div>

            <div className="batch-summary-stats">
              {summaryStats.map((stat) => (
                <div key={stat.label}><span>{stat.label}</span><b>{stat.value}</b></div>
              ))}
            </div>

            <div className="batch-summary-preview">
              <div className="batch-preview-head">
                <b>File names</b>
                <small>{total > 6 ? `first 6 of ${total}` : "in order"}</small>
              </div>
              {items.length === 0 ? (
                <div className="batch-preview-empty">
                  <b>Nothing to preview</b>
                  <small>Select files in the Library to see their new names.</small>
                </div>
              ) : (
                items.slice(0, 6).map((item, index) => (
                  <div key={item.id} className="batch-preview-row">
                    <span className="batch-preview-thumb">
                      {item.kind === "photo"
                        ? <CachedThumbnail itemId={item.id} name={item.name} size={128} />
                        : <span>{item.kind === "raw" ? "RAW" : "VID"}</span>}
                    </span>
                    <span className="batch-preview-name">
                      <small title={item.name}>{item.name}</small>
                      <b title={batchPreviewName(item, config.pattern, index, config.format)}>{batchPreviewName(item, config.pattern, index, config.format)}</b>
                    </span>
                  </div>
                ))
              )}
            </div>

            {error && <p className="batch-error">{error}</p>}
            {disabledReason && <p className="batch-hint">{disabledReason}</p>}

            <button
              className="primary-button batch-export"
              type="button"
              onClick={props.onExportBatch}
              disabled={Boolean(disabledReason) || busy}
            >
              <BatchIcon size={15} />
              {total > 0 ? `Export ${total.toLocaleString()} ${total === 1 ? "copy" : "copies"}` : "Export batch"}
            </button>
            <p className="batch-footnote">Originals are never modified, moved, or deleted.</p>
          </aside>
        </div>
      )}
    </div>
  );
}

/** Fan out up to three album photos like a loose stack of prints. */
function albumStackPose(count: number, index: number) {
  const poses =
    count === 1
      ? [{ x: -2, y: 0, r: -3, hx: -3, hy: -1, hr: -4 }]
      : count === 2
        ? [
            { x: -9, y: 5, r: -8, hx: -14, hy: 7, hr: -11 },
            { x: 8, y: -2, r: 7, hx: 13, hy: -4, hr: 10 },
          ]
        : [
            { x: -16, y: 8, r: -11, hx: -24, hy: 12, hr: -15 },
            { x: 0, y: -4, r: -1, hx: 0, hy: -7, hr: -2 },
            { x: 16, y: 7, r: 10, hx: 24, hy: 11, hr: 14 },
          ];
  return poses[index] || poses[0];
}

function AlbumPhotoStack({ photos, assetUrl, albumItems = [] }: { photos: any[]; assetUrl: (path: string) => string; albumItems?: any[] }) {
  const draftTransforms = useDraftTransforms();
  return (
    <span className="album-stack">
      {photos.map((item: any, photoIndex: number) => {
        const pose = albumStackPose(photos.length, photoIndex);
        return (
          <span
            key={item.id}
            className="album-stack-photo"
            style={{
              "--x": `${pose.x}%`,
              "--y": `${pose.y}%`,
              "--r": `${pose.r}deg`,
              "--hx": `${pose.hx}%`,
              "--hy": `${pose.hy}%`,
              "--hr": `${pose.hr}deg`,
              zIndex: photoIndex === 1 ? 3 : photoIndex === 2 ? 2 : 1,
            } as React.CSSProperties}
          >
            {albumItems[photoIndex]?.kind === "video" ? (
              <VideoThumb src={assetUrl(item.path)} name={item.name} />
            ) : (
              <img src={assetUrl(item.path)} alt="" loading="lazy" style={draftImageStyle(draftTransforms, item.id)} />
            )}
          </span>
        );
      })}
    </span>
  );
}

function AlbumsScreen(props: any) {
  const albums = React.useMemo(
    () =>
      (props.albums || []).map((album: any, index: number) => {
        const albumItems = (props.items || []).filter((item: any) =>
          item.albumIds?.includes(album.id) && !item.hidden
        );
        // Skip RAW-only files for the cover fan; they have no poster frame.
        const photos = albumItems
          .filter((item: any) => item.kind === "photo" || item.kind === "video")
          .slice(0, 3);
        if (false && photos.length) {
          console.log(`[AlbumsScreen] Album "${album.name}" (${album.id}) cover photos:`, photos.map((p: any) => p.name));
        }
        return {
          ...album,
          photos,
          // Count visible membership, not the backend's cached count: an album
          // can contain hidden items and must not leak them through a badge.
          count: albumItems.length,
          color: ["coral", "violet", "blue", "green"][index % 4],
        };
      }),
    [props.albums, props.items]
  );

  return (
    <div className="feature-page albums-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">COLLECTIONS</p>
          <h1>Albums</h1>
          <p className="page-subtitle">
            {albums.length.toLocaleString()} {albums.length === 1 ? "album" : "albums"} · Choose an album to see its photos.
          </p>
        </div>
      </div>

      {albums.length === 0 ? (
        <div className="empty-state albums-empty">
          <span><AlbumsIcon size={30} /></span>
          <b>No albums yet</b>
          <p>Create an album, then select photos in Library and choose Add to album.</p>
          <button className="primary-button" type="button" onClick={() => props.onCreateAlbum?.()}>
            <PlusIcon size={14} /> Create album
          </button>
        </div>
      ) : (
        <div className="albums-grid">
          {albums.map((album: any) => (
            <button
              key={album.id}
              type="button"
              className="album-card"
              onClick={() => props.onOpenAlbum(album.id)}
              onContextMenu={(e) => props.onAlbumContextMenu?.(album, e)}
              title={`Open ${album.name}`}
            >
              <span className={`album-cover ${album.photos.length ? "" : "is-empty"}`}>
                {album.photos.length ? (
                  <AlbumPhotoStack photos={album.photos} assetUrl={props.assetUrl} albumItems={(props.items || []).filter((i: any) => i.albumIds?.includes(album.id) && !i.hidden)} />
                ) : (
                  <span className="album-cover-placeholder">
                    <AlbumsIcon size={30} />
                    {album.count === 0 && <small>Empty</small>}
                  </span>
                )}
              </span>
              <span className="album-card-meta">
                <span className="album-card-name">
                  <i className={`album-dot ${album.color}`} />
                  <span>{album.name}</span>
                </span>
                <span className="album-card-count">
                  {album.count > 0 ? `${album.count.toLocaleString()} ${album.count === 1 ? "item" : "items"}` : "Empty"}
                </span>
              </span>
            </button>
          ))}
          <button
            type="button"
            className="album-card album-card-add"
            onClick={() => props.onCreateAlbum?.()}
            aria-label="Create new album"
          >
            <span className="album-cover-add">
              <PlusIcon size={28} />
            </span>
            <span className="album-card-meta">
              <span className="album-card-name">New album</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function DuplicatesScreen(props: any) {
  const draftTransforms = useDraftTransforms();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Progressive rendering for large duplicate result sets
  const [renderLimit, setRenderLimit] = useState(50);
  const scrollRef = useRef<HTMLDivElement>(null);

  const groups = props.groups || [];
  const totalCopies = useMemo(
    () => groups.reduce((sum: number, g: any) => sum + (g.items?.length || 0), 0),
    [groups]
  );
  const reclaimableBytes = useMemo(() => {
    let bytes = 0;
    groups.forEach((g: any) => {
      (g.items || []).slice(1).forEach((it: any) => {
        bytes += Number(it.size || 0);
      });
    });
    return bytes;
  }, [groups]);
  const selectedBytes = useMemo(() => {
    let bytes = 0;
    groups.forEach((g: any) => {
      (g.items || []).forEach((it: any) => {
        if (selected.has(it.id)) bytes += Number(it.size || 0);
      });
    });
    return bytes;
  }, [groups, selected]);

  React.useEffect(() => {
    const ids = new Set<string>();
    groups.forEach((g: any) => {
      (g.items || []).forEach((it: any, i: number) => {
        if (i > 0) ids.add(it.id);
      });
    });
    setSelected(ids);
  }, [groups]);

  useEffect(() => {
    setRenderLimit(50);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [groups]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || renderLimit >= groups.length) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) {
      setRenderLimit((n) => Math.min(n + 50, groups.length));
    }
  };

  const toggleAllGroups = (expand: boolean) => {
    if (expand) {
      const all = new Set<string>();
      groups.forEach((g: any) => all.add(g.sha256));
      setExpandedGroups(all);
    } else {
      setExpandedGroups(new Set());
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const groupSelectedIds = (group: any) =>
    (group.items || []).filter((it: any) => selected.has(it.id)).map((it: any) => it.id);

  const toggleGroupExpand = (sha256: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sha256)) next.delete(sha256);
      else next.add(sha256);
      return next;
    });
  };

  const isGroupExpanded = (sha256: string) => expandedGroups.has(sha256);
  const shortHash = (sha: string | undefined) => (sha || "").slice(0, 16);


  const groupItemsSelected = (group: any) =>
    (group.items || []).slice(1).every((it: any) => selected.has(it.id));

  const renderDuplicates = () => {

    if (groups.length === 0) {
      return (
        <div className="empty-state duplicate-empty">
          <span><DuplicatesIcon size={34} /></span>
          <b>No duplicates found</b>
          <p>Duplicate scans compare file content (SHA-256), not just names or sizes.</p>
          <button className="primary-button" type="button" onClick={props.onScan} disabled={props.busy}>
            Scan {props.items?.length || 0} files
          </button>
        </div>
      );
    }

    return (
      <>
        <div className="duplicate-batch-bar">
          <div className="duplicate-batch-summary">
            <span>{selected.size} of {totalCopies} copies selected</span>
            {selected.size > 0 && (
              <small>{formatBytesSimple(selectedBytes)} selected · {formatBytesSimple(reclaimableBytes)} can be reclaimed</small>
            )}
          </div>
          <div className="duplicate-batch-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={props.busy || selected.size === 0}
              onClick={() => props.onHideIds?.([...selected])}
            >
              Hide selected
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={props.busy || selected.size === 0}
              onClick={() => props.onRequestDeleteItems?.([...selected])}
            >
              Move selected to Trash
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={props.busy}
              onClick={() => {
                const ids = new Set<string>();
                groups.forEach((g: any) =>
                  (g.items || []).forEach((it: any, i: number) => {
                    if (i > 0) ids.add(it.id);
                  })
                );
                setSelected(ids);
              }}
            >
              Select all copies
            </button>
            <button className="quiet-button" type="button" disabled={props.busy} onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={props.busy || expandedGroups.size === 0}
              onClick={() => toggleAllGroups(false)}
            >
              Collapse all
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={props.busy || expandedGroups.size === groups.length}
              onClick={() => toggleAllGroups(true)}
            >
              Expand all
            </button>
          </div>
        </div>
        <div className="duplicate-scroll-container" ref={scrollRef} onScroll={handleScroll}>
          {groups.slice(0, renderLimit).map((group: any) => (
            <section className="duplicate-result" key={String(group.sha256)}>
              <div className="duplicate-group-head">
                <div className="duplicate-group-title">
                  <b>Identical files</b>
                  <span>{group.items?.length || 0} copies · SHA-256 match</span>
                  <span className="duplicate-group-hash">{shortHash(group.sha256)}</span>
                </div>
                <div className="duplicate-group-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={props.busy || groupSelectedIds(group).length === 0}
                    onClick={() => props.onHideIds?.(groupSelectedIds(group))}
                  >
                    Hide selected
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={props.busy || groupSelectedIds(group).length === 0}
                    onClick={() => props.onRequestDeleteItems?.(groupSelectedIds(group))}
                  >
                    Move to Trash
                  </button>
                  {group.items.length > 5 && (
                    <button
                      className="quiet-button"
                      type="button"
                      onClick={() => toggleGroupExpand(group.sha256)}
                    >
                      {isGroupExpanded(group.sha256) ? "Show fewer" : `Show all ${group.items.length}`}
                    </button>
                  )}
                </div>
              </div>
              <div className="duplicate-grid">
                {(() => {
                  const items = group.items || [];
                  const expanded = isGroupExpanded(group.sha256);
                  const visible = expanded ? items : items.slice(0, 3);
                  const showMore = !expanded && items.length > 3;
                  return (
                    <>
                      {visible.map((item: any, i: number) => (
                        <div
                          className={`duplicate-card${selected.has(item.id) ? " duplicate-card-selected" : ""}${
                            i === 0 ? " duplicate-card-keep" : ""
                          }`}
                          key={item.id}
                          onClick={(e: React.MouseEvent) => {
                            if (e.target instanceof HTMLInputElement) return;
                            toggleSelected(item.id);
                          }}
                        >
                          <input
                            type="checkbox"
                            className="duplicate-check"
                            checked={selected.has(item.id)}
                            aria-label={i === 0 ? "Keep original" : "Select copy"}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                              e.stopPropagation();
                              toggleSelected(item.id);
                            }}
                          />
                          {i === 0 && <span className="duplicate-keep-badge" title="Original copy">Original</span>}
                          <div className="duplicate-thumb">
                            {item.kind === "photo" ? (
                              <CachedThumbnail itemId={item.id} name={item.name} size={256} style={draftImageStyle(draftTransforms, item.id)} />
                            ) : (
                              <div className="duplicate-nonimage"><KindBadge kind={item.kind} /></div>
                            )}
                          </div>
                          <div className="duplicate-card-body">
                            <span className="duplicate-card-label">
                              {i === 0 ? "Keep original" : selected.has(item.id) ? "Selected copy" : "Copy"}
                            </span>
                            <div className="duplicate-card-meta">
                              <span title={item.name}>{item.name}</span>
                              <small title={item.path}>{formatBytesSimple(item.size)} · {item.path}</small>
                            </div>
                          </div>
                        </div>
                      ))}
                      {showMore && (
                        <div
                          className={`duplicate-card duplicate-card-showmore${selected.size > 0 && groupItemsSelected(group) ? " duplicate-card-selected" : ""}`}
                          key="show-all"
                          onClick={(e: React.MouseEvent) => {
                            if (e.target instanceof HTMLInputElement) return;
                            toggleGroupExpand(group.sha256);
                          }}
                        >
                          <input
                            type="checkbox"
                            className="duplicate-check"
                            checked={groupItemsSelected(group)}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                              e.stopPropagation();
                              const ids = new Set<string>();
                              (items || []).slice(1).forEach((it: any) => ids.add(it.id));
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (groupItemsSelected(group)) {
                                  ids.forEach((id) => next.delete(id));
                                } else {
                                  ids.forEach((id) => next.add(id));
                                }
                                return next;
                              });
                            }}
                          />
                          <span className="duplicate-showmore-label">
                            Show all {items.length - 3}
                          </span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </section>
          ))}
          {renderLimit < groups.length && (
            <div className="grid-more">
              <button type="button" className="quiet-button" onClick={() => setRenderLimit((n) => Math.min(n + 50, groups.length))}>
                Show {Math.min(50, groups.length - renderLimit)} more groups
              </button>
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <div className="feature-page duplicates-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Duplicates</p>
          <h1>Duplicate files</h1>
          <p className="page-subtitle">
            {groups.length === 0
              ? "Duplicate scans compare file content (SHA-256), not just names or sizes."
              : `${groups.length} group${groups.length === 1 ? "" : "s"} · ${totalCopies} copies · ${formatBytesSimple(reclaimableBytes)} reclaimable`}
          </p>
        </div>
        {!props.busy && groups.length > 0 && (
          <button className="quiet-button" type="button" onClick={props.onScan}>
            Rescan
          </button>
        )}
      </div>
      {renderDuplicates()}
    </div>
  );
}



// Browser-based media item creation (temporary until the Tauri backend is
// wired). Items are normalized to the same shape as the native catalog so the
// browser prototype and the Rust store agree on a single MediaItem layout.

function formatBytesSimple(bytes: number): string {
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


async function createMediaItemsBrowser(
  files: FileList | File[],
): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  for (const file of Array.from(files)) {
    if (!file.name || file.name.startsWith(".")) continue;
    const relativePath = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath || file.name;
    const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
    const videoExts = new Set(["m4v", "mov", "mp4", "mpeg", "mpg", "webm"]);
    const rawExts = new Set(["arw", "cr2", "cr3", "dng", "nef", "raf", "raw", "rw2"]);
    const imageExts = new Set(["avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);
    // "unsupported" is a sentinel for "no known kind" - it is not a MediaKind.
    let kind: MediaKind | "unsupported" = "unsupported";
    if (videoExts.has(ext)) kind = "video";
    else if (rawExts.has(ext)) kind = "raw";
    else if (imageExts.has(ext)) kind = "photo";
    if (kind === "unsupported") continue;

    const url = URL.createObjectURL(file);
    let width: number | undefined;
    let height: number | undefined;
    if (kind === "photo") {
      const img = new Image();
      await new Promise<void>((resolve) => {
        img.onload = () => {
          width = img.naturalWidth;
          height = img.naturalHeight;
          resolve();
        };
        img.onerror = () => resolve();
        img.src = url;
      });
      if (!width || !height) {
        // Could not read the dimensions - treat as unsupported and skip.
        URL.revokeObjectURL(url);
        continue;
      }
    }

    items.push({
      id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`,
      // Browser has no real absolute path; keep a session-relative stand-in.
      path: relativePath,
      name: file.name,
      extension: ext,
      kind,
      size: file.size,
      modifiedAt: file.lastModified,
      // In-memory import: the browser exposes no true capture time or camera
      // data, so fall back to the file's mtime for ordering.
      capturedAt: file.lastModified,
      width,
      height,
      favorite: false,
      hidden: false,
      tags: [],
      albumIds: [],
      createdAt: file.lastModified,
      updatedAt: file.lastModified,
    });
  }
  return items;
}

export default App;
