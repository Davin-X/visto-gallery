import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useKeyboard } from "../engine/hooks/useKeyboard";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
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
  refreshDraftMeta,
  useSlideshowStore,
  useBatchStore,
  useSettingsStore,
  useSystemDark,
  ACCENT_PALETTE,
  applyTheme,
  usePlaybackStore,
} from "../engine/stores";
import { canPlayVideoInApp, formatBytesSimple } from "../engine/utils/mediaTypes";
import { dispatchNativeMenuEvent } from "./nativeMenu";
import { isExportShortcut } from "./shortcuts";
import { shouldCheckForUpdatesOnLaunch } from "./startup";
import { navigateToBatchExport } from "./exportFlow";
import { getAdjacentVideo } from "./backgroundVideo";
import { createAutoImportController, syncFolderWatchers } from "../engine/utils/folderWatcher";
import { copyTagsToFinder } from "../engine/utils/finderTags";
import { progressBelongsToOperation } from "../engine/progressPhases";
import { describeError } from "./utils/describeError";
import { isWarningNotice } from "./utils/isWarningNotice";
import { startConfiguredSlideshow } from "./utils/startConfiguredSlideshow";
import { AppDialogs } from "./AppDialogs";
import { AppSidebar, AppTopBar } from "./AppNavigation";
import { AppShell } from "./AppShell";
import { AppScreenRouter } from "./AppScreenRouter";
import type { Screen } from "./screen";

import type { MediaItem } from "../engine/types/media";
import type {
  LibraryFolder,
  LibraryFilterDTO,
  LibraryStats,
  UpdateCheckResult,
} from "../engine/types/commands";
import { SlideshowOverlay } from "../design/components/SlideshowOverlay";
import { ContextMenu } from "../design/components/ContextMenu";
import { ShortcutsCheatSheet } from "../design/components/ShortcutsCheatSheet";

