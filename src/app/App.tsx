import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { tauri } from "../engine/commands/tauri";
import {
  useLibraryStore,
  useViewerStore,
  useEditStore,
  useSlideshowStore,
  useBatchStore,
  useSettingsStore,
  useSystemDark,
  ACCENT_PALETTE,
  applyTheme,
  usePlaybackStore,
} from "../engine/stores";
import { navigateToBatchExport } from "./exportFlow";
import { copyTagsToFinder } from "../engine/utils/finderTags";
import { startConfiguredSlideshow } from "./utils/startConfiguredSlideshow";
import { AppDialogs, DeleteAlbumDialog } from "./AppDialogs";
import { AppSidebar, AppTopBar, cycleAppearance } from "./AppNavigation";
import { AppShell } from "./AppShell";
import { AppScreenRouter } from "./AppScreenRouter";
import { BusyIndicator } from "./components/BusyIndicator";
import { NoticeToast } from "./components/NoticeToast";
import { useAlbumDialogs } from "./hooks/useAlbumDialogs";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { useAutoImport } from "./hooks/useAutoImport";
import { useContextMenu } from "./hooks/useContextMenu";
import { useDeleteFlow } from "./hooks/useDeleteFlow";
import { useImportProgress } from "./hooks/useImportProgress";
import { useLibraryStats } from "./hooks/useLibraryStats";
import { useNativeMenu } from "./hooks/useNativeMenu";
import { useSourceActions } from "./hooks/useSourceActions";
import { useStartupView } from "./hooks/useStartupView";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { useVideoQueue, type ViewerScope } from "./hooks/useVideoQueue";
import { useWindowState } from "./hooks/useWindowState";
import { setScreen, useNavigationStore } from "./useNavigationStore";
import type { Screen } from "./screen";
import type { NoticeAction } from "./types";

import type { LayoutMode, MediaItem } from "../engine/types/media";
import type { ErrorCode } from "../engine/types/commands";
import { SlideshowOverlay } from "../design/components/SlideshowOverlay";
import { SmartAlbumDialog } from "../design/components/SmartAlbumDialog";
import { ContextMenu } from "../design/components/ContextMenu";
import { ShortcutsCheatSheet } from "../design/components/ShortcutsCheatSheet";

/** Pause every <video> on the page, so two players never sound at once. */
function pauseAllVideos() {
  document.querySelectorAll("video").forEach((v) => {
    try {
      v.pause();
    } catch {}
  });
}