/** Modifier glyph for the "focus search" hint - Command on macOS, Ctrl elsewhere. */
function App() {
  const [screen, setScreen] = useState<Screen>("Library");
  const [screenHistory, setScreenHistory] = useState<Screen[]>([]);
  const [lastFolder, setLastFolder] = useState<string | null>(null);
  const [lastScreen, setLastScreen] = useState<Screen | null>(null);
  // Supported media extensions, fetched from the backend so the file picker
  // filter stays in sync with the backend scanner.
  const supportedExtensionsRef = useRef<string[] | null>(null);

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
  const animateTransitions = useSettingsStore((s) => s.animateTransitions);
  // Resolved appearance: the user's choice, or the OS setting when "system".
  const dark = appearance === "dark" || (appearance === "system" && systemDark);
  const [albumDialogOpen, setAlbumDialogOpen] = useState(false);
  const [albumDialogMode, setAlbumDialogMode] = useState<"create" | "rename">("create");
  const [albumName, setAlbumName] = useState("");
  const [albumSeedIds, setAlbumSeedIds] = useState<string[] | null>(null);
  const [renamingAlbumId, setRenamingAlbumId] = useState<string | null>(null);
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const albumInputRef = useRef<HTMLInputElement | null>(null);
  const albumDialogRef = useRef<HTMLFormElement | null>(null);
  const updateDialogRef = useRef<HTMLDivElement | null>(null);
  const aboutDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteAlbumDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteItemDialogRef = useRef<HTMLDivElement | null>(null);
  const removeFolderDialogRef = useRef<HTMLDivElement | null>(null);

  const [albumPendingDelete, setAlbumPendingDelete] = useState<any | null>(null);
  const [itemPendingDeleteCount, setItemPendingDeleteCount] = useState<number>(0);
  const itemPendingDeleteRef = useRef<string[] | null>(null);
  const watchedRootsRef = useRef<Set<string>>(new Set());
  const autoImportControllerRef = useRef<ReturnType<typeof createAutoImportController> | null>(
    null,
  );
  const [albumRemovePending, setAlbumRemovePending] = useState<{
    albumId: string;
    itemIds: string[];
  } | null>(null);
  const [deletingAlbum, setDeletingAlbum] = useState(false);

  // Removing a folder is confirmed through its own dialog so a stray click in
  // the sidebar can never drop a chunk of the library.
  const [folderPendingRemove, setFolderPendingRemove] = useState<LibraryFolder | null>(null);
  const [removingFolder, setRemovingFolder] = useState(false);
  const [sourcesSheetOpen, setSourcesSheetOpen] = useState(false);
  const [removeAllSourcesDialogOpen, setRemoveAllSourcesDialogOpen] = useState(false);

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
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [shortcutsCheatSheetOpen, setShortcutsCheatSheetOpen] = useState(false);
  // The global keydown handler is mounted once, so it reads the dialog state
  // through a ref rather than a stale closure.
  const updateDialogOpenRef = useRef(false);
  useEffect(() => {
    updateDialogOpenRef.current = updateDialogOpen;
  }, [updateDialogOpen]);
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
  const importPathsIntoAlbumRef = useRef<(paths: string[], albumId: string) => Promise<void>>(
    async () => {},
  );

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

  // Sidebar summary from the catalog (exact counts, not loaded-page counts).
  const [libraryStats, setLibraryStats] = useState<LibraryStats>({
    photos: 0,
    videos: 0,
    raws: 0,
    animations: 0,
    uncategorized: 0,
    favorites: 0,
    hidden: 0,
    photoSize: 0,
    videoSize: 0,
    rawSize: 0,
    uncategorizedSize: 0,
    favoriteSize: 0,
    hiddenSize: 0,
    totalSize: 0,
  });

  const statsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void refreshDraftMeta();
    let cancelled = false;
    tauri.library
      .getStats()
      .then((stats) => {
        if (!cancelled) setLibraryStats(stats);
      })
      .catch((e) => {
        if (import.meta.env.DEV) console.error("get_library_stats failed:", e);
      });

    let unlisten: (() => void) | null = null;
    events
      .onLibraryChanged(() => {
        if (statsDebounceRef.current) {
          clearTimeout(statsDebounceRef.current);
        }
        statsDebounceRef.current = setTimeout(() => {
          statsDebounceRef.current = null;
          tauri.library
            .getStats()
            .then(setLibraryStats)
            .catch(() => {});
        }, 500);
      })
      .then((u) => {
        unlisten = u;
      });
    return () => {
      cancelled = true;
      if (statsDebounceRef.current) {
        clearTimeout(statsDebounceRef.current);
        statsDebounceRef.current = null;
      }
      if (unlisten) unlisten();
    };
  }, []);

  const viewer = useViewerStore();
  const edit = useEditStore();
  const batch = useBatchStore();
  const settings = useSettingsStore();

  // The player keeps its own selection while the photo viewer has an
  // independent cursor.
  const [backgroundVideo, setBackgroundVideo] = useState<MediaItem | null>(null);
  // Locked video queue: captured when playback starts so switching filters
  // mid-playback never changes what plays next.
  const [videoQueue, setVideoQueue] = useState<MediaItem[]>([]);
  const [queueAutoPlayId, setQueueAutoPlayId] = useState<string | null>(null);
  const videoQueuePagingRef = useRef<{
    filter: LibraryFilterDTO;
    cursor: string | null;
    hasMore: boolean;
    pageSize: number;
    loading: boolean;
  } | null>(null);
  const playbackItemId = usePlaybackStore((s) => s.itemId);
  const fhPlaying = usePlaybackStore((s) => s.playing);
  const playbackName = usePlaybackStore((s) => s.name);
  const storedPlaybackItem = useMemo(
    () => library.items.find((item) => item.id === playbackItemId) ?? null,
    [library.items, playbackItemId],
  );
  const playbackItem = backgroundVideo ?? storedPlaybackItem;
  const photoViewerItems = useMemo(() => {
    const items = library.viewerItems.filter((item) => item.kind !== "video");
    const selected = library.viewerSelected;
    if (selected && selected.kind !== "video" && !items.some((item) => item.id === selected.id)) {
      return [selected, ...items];
    }
    return items;
  }, [library.viewerItems, library.viewerSelected]);
  // Video queue: built from the current browsing scope when playback starts,
  // skipping photos and RAW. Locked during playback so switching filters
  // never changes what plays next.
  const loadNextVideoPage = useCallback(async () => {
    const paging = videoQueuePagingRef.current;
    if (!paging || !paging.hasMore || !paging.cursor || paging.loading) return [];

    paging.loading = true;
    try {
      const page = await tauri.library.getItems({
        ...paging.filter,
        limit: paging.pageSize,
        cursor: paging.cursor,
      });
      videoQueuePagingRef.current = {
        ...paging,
        cursor: page.nextCursor ?? null,
        hasMore: page.hasMore,
        loading: false,
      };
      const knownIds = new Set(videoQueue.map((item) => item.id));
      const videos = page.items.filter(
        (item) =>
          item.kind === "video" &&
          canPlayVideoInApp(item.path, item.name) &&
          !knownIds.has(item.id),
      );
      if (videos.length > 0) {
        setVideoQueue((current) => {
          const currentIds = new Set(current.map((item) => item.id));
          return [...current, ...videos.filter((item) => !currentIds.has(item.id))];
        });
      }
      return videos;
    } catch (error) {
      videoQueuePagingRef.current = { ...paging, loading: false };
      useLibraryStore.getState().showNotice(`Failed to load more videos: ${String(error)}`);
      return [];
    }
  }, [videoQueue]);

  const playNextVideo = useCallback(async (): Promise<boolean> => {
    if (videoQueue.length === 0) return false;
    const currentId = usePlaybackStore.getState().itemId ?? backgroundVideo?.id ?? null;
    const currentIndex = videoQueue.findIndex((item) => item.id === currentId);
    let next: MediaItem | null = null;
    if (currentIndex === videoQueue.length - 1) {
      while (videoQueuePagingRef.current?.hasMore && videoQueuePagingRef.current.cursor) {
        const pageVideos = await loadNextVideoPage();
        if (pageVideos.length > 0) {
          next = pageVideos[0];
          break;
        }
        if (videoQueuePagingRef.current?.loading) return false;
      }
    }
    next ??= getAdjacentVideo(videoQueue, currentId, 1);
    if (!next) return false;
    if (next.id === currentId) {
      usePlaybackStore.getState().toggle();
      return true;
    }

    setQueueAutoPlayId(next.id);
    setBackgroundVideo(next);
    return true;
  }, [videoQueue, backgroundVideo, loadNextVideoPage]);

  const playPreviousVideo = useCallback((): boolean => {
    if (videoQueue.length === 0) return false;
    const currentId = usePlaybackStore.getState().itemId ?? backgroundVideo?.id ?? null;
    const previous = getAdjacentVideo(videoQueue, currentId, -1);
    if (!previous) return false;
    if (previous.id === currentId) {
      const video = usePlaybackStore.getState().element;
      if (video) {
        video.currentTime = 0;
        void video.play().catch(() => {});
      }
      return true;
    }

    setQueueAutoPlayId(previous.id);
    setBackgroundVideo(previous);
    return true;
  }, [videoQueue, backgroundVideo]);

  // Capture the video-only queue once for a playback session. If the user
  // explicitly selects a video outside that queue, start a queue in the new
  // browsing scope; changing filters alone leaves the current queue intact.
  useEffect(() => {
    if (!playbackItemId) {
      if (!backgroundVideo) {
        if (videoQueue.length > 0) setVideoQueue([]);
        videoQueuePagingRef.current = null;
        if (queueAutoPlayId !== null) setQueueAutoPlayId(null);
      }
      return;
    }

    if (videoQueue.length === 0) {
      const state = useLibraryStore.getState();
      const nextQueue = library.viewerItems.filter(
        (item) => item.kind === "video" && canPlayVideoInApp(item.path, item.name),
      );
      if (backgroundVideo && !nextQueue.some((item) => item.id === backgroundVideo.id))
        nextQueue.unshift(backgroundVideo);
      // Leave the queue empty when this scope has no playable videos yet:
      // writing a fresh [] reference would retrigger this effect through
      // its own `videoQueue` dependency until React throws #185. The queue
      // is rebuilt once `viewerItems` gains a playable video.
      if (nextQueue.length === 0) return;
      setVideoQueue(nextQueue);
      if (!videoQueuePagingRef.current && state.viewerScope === "library") {
        videoQueuePagingRef.current = {
          filter: state.getCurrentLibraryFilter(),
          cursor: state.nextCursor,
          hasMore: state.hasMore,
          pageSize: state.pageSize,
          loading: false,
        };
      }
    }
  }, [playbackItemId, library.viewerItems, videoQueue, backgroundVideo]);

  useEffect(() => {
    if (queueAutoPlayId && playbackItemId === queueAutoPlayId && fhPlaying) {
      setQueueAutoPlayId(null);
    }
  }, [queueAutoPlayId, playbackItemId, fhPlaying]);

  // Ensure screen state matches viewer state on mount/hydration.
  useEffect(() => {
    if (screen === "Viewer" && !viewer.isOpen) viewer.open();
  }, [screen, viewer.isOpen, viewer.open]);

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
    if (target?.closest("button, a, input, select, textarea, [role='button'], [data-no-drag]"))
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
    if (target?.closest("button, a, input, select, textarea, [role='button']")) return;
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
      const filled = outer.width >= work.size.width - 8 && outer.height >= work.size.height - 8;

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
        const chromeHeight = Math.max(0, (outerBefore.height - inner.height) / scale);
        preFillSizeRef.current = {
          width: inner.width / scale,
          height: inner.height / scale,
        };
        await win.setPosition(new PhysicalPosition(work.position.x, work.position.y));
        await win.setSize(
          new LogicalSize(Math.max(1, workWidth - 2), Math.max(1, workHeight - chromeHeight - 2)),
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
    if (path.startsWith("blob:") || path.startsWith("data:") || path.startsWith("http"))
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
    exportToBatch: () => void;
    showNotice: (text: string) => void;
    checkUpdates: (manual?: boolean) => void;
    navigateViewer: (delta: number) => void;
    navigateVideo: (delta: -1 | 1) => void;
    openViewer: (id: string) => void;
  }>({
    importFolder: () => {},
    importFiles: () => {},
    exportToBatch: () => {},
    showNotice: () => {},
    checkUpdates: () => {},
    navigateViewer: () => {},
    navigateVideo: () => {},
    openViewer: () => {},
  });

  // Unified keyboard shortcuts: a single window listener chains all handlers.
  // Handlers read fresh state through liveRef / handlersRef so this stays
  // correct across StrictMode remounts without re-subscribing.
  useKeyboard([handleKeyDown]);

  function handleKeyDown(e: KeyboardEvent) {
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

    // ⌘/ / Ctrl+/ toggles the keyboard shortcuts cheat sheet.
    if (mod && key === "/") {
      e.preventDefault();
      setShortcutsCheatSheetOpen((open) => !open);
      return;
    }

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
      sourcesSheetOpen ||
      updateDialogOpenRef.current ||
      shortcutsCheatSheetOpen
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
    if (isExportShortcut(e)) {
      e.preventDefault();
      handlersRef.current.exportToBatch();
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
      if (!isEditable && (screen === "Library" || screen === "Hidden" || screen === "Albums")) {
        e.preventDefault();
        const items = screen === "Hidden" ? library.hiddenItems : library.visibleItems;
        const selectedSet = new Set(library.selectedIds);
        const allSelected =
          items.length > 0 && items.every((item: any) => selectedSet.has(item.id));
        library.setSelectedIds(allSelected ? [] : items.map((item: any) => item.id));
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
            (document.querySelector(".search-field input") as HTMLInputElement | null);
          input?.focus();
          input?.select();
        };
        // Both the Library and Hidden screens own a search field. Jump to
        // Library only when neither is on screen, then focus once mounted.
        if (screen !== "Library" && screen !== "Hidden" && screen !== "Video") {
          setScreen("Library");
          let attempts = 0;
          const tryFocus = () => {
            const input =
              searchInputRef.current ||
              (document.querySelector(".search-field input") as HTMLInputElement | null);
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
    if ((screen === "Viewer" || screen === "Video") && !e.defaultPrevented) {
      const target = e.target as HTMLElement;
      const isEditable =
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT";
      if (!isEditable && e.key === "ArrowRight") {
        if (screen === "Video") handlersRef.current.navigateVideo(1);
        else handlersRef.current.navigateViewer(1);
      }
      if (!isEditable && e.key === "ArrowLeft") {
        if (screen === "Video") handlersRef.current.navigateVideo(-1);
        else handlersRef.current.navigateViewer(-1);
      }
    }
    if (e.key === "Escape") {
      if (screen === "Viewer") {
        viewer.close();
        setScreen(viewerOrigin || "Library");
      } else if (screen === "Video") {
        setScreen(viewerOrigin || "Library");
      } else if (library.showInspector) {
        library.toggleInspector();
      }
    }
    if (e.key === "Enter" && mod && screen === "Hidden" && library.inspectedId) {
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
    if (e.key === "Enter" && mod && screen === "Library" && library.inspectedId) {
      handlersRef.current.openViewer(library.inspectedId);
    }
  }

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");

    // Opening the saved catalog is cheap; source scans are always user-started.
    liveRef.current.library.loadLibrary();
    // Hidden items are filtered out of the main query, so load them
    // separately to power the Hidden screen's counts and grid.
    void liveRef.current.library.loadHiddenItems();
    liveRef.current.settings.hydrate();

    // Fetch the canonical list of supported extensions from the backend so the
    // file picker filter stays in sync with the backend scanner.
    if (supportedExtensionsRef.current === null) {
      void tauri.library.supportedExtensions().then((exts) => {
        supportedExtensionsRef.current = exts;
      });
    }

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
      const menuHandlers = {
        importFolder: () => handlersRef.current.importFolder(),
        importFiles: () => handlersRef.current.importFiles(),
        exportToBatch: () => handlersRef.current.exportToBatch(),
        toggleSidebar: () => liveRef.current.library.toggleSidebar(),
        toggleInspector: () => liveRef.current.library.toggleInspector(),
        zoomIn: () => liveRef.current.viewer.zoomIn(),
        zoomOut: () => liveRef.current.viewer.zoomOut(),
        showAbout: () => setAboutOpen(true),
        checkUpdates: () => handlersRef.current.checkUpdates(true),
      };
      for (const event of [
        "menu-open-folder",
        "menu-import-files",
        "menu-export",
        "menu-toggle-sidebar",
        "menu-toggle-inspector",
        "menu-zoom-in",
        "menu-zoom-out",
        "menu-about",
        "menu-check-updates",
      ]) {
        await register(event, () => dispatchNativeMenuEvent(event, menuHandlers));
      }

      // Listen for native import progress events from scan/import commands.
      let lastProgressApplyAt = 0;
      let progressTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingProgress: any = null;
      const applyProgress = (p: any) => {
        const { phase, processed, total } = p;
        const currentPhase = liveRef.current.library.progress?.phase ?? "";
        // The command that started an operation owns `busy` and `progress`.
        // Progress events are presentation-only: don't let a scan/import
        // event flip the overlay away from an active operation (e.g. trash).
        // Conversely, allow the active operation's own events to update it —
        // which needs the phase mapping, because an import reports `scanning`.
        if (!progressBelongsToOperation(currentPhase, phase)) return;
        liveRef.current.library.setProgress({
          phase,
          processed,
          total,
          bytesProcessed: p.bytesProcessed,
          bytesTotal: p.bytesTotal,
          filesProcessed: p.filesProcessed,
          filesTotal: p.filesTotal,
          currentFile: p.currentFile,
        });
      };
      const unlistenImportProgress = await events.onImportProgress((progress) => {
        const now = Date.now();
        const minIntervalMs = 200;
        // Always apply terminal/first updates promptly; throttle rapid progress.
        if (
          progress.processed === progress.total ||
          now - lastProgressApplyAt >= minIntervalMs
        ) {
          lastProgressApplyAt = now;
          if (progressTimer) {
            clearTimeout(progressTimer);
            progressTimer = null;
          }
          pendingProgress = null;
          applyProgress(progress);
          return;
        }
        pendingProgress = progress;
        if (!progressTimer) {
          progressTimer = setTimeout(() => {
            progressTimer = null;
            if (pendingProgress) {
              lastProgressApplyAt = Date.now();
              applyProgress(pendingProgress);
              pendingProgress = null;
            }
          }, minIntervalMs - (now - lastProgressApplyAt));
        }
      });
      unlisteners.push(() => {
        if (progressTimer) clearTimeout(progressTimer);
        unlistenImportProgress();
      });
      autoImportControllerRef.current = createAutoImportController({
        isEnabled: () => useSettingsStore.getState().autoImport,
        scan: async (path) => {
          await tauri.library.scan(path, false);
          await liveRef.current.library.loadLibrary();
          await liveRef.current.library.loadFolders();
        },
        onError: (path, error) => {
          liveRef.current.library.showNotice(
            `Could not auto-import changes from ${path}: ${describeError(error)}`,
          );
        },
      });
      const unlistenFolderChanged = await events.onFolderChanged((path) => {
        autoImportControllerRef.current?.changed(path);
      });
      const unlistenWatchError = await events.onFolderWatchError(({ path, message }) => {
        liveRef.current.library.showNotice(
          `Folder watching stopped for ${path}: ${message}. Check the folder's macOS access permissions and re-add the source if needed.`,
        );
      });
      unlisteners.push(unlistenFolderChanged, unlistenWatchError);
    };
    listen();

    return () => {
      cancelled = true;
      autoImportControllerRef.current?.cancel();
      unlisteners.forEach((un) => un());
    };
    // Mount-only. Handlers read fresh state through liveRef / handlersRef.
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
      } catch {
        /* browser preview - no native window */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dark, appearance, accentColor]);

  // Honor the startup_view setting once settings are hydrated: open to the
  // Library, the last screen/folder, or start a slideshow.
  const startupView = useSettingsStore((s) => s.startupView);
  const openLastFolder = useSettingsStore((s) => s.openLastFolder);
  const didRunStartup = useRef(false);
  useEffect(() => {
    if (!settingsHydrated || didRunStartup.current) return;
    didRunStartup.current = true;
    if (startupView === "slideshow") {
      // Slideshow needs items; open Library first so the user can pick one.
      setScreen("Library");
      return;
    }
    if (startupView === "last" && openLastFolder && lastScreen === "Albums" && lastFolder) {
      library.setActiveAlbum(lastFolder);
      library.setFilter("All");
      library.setQuery("");
      library.loadAlbumItems(lastFolder);
      setScreen("Library");
      return;
    }
    if (startupView === "last" && lastScreen) {
      setScreen(lastScreen);
      return;
    }
    // Default: Library.
    setScreen("Library");
  }, [settingsHydrated, startupView, openLastFolder, lastScreen, lastFolder, library]);

  // Track the last screen and folder the user visited so startup_view="last"
  // can restore them on the next launch.
  useEffect(() => {
    if (screen !== "Library" && screen !== "Hidden") {
      setLastScreen(screen);
    }
    if (library.activeAlbum) {
      setLastFolder(library.activeAlbum);
      setLastScreen("Albums");
    }
  }, [screen, library.activeAlbum]);

  const showNotice = useCallback((text: string) => {
    useLibraryStore.getState().showNotice(text);
  }, []);

  // File > Export… and Cmd/Ctrl+E share this action. Batch Export already
  // renders a useful empty state, so an empty selection is a prompt, not an
  // error, and a real selection is passed through unchanged.
  const exportToBatch = useCallback(() => {
    const state = useLibraryStore.getState();
    navigateToBatchExport({
      selectedIds: state.selectedIds,
      setScreen,
      setSelection: state.setSelectedIds,
      showNotice,
    });
  }, [showNotice]);

  const checkForUpdates = useCallback(
    async (manual = false) => {
      if (manual) setUpdateChecking(true);
      try {
        const result = await tauri.app.checkUpdates(manual);
        if (!result.available) {
          if (manual) {
            showNotice(`You're up to date on v${result.currentVersion}.`);
          }
          return;
        }
        // Skipping a version silences the launch prompt only; an explicit
        // menu check should always surface it again.
        const skipped = localStorage.getItem(`update:skip:${result.latestVersion}`);
        if (!manual && skipped === "1") return;
        setUpdateInfo(result);
        setAboutOpen(false);
        setUpdateDialogOpen(true);
      } catch (error) {
        if (manual) {
          showNotice(`Could not check for updates: ${describeError(error)}`);
        }
      } finally {
        if (manual) setUpdateChecking(false);
      }
    },
    [showNotice],
  );

  // Automatic launch checks are opt-in and default off. The explicit Help menu
  // action bypasses this gate and always works.
  const checkForUpdatesOnLaunch = useSettingsStore((s) => s.checkForUpdatesOnLaunch);
  const didScheduleLaunchUpdate = useRef(false);
  useEffect(() => {
    if (!settingsHydrated || didScheduleLaunchUpdate.current) return;
    didScheduleLaunchUpdate.current = true;
    if (!shouldCheckForUpdatesOnLaunch({ checkForUpdatesOnLaunch })) return;
    // The backend caches the answer for 24 hours, so this stays well inside
    // GitHub's unauthenticated limit.
    const timer = window.setTimeout(() => {
      void checkForUpdates(false);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [settingsHydrated, checkForUpdatesOnLaunch, checkForUpdates]);

  // Restore native watchers for explicitly registered roots after launch and
  // whenever sources change. Turning auto-import off also stops watching, so
  // the setting describes actual behavior rather than only future scans.
  const autoImport = useSettingsStore((s) => s.autoImport);
  const folderSignature = library.folders
    .map((folder) => folder.path)
    .sort()
    .join("\n");
  useEffect(() => {
    const isTauri =
      typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
    if (!settingsHydrated || !isTauri) return;
    let cancelled = false;

    const sync = async () => {
      const roots = autoImport
        ? await tauri.library.getRoots().catch((error) => {
            if (!cancelled) {
              showNotice(
                `Could not read library sources for folder watching: ${describeError(error)}`,
              );
            }
            return [] as string[];
          })
        : [];
      if (cancelled) return;
      const result = await syncFolderWatchers(roots, watchedRootsRef.current, {
        watch: (path) => tauri.library.watchFolder(path),
        unwatch: (path) => tauri.library.unwatchFolder(path),
      });
      if (cancelled) return;
      watchedRootsRef.current = result.watched;
      for (const failure of result.errors) {
        showNotice(
          `Could not ${roots.includes(failure.path) ? "watch" : "stop watching"} ${failure.path}: ${describeError(failure.error)}. Check macOS folder access permissions.`,
        );
      }
    };

    void sync();
    return () => {
      cancelled = true;
    };
  }, [settingsHydrated, autoImport, folderSignature, showNotice]);

  // Startup deletion scan: detect files removed from Finder while the app was
  // closed, so they never linger as stale catalog rows. This runs once per
  // launch regardless of the autoImport setting. Unchanged files are skipped
  // quickly via the size/modified_at fast path, so this is a lightweight
  // cleanup pass rather than a full re-import.
  useEffect(() => {
    if (!settingsHydrated) return;
    const isTauri =
      typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
    if (!isTauri) return;
    let cancelled = false;
    void (async () => {
      const roots = await tauri.library.getRoots().catch(() => [] as string[]);
      if (cancelled || roots.length === 0) return;
      for (const root of roots) {
        if (cancelled) break;
        await tauri.library.scan(root, false).catch(() => {});
      }
      if (cancelled) return;
      await liveRef.current.library.loadLibrary();
      await liveRef.current.library.loadFolders();
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsHydrated]);

  const copyTagsToFinderForIds = useCallback(
    async (ids: string[]) => {
      const items = useLibraryStore.getState().items.filter((item) => ids.includes(item.id));
      if (items.length === 0) return;
      const result = await copyTagsToFinder(items, (path, tags) =>
        tauri.finder.mergeTags(path, tags),
      );
      if (result.failed.length > 0) {
        const details = result.failed
          .slice(0, 3)
          .map((failure) => `${failure.path}: ${failure.error}`)
          .join("; ");
        showNotice(
          `Copied tags to ${result.updated} of ${items.length} file(s). ${result.failed.length} failed: ${details}${result.failed.length > 3 ? "; …" : ""}`,
        );
      } else if (result.updated > 0) {
        showNotice(
          `Copied tags to Finder for ${result.updated} ${result.updated === 1 ? "file" : "files"}. Existing Finder tags were kept.`,
        );
      } else {
        showNotice("No VistoGallery tags to copy for the selected items.");
      }
    },
    [showNotice],
  );

  // Warn when the library is very large and show_native_limit_warnings is on.
  const showNativeWarnings = useSettingsStore((s) => s.showNativeLimitWarnings);
  useEffect(() => {
    if (!showNativeWarnings) return;
    const total =
      libraryStats.photos + libraryStats.videos + libraryStats.raws + libraryStats.uncategorized;
    if (total > 10000) {
      showNotice(
        `Large library (${total.toLocaleString()} items) — thumbnail generation and scrolling may be slower on this system.`,
      );
    }
  }, [
    showNativeWarnings,
    libraryStats.photos,
    libraryStats.videos,
    libraryStats.raws,
    libraryStats.uncategorized,
    showNotice,
  ]);

  const navigateViewer = useCallback(
    async (delta: number) => {
      const navigated = await useLibraryStore.getState().navigateViewerPhoto(delta);
      if (navigated) viewer.resetTransform();
    },
    [viewer.resetTransform],
  );

  const selectViewerItem = useCallback((id: string) => {
    const libraryState = useLibraryStore.getState();
    const item = libraryState.viewerItems.find((candidate) => candidate.id === id);
    if (!item || item.kind === "video") return;
    libraryState.inspectItem(id);
  }, []);

  const selectVideoItem = useCallback(
    (id: string) => {
      const item = videoQueue.find((candidate) => candidate.id === id);
      if (!item) return;
      setBackgroundVideo(item);
      setQueueAutoPlayId(id);
    },
    [videoQueue],
  );

  const navigateVideoQueue = useCallback(
    (delta: -1 | 1) => {
      if (delta > 0) {
        void playNextVideo();
        return;
      }
      const currentId = usePlaybackStore.getState().itemId ?? backgroundVideo?.id ?? null;
      const next = getAdjacentVideo(videoQueue, currentId, delta);
      if (!next) return;
      setBackgroundVideo(next);
      setQueueAutoPlayId(next.id);
    },
    [backgroundVideo, videoQueue, playNextVideo],
  );

  // Route photos to the photo viewer and videos to the independent player.
  // Shared setup for a video playback session: scope the queue to the
  // session's collection and lock it, so later filter changes never rewrite
  // what plays next.
  const beginVideoSession = useCallback(
    (item: MediaItem, scope: "library" | "hidden" = "library") => {
      library.setViewerScope(scope);
      // Silence every other <video> surface (slideshow, compare, inspector)
      // before this session starts, so the same file can't sound from two
      // players at once. The inspector preview and thumbnails are muted, so
      // this only ever hits the slideshow and stale players.
      document.querySelectorAll("video").forEach((video) => {
        try {
          video.pause();
        } catch {}
      });
      const libraryState = useLibraryStore.getState();
      const scopedVideos = libraryState.viewerItems.filter(
        (candidate) =>
          candidate.kind === "video" && canPlayVideoInApp(candidate.path, candidate.name),
      );
      if (!scopedVideos.some((candidate) => candidate.id === item.id)) scopedVideos.unshift(item);
      setVideoQueue(scopedVideos);
      videoQueuePagingRef.current =
        scope === "library"
          ? {
              filter: libraryState.getCurrentLibraryFilter(),
              cursor: libraryState.nextCursor,
              hasMore: libraryState.hasMore,
              pageSize: libraryState.pageSize,
              loading: false,
            }
          : null;
      setBackgroundVideo(item);
    },
    [library],
  );

  const openViewer = useCallback(
    (id?: string, origin: Screen = "Library", scope: "library" | "hidden" = "library") => {
      const lib = useLibraryStore.getState();
      const targetId = id ?? lib.inspectedId;
      const item =
        lib.items.find((candidate) => candidate.id === targetId) ??
        lib.hiddenItems.find((candidate) => candidate.id === targetId) ??
        lib.duplicates.flatMap((g) => g.items).find((candidate) => candidate.id === targetId) ??
        null;
      if (!item) return;
      setViewerOrigin(origin);
      const viewerState = useViewerStore.getState();
      if (item.kind === "video") {
        beginVideoSession(item, scope);
        viewerState.close();
        setScreen("Video");
      } else {
        lib.setViewerScope(scope);
        viewerState.open(item.id);
        setScreen("Viewer");
      }
    },
    [beginVideoSession],
  );

  // Start a video session without leaving the current screen; the Now
  // Playing chip is the way back to the player.
  const playVideoInBackground = useCallback(
    (id?: string, scope: "library" | "hidden" = "library") => {
      const targetId = id ?? library.inspectedId;
      const item =
        library.items.find((candidate) => candidate.id === targetId) ??
        library.hiddenItems.find((candidate) => candidate.id === targetId) ??
        null;
      if (!item || item.kind !== "video") return;
      beginVideoSession(item, scope);
    },
    [library, beginVideoSession],
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
        ? library.visibleItems.filter((item: MediaItem) => selection.has(item.id))
        : [];
      const visibleSelectionIds = new Set(visibleSelection.map((item) => item.id));
      const offscreenSelection = selection
        ? library.items.filter(
            (item: MediaItem) => selection.has(item.id) && !visibleSelectionIds.has(item.id),
          )
        : [];
      const scope = selection ? [...visibleSelection, ...offscreenSelection] : library.visibleItems;
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

  // Focus the name field as soon as the dialog mounts. Escape is owned by the
  // dialog layer (AppDialogs), not by this effect.
  useEffect(() => {
    if (!albumDialogOpen) return;
    const frame = requestAnimationFrame(() => {
      albumInputRef.current?.focus();
      albumInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [albumDialogOpen]);

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
      const ids = (itemIds && itemIds.length ? itemIds : library.selectedIds).filter(Boolean);
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
    return () => cancelAnimationFrame(frame);
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
        const result = await library.deleteItems(ids);
        const moved = result.status === "failed" ? 0 : result.trashed;
        // The duplicate manager can remove rows that are outside the loaded
        // page, so refresh canonical source/library totals after the native
        // transaction rather than estimating them from rendered tiles.
        if (moved > 0) {
          void tauri.library
            .getStats()
            .then(setLibraryStats)
            .catch(() => {});
        }
        if (result.status === "cancelled") {
          showNotice("Deletion cancelled.");
        } else if (result.status === "failed") {
          showNotice(
            `Could not move items to Trash: ${result.failures[0]?.error ?? "unknown error"}`,
          );
          if (result.failures.length > 1) {
            console.warn("Trash refusals", result.failures);
          }
        } else if (moved > 0) {
          const suffix = result.failed ? ` ${result.failed} item(s) could not be moved.` : "";
          const warning = result.catalogWarning
            ? " The catalog could not be updated; rescan to refresh the library."
            : "";
          // Lead with the space that is actually gone from the disk, which is
          // the number people care about after a duplicate cleanup.
          const reclaimed =
            result.bytes > 0 ? ` — ${formatBytesSimple(result.bytes)} reclaimed` : "";
          showNotice(
            `Moved ${moved.toLocaleString()} item${moved === 1 ? "" : "s"} to Trash${reclaimed}.${suffix}${warning}`,
          );
          if (result.failures.length > 0) console.warn("Trash refusals", result.failures);
        }
      } catch (error) {
        const msg = String(error);
        if (msg !== "Cancelled") {
          showNotice(`Could not delete: ${describeError(error)}`);
        }
      }
    })();
  };

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
        filters: [{ name: "Media", extensions: supportedExtensionsRef.current ?? [] }],
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

  const openSmartAlbum = async (albumId: string) => {
    await library.openSmartAlbum(albumId);
    setScreen("Library");
  };

  const openSmartAlbumMenu = (album: any, e: React.MouseEvent) => {
    openContextMenu(
      [
        {
          label: "Open Smart Album",
          onClick: () => void openSmartAlbum(album.id),
        },
        {
          label: "Rename Smart Album…",
          onClick: () => {
            const name = window.prompt("Smart Album name", album.name);
            if (name?.trim()) void library.renameSmartAlbum(album.id, name);
          },
        },
        { divider: true },
        {
          label: "Delete Smart Album…",
          danger: true,
          onClick: () => {
            if (
              window.confirm(
                `Delete the Smart Album "${album.name}"? The saved filter is removed; photos are not changed.`,
              )
            ) {
              void library.deleteSmartAlbum(album.id);
            }
          },
        },
      ],
      e,
    );
  };

  const openScreen = async (next: Screen) => {
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
    if (next === "Viewer") {
      setViewerOrigin("Library");
      library.setViewerScope("library");
      let inspected = library.items.find((i: MediaItem) => i.id === library.inspectedId);
      if (inspected?.hidden) {
        library.inspectItem(null);
        inspected = undefined;
      }
      let target =
        inspected ??
        library.viewerSelected ??
        library.viewerItems.find((item) => item.kind !== "video") ??
        null;
      // Navigation must never implicitly start playback. If the target is a
      // video, fall back to the nearest viewable photo (or the empty viewer
      // state); videos only start from explicit actions — the grid's play
      // button, double-click, or Now Playing.
      if (target?.kind === "video") {
        target = library.viewerItems.find((item) => item.kind !== "video") ?? null;
      }
      viewer.open(target?.id);
    }
    if (next === "Hidden") {
      // Hidden is its own collection; do not carry a Library selection or an
      // inspector for a visible item into it. Load hidden items separately
      // so the Hidden screen has its own collection without polluting the
      // main items array.
      library.setViewerScope("library");
      library.clearSelection();
      library.inspectItem(null);
      await library.loadHiddenItems();
    } else if (screen === "Hidden") {
      // Leaving Hidden drops the hidden selection and any hidden inspector
      // focus, so the next screen cannot show an item it cannot display.
      library.clearSelection();
      const inspected = library.items.find((i: MediaItem) => i.id === library.inspectedId);
      if (inspected?.hidden) library.inspectItem(null);
      // Reload without the hidden filter so the normal library shows
      // non-hidden items again.
      void library.loadLibrary();
    }
    if (next === "Edit") {
      // Show the draft picker / empty edit screen. Saving first preserves any
      // in-progress work; explicit edit actions (Library/Viewer "Edit") still
      // open a specific item by calling edit.open() and setScreen("Edit").
      await edit.saveDraft();
      await edit.close();
    }
    if (next !== screen) {
      setScreenHistory((prev) => [...prev, screen]);
    }
    setScreen(next);
  };

  const importFiles = async () => {
    let paths: string[];
    try {
      const selected = await openFileDialog({
        directory: false,
        multiple: true,
        filters: [{ name: "Media", extensions: supportedExtensionsRef.current ?? [] }],
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
            (parent) => parent !== path && path.startsWith(`${parent.replace(/\/$/, "")}/`),
          ),
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
        result?.cancelled ? `Rescan cancelled for ${folder.name}.` : `Rescanned ${folder.name}.`,
      );
    } catch (e) {
      showNotice(`Rescan failed: ${describeError(e)}`);
    } finally {
      library.setBusy(false);
      library.setProgress(null);
      rescanInProgress.current = false;
    }
  };

  const removeAllSources = async () => {
    const folders = library.folders;
    if (folders.length === 0) return;
    library.setBusy(true);
    try {
      for (const folder of folders) {
        await library.removeFolder(folder.path, false);
      }
      library.showNotice(`Removed ${folders.length} source(s).`);
    } catch (e) {
      library.showNotice(`Could not remove sources: ${String(e)}`);
    } finally {
      library.setBusy(false);
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

  handlersRef.current = {
    importFolder,
    importFiles,
    exportToBatch,
    showNotice,
    checkUpdates: checkForUpdates,
    navigateViewer,
    navigateVideo: navigateVideoQueue,
    openViewer: (id: string) => openViewer(id),
  };

  const activeAlbumName = library.activeAlbum
    ? (library.albums.find((a: any) => a.id === library.activeAlbum)?.name ?? "Album")
    : null;

  return (
    <AppShell
      dark={dark}
      animateTransitions={animateTransitions}
      sidebarWidth={sidebarWidth}
      sidebarOpen={library.sidebarOpen}
      sidebarCollapsed={library.sidebarCollapsed}
      topbar={
        <AppTopBar
          screen={screen}
          activeAlbumName={activeAlbumName}
          busy={library.busy}
          progressPhase={library.progress?.phase ?? null}
          sidebarOpen={library.sidebarOpen}
          showInspector={library.showInspector}
          dark={dark}
          accentColor={accentColor}
          nowPlaying={
            playbackItem && playbackItemId && screen !== "Video"
              ? {
                  name: playbackName || playbackItem.name,
                  playing: fhPlaying,
                  navigable: videoQueue.length > 1 || Boolean(videoQueuePagingRef.current?.hasMore),
                }
              : null
          }
          onNowPlayingExpand={() => {
            if (!playbackItem) return;
            setViewerOrigin(screen);
            setBackgroundVideo(playbackItem);
            setScreen("Video");
          }}
          onNowPlayingToggle={() => usePlaybackStore.getState().toggle()}
          onNowPlayingPrevious={() => {
            playPreviousVideo();
          }}
          onNowPlayingNext={() => {
            void playNextVideo();
          }}
          onNowPlayingStop={() => {
            usePlaybackStore.getState().stop();
            setBackgroundVideo(null);
            setVideoQueue([]);
            videoQueuePagingRef.current = null;
            setQueueAutoPlayId(null);
          }}
          onToggleSidebar={() => library.toggleSidebar()}
          onToggleInspector={() => library.toggleInspector()}
          onToggleAppearance={() => settings.update("appearance", dark ? "light" : "dark")}
          onCycleAccent={() => {
            const index = ACCENT_PALETTE.findIndex((c) => c.id === accentColor);
            const next = ACCENT_PALETTE[(index + 1) % ACCENT_PALETTE.length].id;
            settings.update("accentColor", next as any);
          }}
          onOpenSettings={() => openScreen("Settings")}
          onMouseDown={beginTopbarDrag}
          onDoubleClick={handleTopbarDoubleClick}
        />
      }
      sidebar={
        <AppSidebar
          screen={screen}
          folders={library.folders}
          sourcesSheetOpen={sourcesSheetOpen}
          stats={libraryStats}
          updateAvailable={Boolean(updateInfo?.available)}
          updateVersion={updateInfo?.latestVersion ?? null}
          appVersion={appVersion}
          onOpenScreen={openScreen}
          onOpenSources={() => setSourcesSheetOpen(true)}
          onOpenUpdate={() => setUpdateDialogOpen(true)}
          sidebarCollapsed={library.sidebarCollapsed}
          onToggleCollapse={library.toggleSidebarCollapsed}
          // Video player has its own back control; avoid redundant sidebar back.
          canGoBack={screenHistory.length > 0 && screen !== "Video"}
          onGoBack={goBack}
        />
      }
      overlays={
        <>
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
                    const filesTotal = library.progress.filesTotal ?? library.progress.total;
                    const percent =
                      bytesTotal > 0
                        ? Math.min(100, Math.round((bytesProcessed / bytesTotal) * 100))
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
                          {filesProcessed.toLocaleString()} of {filesTotal.toLocaleString()}{" "}
                          candidate files
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
                        total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
                      return (
                        <div className="busy-indicator-progress-copy">
                          <b>Moving to Trash · {percent}%</b>
                          <small>
                            {processed.toLocaleString()} of {total.toLocaleString()} files
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
                            total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

                          // Extract just the folder/file name from path
                          const getName = (path: string) => path.split("/").pop() || path;

                          if (isSourceLevel) {
                            return (
                              <div className="busy-indicator-progress-copy">
                                <b>
                                  Scanning source {processed + 1} of {total} · {percent}%
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
                                  Scanning {sourceFolder} · {processed.toLocaleString()} of{" "}
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
                onClick={() =>
                  void (library.progress?.phase === "trashing"
                    ? library.cancelDelete()
                    : library.cancelScan())
                }
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
              <span aria-hidden="true">{isWarningNotice(library.notice) ? "!" : "✓"}</span>
              {library.notice}
            </div>
          )}

          <AppDialogs
            albumDialogOpen={albumDialogOpen}
            albumDialogMode={albumDialogMode}
            albumName={albumName}
            albumSeedIds={albumSeedIds}
            creatingAlbum={creatingAlbum}
            setAlbumDialogOpen={setAlbumDialogOpen}
            setAlbumDialogMode={setAlbumDialogMode}
            setAlbumName={setAlbumName}
            setAlbumSeedIds={setAlbumSeedIds}
            setRenamingAlbumId={setRenamingAlbumId}
            setCreatingAlbum={setCreatingAlbum}
            albumPendingDelete={albumPendingDelete}
            deletingAlbum={deletingAlbum}
            setAlbumPendingDelete={setAlbumPendingDelete}
            setDeletingAlbum={setDeletingAlbum}
            itemPendingDeleteCount={itemPendingDeleteCount}
            setItemPendingDeleteCount={setItemPendingDeleteCount}
            albumRemovePending={albumRemovePending}
            setAlbumRemovePending={setAlbumRemovePending}
            albumPickerOpen={albumPickerOpen}
            albumPickerItemIds={albumPickerItemIds}
            albumPickerSearch={albumSearch}
            addingToAlbumId={addingToAlbumId}
            setAlbumPickerOpen={setAlbumPickerOpen}
            setAlbumPickerItemIds={setAlbumPickerItemIds}
            setAlbumPickerSearch={setAlbumSearch}
            setAddingToAlbumId={setAddingToAlbumId}
            sourcesSheetOpen={sourcesSheetOpen}
            setSourcesSheetOpen={setSourcesSheetOpen}
            removeAllSourcesDialogOpen={removeAllSourcesDialogOpen}
            setRemoveAllSourcesDialogOpen={setRemoveAllSourcesDialogOpen}
            folderPendingRemove={folderPendingRemove}
            removingFolder={removingFolder}
            setFolderPendingRemove={setFolderPendingRemove}
            setRemovingFolder={setRemovingFolder}
            aboutOpen={aboutOpen}
            setAboutOpen={setAboutOpen}
            appVersion={appVersion}
            updateDialogOpen={updateDialogOpen}
            setUpdateDialogOpen={setUpdateDialogOpen}
            updateInfo={updateInfo}
            updateChecking={updateChecking}
            library={library}
            setScreen={(screen: string) => setScreen(screen as Screen)}
            submitAlbum={submitAlbum}
            closeAlbumDialog={closeAlbumDialog}
            addPickedItemsToAlbum={addPickedItemsToAlbum}
            createAlbumFromPicker={createAlbumFromPicker}
            confirmDeleteAlbum={confirmDeleteAlbum}
            confirmDeleteItem={confirmDeleteItem}
            confirmRemoveFromAlbum={confirmRemoveFromAlbum}
            confirmRemoveFolder={confirmRemoveFolder}
            removeAllSources={removeAllSources}
            rescanSources={rescanSources}
            rescanSource={rescanSource}
            importFolder={importFolder}
            checkForUpdates={checkForUpdates}
            albumDialogRef={albumDialogRef}
            updateDialogRef={updateDialogRef}
            aboutDialogRef={aboutDialogRef}
            deleteAlbumDialogRef={deleteAlbumDialogRef}
            deleteItemDialogRef={deleteItemDialogRef}
            removeFolderDialogRef={removeFolderDialogRef}
            albumInputRef={albumInputRef}
            albumSearchRef={albumSearchRef}
            itemPendingDeleteRef={itemPendingDeleteRef}
          />

          <SlideshowOverlay assetUrl={assetUrl} />

          {contextMenu && (
            <ContextMenu
              items={contextMenu.items}
              x={contextMenu.x}
              y={contextMenu.y}
              onClose={() => setContextMenu(null)}
            />
          )}
          {shortcutsCheatSheetOpen && (
            <ShortcutsCheatSheet
              open={shortcutsCheatSheetOpen}
              onClose={() => setShortcutsCheatSheetOpen(false)}
            />
          )}
        </>
      }
    >
      <AppScreenRouter
        screen={screen}
        screenHistory={screenHistory}
        goBack={goBack}
        library={library}
        viewer={viewer}
        edit={edit}
        batch={batch}
        assetUrl={assetUrl}
        setScreen={setScreen}
        openViewer={openViewer}
        playVideoInBackground={playVideoInBackground}
        openScreen={openScreen}
        openAlbumDialog={openAlbumDialog}
        openAlbumPicker={openAlbumPicker}
        openContextMenu={openContextMenu}
        searchInputRef={searchInputRef}
        itemPendingDeleteRef={itemPendingDeleteRef}
        setItemPendingDeleteCount={setItemPendingDeleteCount}
        setFolderPendingRemove={setFolderPendingRemove}
        setRemoveAllSourcesDialogOpen={setRemoveAllSourcesDialogOpen}
        rescanSources={rescanSources}
        rescanSource={rescanSource}
        importFiles={importFiles}
        importFolder={importFolder}
        showNotice={showNotice}
        exportToBatch={exportToBatch}
        addItemsToAlbum={addItemsToAlbum}
        albumDragOver={albumDragOver}
        libraryStats={libraryStats}
        photoViewerItems={photoViewerItems}
        playbackItem={playbackItem}
        videoQueue={videoQueue}
        queueAutoPlayId={queueAutoPlayId}
        viewerOrigin={viewerOrigin}
        navigateViewer={navigateViewer}
        selectViewerItem={selectViewerItem}
        selectVideoItem={selectVideoItem}
        playPreviousVideo={playPreviousVideo}
        playNextVideo={playNextVideo}
        queueHasMore={Boolean(videoQueuePagingRef.current?.hasMore)}
        onLoadMoreQueue={loadNextVideoPage}
        playSlideshow={playSlideshow}
        openAlbumMenu={openAlbumMenu}
        openSmartAlbum={openSmartAlbum}
        openSmartAlbumMenu={openSmartAlbumMenu}
        setAlbumRemovePending={setAlbumRemovePending}
        copyTagsToFinderForIds={copyTagsToFinderForIds}
      />
    </AppShell>
  );
}

/**
 * Hidden is the same gallery as Library, but scoped to items with `hidden`.
 * It keeps its own filter/search state so browsing hidden items never changes
 * the Library's view, and it never pretends the files are protected — the
 * disclaimer in the header is the contract.
 */
export default App;