// Convert local file path to Tauri asset URL
function assetUrl(path: string) {
  if (!path) return "";
  if (path.startsWith("blob:") || path.startsWith("data:") || path.startsWith("http")) return path;
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

function App() {
  const screen = useNavigationStore((s) => s.screen);
  const canGoBack = useNavigationStore((s) => s.history.length > 0);
  const goBack = useNavigationStore((s) => s.goBack);

  // A mouse's back and forward buttons (3 and 4) walk the same history.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      const navigation = useNavigationStore.getState();
      if (e.button === 3) navigation.goBack();
      else navigation.goForward();
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  const library = useLibraryStore();
  const viewer = useViewerStore();
  const edit = useEditStore();
  const batch = useBatchStore();
  const settings = useSettingsStore();
  // The slideshow is a full-window mode: while it is open the app chrome steps
  // aside so the photo, not the top bar, owns the screen.
  const slideshowOpen = useSlideshowStore((s) => s.isOpen);

  // ── Appearance ────────────────────────────────────────────────────────────
  const systemDark = useSystemDark();
  const appearance = useSettingsStore((s) => s.appearance);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);
  const animateTransitions = useSettingsStore((s) => s.animateTransitions);
  // Resolved appearance: the user's choice, or the OS setting when "system".
  const dark = appearance === "dark" || (appearance === "system" && systemDark);

  // Keep the in-app theme and the native window chrome (traffic lights /
  // window background) in sync with the resolved appearance. This lives here
  // (always mounted) rather than in Settings so closing Settings never leaves
  // the app frame on a stale theme.
  useEffect(() => {
    try {
      applyTheme({ appearance, accentColor });
    } catch {
      /* browser preview - no native window */
    }
  }, [dark, appearance, accentColor]);

  // ── Notices ───────────────────────────────────────────────────────────────
  const showNotice = useCallback((text: string, code?: ErrorCode, action?: NoticeAction) => {
    useLibraryStore.getState().showNotice(text, code, action);
  }, []);
  const showErrorNotice = useCallback((error: unknown, prefix?: string) => {
    useLibraryStore.getState().showErrorNotice(error, prefix);
  }, []);

  // ── Startup ───────────────────────────────────────────────────────────────
  const settingsHydrated = useSettingsStore((s) => s._hydrated);
  const restoreWindowState = useSettingsStore((s) => s.restoreWindowState);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    // Opening the saved catalog is cheap; source scans are always user-started.
    const state = useLibraryStore.getState();
    void state.loadLibrary();
    // Hidden items are filtered out of the main query, so load them
    // separately to power the Hidden screen's counts and grid.
    void state.loadHiddenItems();
    void useSettingsStore.getState().hydrate();
  }, []);
  // Pull the authoritative settings from SQLite once at startup so the app
  // chrome (appearance, accent, sidebar width) is correct even if the user
  // never opens Settings.
  useEffect(() => {
    void hydrateSettings();
  }, [hydrateSettings]);
  useStartupView(screen, settingsHydrated);

  // ── Library layout ────────────────────────────────────────────────────────
  const defaultLayout = useSettingsStore((s) => s.defaultLayout);
  // Persist the toolbar's layout choice to the same defaultLayout setting the
  // Settings screen edits, so switching away and back never resets the view.
  // Only the persisted set is saved; the screen keeps showing other layouts
  // in-session without rewriting the saved default.
  const changeLibraryLayout = (layout: LayoutMode) => {
    library.setLayout(layout);
    if (layout === "grid" || layout === "details" || layout === "timeline") {
      void settings.update("defaultLayout", layout);
    }
  };
  // Apply the saved library layout once settings are ready, and whenever the
  // user returns to the whole library. Avoid changing the current view while
  // they are actively browsing it.
  // The store object is a fresh value on every render, so the effect depends on
  // the two members it actually uses rather than on the object itself.
  const { activeAlbum: libraryActiveAlbum, setLayout: setLibraryLayout } = library;
  useEffect(() => {
    if (settingsHydrated && screen === "Library" && !libraryActiveAlbum) {
      setLibraryLayout(defaultLayout);
    }
  }, [settingsHydrated, screen, defaultLayout, libraryActiveAlbum, setLibraryLayout]);

  // ── Background services ──────────────────────────────────────────────────
  const { libraryStats, refreshLibraryStats } = useLibraryStats(showNotice);
  useImportProgress();
  useAutoImport({ settingsHydrated, showNotice, showErrorNotice });
  const { beginTopbarDrag, handleTopbarDoubleClick } = useWindowState({
    restoreFrame: restoreWindowState,
    settingsHydrated,
  });
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();

  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsCheatSheetOpen, setShortcutsCheatSheetOpen] = useState(false);
  const [sourcesSheetOpen, setSourcesSheetOpen] = useState(false);
  const updates = useUpdateCheck({ settingsHydrated, showNotice, showErrorNotice, setAboutOpen });
  const updateDialogRef = useRef<HTMLDivElement | null>(null);
  const aboutDialogRef = useRef<HTMLDivElement | null>(null);

  // ── Viewer and video playback ────────────────────────────────────────────
  // Where the viewer returns when it closes. Opening the viewer from Hidden
  // keeps the user in Hidden; the Library viewer returns to Library.
  const [viewerOrigin, setViewerOrigin] = useState<Screen>("Library");
  const video = useVideoQueue();

  const photoViewerItems = useMemo(() => {
    const items = library.viewerItems.filter((item) => item.kind !== "video");
    const selected = library.viewerSelected;
    if (selected && selected.kind !== "video" && !items.some((item) => item.id === selected.id)) {
      return [selected, ...items];
    }
    return items;
  }, [library.viewerItems, library.viewerSelected]);
  // The viewer walks the loaded pages, so it has to be able to pull the next
  // one in; without this it stopped at the library's page size.
  const photoViewerHasMore = library.hasMore && library.viewerScope === "library";
  const loadMorePhotos = useCallback(() => useLibraryStore.getState().loadNextPage(), []);

  // Same reason as the layout effect: depend on the members, not the object.
  const {
    isOpen: viewerIsOpen,
    open: openViewerStore,
    resetTransform: resetViewerTransform,
  } = viewer;

  // Ensure screen state matches viewer state on mount/hydration.
  useEffect(() => {
    if (screen === "Viewer" && !viewerIsOpen) openViewerStore();
  }, [screen, viewerIsOpen, openViewerStore]);

  const navigateViewer = useCallback(
    async (delta: number) => {
      const navigated = await useLibraryStore.getState().navigateViewerPhoto(delta);
      if (navigated) resetViewerTransform();
    },
    [resetViewerTransform],
  );

  const selectViewerItem = useCallback((id: string) => {
    const libraryState = useLibraryStore.getState();
    const item = libraryState.viewerItems.find((candidate) => candidate.id === id);
    if (!item || item.kind === "video") return;
    libraryState.inspectItem(id);
  }, []);

  // Route photos to the photo viewer and videos to the independent player.
  const { beginVideoSession } = video;
  const openViewer = useCallback(
    (id?: string, origin: Screen = "Library", scope: ViewerScope = "library") => {
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
    (id?: string, scope: ViewerScope = "library") => {
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

  // ── Slideshows ────────────────────────────────────────────────────────────
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
      pauseAllVideos();
      // Read the action off the store instead of subscribing to it: advancing
      // slides should only re-render the overlay, never the whole app.
      // An explicit selection starts at its first item; only the no-selection
      // case resumes from whatever was last inspected, so a video that was
      // playing in the background cannot hijack the start of a new selection.
      if (selection) useSlideshowStore.getState().setShuffle(false);
      startConfiguredSlideshow(scope, selection ? null : library.inspectedId);
    },
    [library.items, library.visibleItems, library.inspectedId, showNotice, viewer, viewerOrigin],
  );

  // Opening an album card's slideshow must not require navigating into the
  // album first, so the membership is fetched here and handed straight to the
  // overlay. Same ordering as the Library slideshow: grid order.
  const playAlbumSlideshow = useCallback(
    async (albumId: string) => {
      try {
        const items = await tauri.albums.getItems(albumId);
        if (!items.length) {
          showNotice("This album has no photos or videos yet.");
          return;
        }
        if (viewer.isOpen) {
          viewer.close();
          setScreen(viewerOrigin || "Albums");
        }
        pauseAllVideos();
        startConfiguredSlideshow(items, null);
      } catch (error) {
        showErrorNotice(error, "Could not start the slideshow");
      }
    },
    [showNotice, showErrorNotice, viewer, viewerOrigin],
  );

  // ── Library actions and dialogs ──────────────────────────────────────────
  const sources = useSourceActions({ screen, showNotice, showErrorNotice, refreshLibraryStats });
  const albums = useAlbumDialogs({
    showNotice,
    showErrorNotice,
    openContextMenu,
    addItemsToAlbum: sources.addItemsToAlbum,
  });
  const deletion = useDeleteFlow({
    showNotice,
    showErrorNotice,
    refreshLibraryStats,
    onItemsTrashed: (ids) => {
      const ended = video.reconcilePlaybackAfterDelete(ids);
      // Nothing left to play: leave the player screen.
      if (ended && screen === "Video") setScreen(viewerOrigin || "Library");
    },
  });

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
          "io",
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

  // ── Navigation ────────────────────────────────────────────────────────────
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
    setScreen(next);
  };

  const openSettings = () => setScreen("Settings");

  // ── Keyboard and native menu ─────────────────────────────────────────────
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useAppShortcuts({
    screen,
    viewerOrigin,
    modalOpen: Boolean(
      albums.albumDialogOpen ||
      albums.albumPickerOpen ||
      albums.albumPendingDelete ||
      albums.smartAlbumPendingDelete ||
      deletion.itemPendingDeleteCount > 0 ||
      sources.folderPendingRemove ||
      sourcesSheetOpen ||
      updates.updateDialogOpen ||
      shortcutsCheatSheetOpen,
    ),
    searchInputRef,
    toggleShortcutsCheatSheet: () => setShortcutsCheatSheetOpen((open) => !open),
    importFolder: sources.importFolder,
    importFiles: sources.importFiles,
    exportToBatch,
    navigateViewer,
    openViewer: (id) => openViewer(id),
  });
  useNativeMenu({
    importFolder: sources.importFolder,
    importFiles: sources.importFiles,
    exportToBatch,
    toggleSidebar: () => useLibraryStore.getState().toggleSidebar(),
    toggleInspector: () => useLibraryStore.getState().toggleInspector(),
    zoomIn: () => useViewerStore.getState().zoomIn(),
    zoomOut: () => useViewerStore.getState().zoomOut(),
    showAbout: () => setAboutOpen(true),
    checkUpdates: () => void updates.checkForUpdates(true),
    showSettings: () => openSettings(),
    showShortcuts: () => setShortcutsCheatSheetOpen(true),
  });

  const activeAlbumName = library.activeAlbum
    ? (library.albums.find((a) => a.id === library.activeAlbum)?.name ?? "Album")
    : null;

  return (
    <AppShell
      dark={dark}
      animateTransitions={animateTransitions}
      sidebarWidth={sidebarWidth}
      sidebarOpen={library.sidebarOpen}
      sidebarCollapsed={library.sidebarCollapsed}
      slideshowOpen={slideshowOpen}
      topbar={
        <AppTopBar
          screen={screen}
          activeAlbumName={activeAlbumName}
          busy={library.busy}
          progressPhase={library.progress?.phase ?? null}
          sidebarOpen={library.sidebarOpen}
          showInspector={library.showInspector}
          dark={dark}
          appearance={appearance}
          accentColor={accentColor}
          nowPlaying={
            video.playbackItem && video.playbackItemId && screen !== "Video"
              ? {
                  name: video.playbackName || video.playbackItem.name,
                  playing: video.playing,
                  navigable: video.videoQueue.length > 1 || video.queueHasMore,
                }
              : null
          }
          onNowPlayingExpand={() => {
            if (!video.playbackItem) return;
            setViewerOrigin(screen);
            video.setBackgroundVideo(video.playbackItem);
            setScreen("Video");
          }}
          onNowPlayingToggle={() => usePlaybackStore.getState().toggle()}
          onNowPlayingPrevious={() => {
            video.playPreviousVideo();
          }}
          onNowPlayingNext={() => {
            void video.playNextVideo();
          }}
          onNowPlayingStop={video.stopVideoSession}
          onToggleSidebar={() => library.toggleSidebar()}
          onToggleInspector={() => library.toggleInspector()}
          onToggleAppearance={() => settings.update("appearance", cycleAppearance(appearance))}
          onCycleAccent={() => {
            const index = ACCENT_PALETTE.findIndex((c) => c.id === accentColor);
            const next = ACCENT_PALETTE[(index + 1) % ACCENT_PALETTE.length].id;
            settings.update("accentColor", next);
          }}
          onOpenSettings={() => openSettings()}
          onMouseDown={beginTopbarDrag}
          onDoubleClick={handleTopbarDoubleClick}
        />
      }
      sidebar={
        <AppSidebar
          // An open album belongs to Albums, even though its grid is drawn by
          // the Library screen.
          screen={screen === "Library" && library.activeAlbum ? "Albums" : screen}
          folders={library.folders}
          sourcesSheetOpen={sourcesSheetOpen}
          stats={libraryStats}
          updateAvailable={Boolean(updates.updateInfo?.available)}
          updateVersion={updates.updateInfo?.latestVersion ?? null}
          appVersion={updates.appVersion}
          onOpenScreen={openScreen}
          onOpenSources={() => setSourcesSheetOpen(true)}
          onOpenUpdate={() => updates.setUpdateDialogOpen(true)}
          sidebarCollapsed={library.sidebarCollapsed}
          onToggleCollapse={library.toggleSidebarCollapsed}
          // Video player has its own back control; avoid redundant sidebar back.
          canGoBack={canGoBack && screen !== "Video"}
          onGoBack={goBack}
        />
      }
      overlays={
        <>
          <BusyIndicator />
          <NoticeToast />

          <AppDialogs
            albumDialogOpen={albums.albumDialogOpen}
            albumDialogMode={albums.albumDialogMode}
            albumName={albums.albumName}
            albumSeedIds={albums.albumSeedIds}
            creatingAlbum={albums.creatingAlbum}
            setAlbumDialogOpen={albums.setAlbumDialogOpen}
            setAlbumDialogMode={albums.setAlbumDialogMode}
            setAlbumName={albums.setAlbumName}
            setAlbumSeedIds={albums.setAlbumSeedIds}
            setRenamingAlbumId={albums.setRenamingAlbumId}
            setCreatingAlbum={albums.setCreatingAlbum}
            albumPendingDelete={albums.albumPendingDelete}
            deletingAlbum={albums.deletingAlbum}
            setAlbumPendingDelete={albums.setAlbumPendingDelete}
            setDeletingAlbum={albums.setDeletingAlbum}
            itemPendingDeleteCount={deletion.itemPendingDeleteCount}
            itemPendingDeleteSummary={deletion.itemPendingDeleteSummary}
            setItemPendingDeleteCount={deletion.setItemPendingDeleteCount}
            albumRemovePending={albums.albumRemovePending}
            setAlbumRemovePending={albums.setAlbumRemovePending}
            albumPickerOpen={albums.albumPickerOpen}
            albumPickerItemIds={albums.albumPickerItemIds}
            albumPickerSearch={albums.albumSearch}
            addingToAlbumId={albums.addingToAlbumId}
            setAlbumPickerOpen={albums.setAlbumPickerOpen}
            setAlbumPickerItemIds={albums.setAlbumPickerItemIds}
            setAlbumPickerSearch={albums.setAlbumSearch}
            setAddingToAlbumId={albums.setAddingToAlbumId}
            sourcesSheetOpen={sourcesSheetOpen}
            setSourcesSheetOpen={setSourcesSheetOpen}
            removeAllSourcesDialogOpen={sources.removeAllSourcesDialogOpen}
            setRemoveAllSourcesDialogOpen={sources.setRemoveAllSourcesDialogOpen}
            removingAllSources={sources.removingAllSources}
            folderPendingRemove={sources.folderPendingRemove}
            removingFolder={sources.removingFolder}
            setFolderPendingRemove={sources.setFolderPendingRemove}
            setRemovingFolder={sources.setRemovingFolder}
            aboutOpen={aboutOpen}
            setAboutOpen={setAboutOpen}
            appVersion={updates.appVersion}
            updateDialogOpen={updates.updateDialogOpen}
            setUpdateDialogOpen={updates.setUpdateDialogOpen}
            updateInfo={updates.updateInfo}
            updateChecking={updates.updateChecking}
            library={library}
            setScreen={setScreen}
            submitAlbum={albums.submitAlbum}
            closeAlbumDialog={albums.closeAlbumDialog}
            addPickedItemsToAlbum={albums.addPickedItemsToAlbum}
            createAlbumFromPicker={albums.createAlbumFromPicker}
            confirmDeleteAlbum={albums.confirmDeleteAlbum}
            confirmDeleteItem={deletion.confirmDeleteItem}
            confirmRemoveFromAlbum={albums.confirmRemoveFromAlbum}
            confirmRemoveFolder={sources.confirmRemoveFolder}
            removeAllSources={sources.removeAllSources}
            rescanSources={sources.rescanSources}
            rescanSource={sources.rescanSource}
            importFolder={sources.importFolder}
            checkForUpdates={updates.checkForUpdates}
            albumDialogRef={albums.albumDialogRef}
            updateDialogRef={updateDialogRef}
            aboutDialogRef={aboutDialogRef}
            deleteAlbumDialogRef={albums.deleteAlbumDialogRef}
            deleteItemDialogRef={deletion.deleteItemDialogRef}
            removeFolderDialogRef={sources.removeFolderDialogRef}
            albumInputRef={albums.albumInputRef}
            albumSearchRef={albums.albumSearchRef}
            itemPendingDeleteRef={deletion.itemPendingDeleteRef}
          />

          <SlideshowOverlay assetUrl={assetUrl} />

          {albums.smartAlbumDialog && (
            <SmartAlbumDialog
              mode={albums.smartAlbumDialog.mode}
              initialName={albums.smartAlbumDialog.name}
              initialFilter={albums.smartAlbumDialog.filter}
              onSubmit={albums.submitSmartAlbum}
              onClose={albums.closeSmartAlbumDialog}
            />
          )}

          <DeleteAlbumDialog
            smart
            open={Boolean(albums.smartAlbumPendingDelete)}
            album={albums.smartAlbumPendingDelete}
            deleting={albums.deletingSmartAlbum}
            onClose={albums.closeDeleteSmartAlbum}
            onConfirm={albums.deletePendingSmartAlbum}
            dialogRef={albums.deleteSmartAlbumDialogRef}
          />

          {contextMenu && (
            <ContextMenu
              items={contextMenu.items}
              x={contextMenu.x}
              y={contextMenu.y}
              onClose={closeContextMenu}
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
        changeLibraryLayout={changeLibraryLayout}
        library={library}
        viewer={viewer}
        edit={edit}
        batch={batch}
        assetUrl={assetUrl}
        setScreen={setScreen}
        openViewer={openViewer}
        playVideoInBackground={playVideoInBackground}
        openScreen={openScreen}
        openAlbumDialog={albums.openAlbumDialog}
        openAlbumPicker={albums.openAlbumPicker}
        openContextMenu={openContextMenu}
        searchInputRef={searchInputRef}
        itemPendingDeleteRef={deletion.itemPendingDeleteRef}
        setItemPendingDeleteCount={deletion.setItemPendingDeleteCount}
        setItemPendingDeleteSummary={deletion.setItemPendingDeleteSummary}
        setFolderPendingRemove={sources.setFolderPendingRemove}
        setRemoveAllSourcesDialogOpen={sources.setRemoveAllSourcesDialogOpen}
        rescanSources={sources.rescanSources}
        rescanSource={sources.rescanSource}
        importFiles={sources.importFiles}
        importFolder={sources.importFolder}
        showNotice={showNotice}
        showErrorNotice={showErrorNotice}
        exportToBatch={exportToBatch}
        addItemsToAlbum={sources.addItemsToAlbum}
        albumDragOver={sources.albumDragOver}
        libraryStats={libraryStats}
        photoViewerItems={photoViewerItems}
        photoViewerHasMore={photoViewerHasMore}
        photoViewerLoadingMore={library.loadingNextPage}
        onLoadMorePhotos={loadMorePhotos}
        playbackItem={video.playbackItem}
        videoQueue={video.videoQueue}
        queueAutoPlayId={video.queueAutoPlayId}
        viewerOrigin={viewerOrigin}
        navigateViewer={navigateViewer}
        selectViewerItem={selectViewerItem}
        selectVideoItem={video.selectVideoItem}
        playPreviousVideo={video.playPreviousVideo}
        playNextVideo={video.playNextVideo}
        queueHasMore={video.queueHasMore}
        onLoadMoreQueue={video.loadNextVideoPage}
        playSlideshow={playSlideshow}
        playAlbumSlideshow={playAlbumSlideshow}
        openAlbumMenu={albums.openAlbumMenu}
        openRenameAlbumDialog={albums.openRenameAlbumDialog}
        setAlbumPendingDelete={albums.setAlbumPendingDelete}
        openSmartAlbum={albums.openSmartAlbum}
        openSmartAlbumMenu={albums.openSmartAlbumMenu}
        openSmartAlbumCreate={albums.openSmartAlbumCreate}
        openSmartAlbumEdit={albums.openSmartAlbumEdit}
        deleteSmartAlbum={albums.confirmDeleteSmartAlbum}
        setAlbumRemovePending={albums.setAlbumRemovePending}
        copyTagsToFinderForIds={copyTagsToFinderForIds}
      />
    </AppShell>
  );
}

export default App;
