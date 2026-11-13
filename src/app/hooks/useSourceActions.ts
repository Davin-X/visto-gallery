import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tauri } from "../../engine/commands/tauri";
import { useLibraryStore } from "../../engine/stores";
import type { LibraryFolder } from "../../engine/types/commands";
import type { Screen } from "../screen";
import { setScreen } from "../useNavigationStore";
import type { ShowErrorNotice, ShowNotice } from "../types";

interface UseSourceActionsOptions {
  screen: Screen;
  showNotice: ShowNotice;
  showErrorNotice: ShowErrorNotice;
  refreshLibraryStats: () => void;
}

/**
 * Everything that adds to or rescans the library: importing files, adding
 * source folders, rescanning one or all sources, removing sources, and
 * importing straight into an album (picker or a Finder drop on an open album).
 */
// Rescans never call `cancelScan()` first. That once cleared a single global
// cancel flag; with per-job flags it would cancel every running scan,
// including auto-import and the once-per-launch cleanup scan.
export function useSourceActions({
  screen,
  showNotice,
  showErrorNotice,
  refreshLibraryStats,
}: UseSourceActionsOptions) {
  const rescanInProgress = useRef(false);

  // Removing a folder is confirmed through its own dialog so a stray click in
  // the sidebar can never drop a chunk of the library.
  const [folderPendingRemove, setFolderPendingRemove] = useState<LibraryFolder | null>(null);
  const [removingFolder, setRemovingFolder] = useState(false);
  const removeFolderDialogRef = useRef<HTMLDivElement | null>(null);
  const [removeAllSourcesDialogOpen, setRemoveAllSourcesDialogOpen] = useState(false);
  const [removingAllSources, setRemovingAllSources] = useState(false);
  const [albumDragOver, setAlbumDragOver] = useState(false);

  const importFiles = async () => {
    let paths: string[];
    try {
      // The backend opens the picker so it can trust the paths it imports.
      paths = await tauri.library.pickMediaFiles();
      if (!paths.length) return;
    } catch (e) {
      showErrorNotice(e, "Could not open the file picker");
      return;
    }

    const library = useLibraryStore.getState();
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
      refreshLibraryStats();
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
      showErrorNotice(e, "Import failed");
    }
  };

  const importFolder = async () => {
    let selectedPaths: string[];
    try {
      // The backend opens the picker so it can trust the roots it registers.
      selectedPaths = await tauri.library.pickSourceFolders();
    } catch (e) {
      showErrorNotice(e, "Could not open the folder picker");
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

    const library = useLibraryStore.getState();
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
      refreshLibraryStats();
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
      showErrorNotice(e, "Scan failed");
    }
  };

  const rescanSource = async (folder: LibraryFolder) => {
    if (rescanInProgress.current) return;
    rescanInProgress.current = true;
    const library = useLibraryStore.getState();
    try {
      library.setBusy(true);
      library.setProgress({
        phase: "scanning",
        processed: 0,
        total: 1,
        currentFile: folder.path,
      });
      const result = await tauri.library.scan(folder.path, true);
      await library.loadLibrary();
      await library.loadFolders();
      refreshLibraryStats();
      library.setProgress(null);
      library.setBusy(false);
      showNotice(
        result?.cancelled ? `Rescan cancelled for ${folder.name}.` : `Rescanned ${folder.name}.`,
      );
    } catch (e) {
      showErrorNotice(e, "Rescan failed");
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
    const library = useLibraryStore.getState();
    try {
      library.setBusy(true);
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
      showErrorNotice(e, "Rescan failed");
    } finally {
      library.setBusy(false);
      library.setProgress(null);
      rescanInProgress.current = false;
    }
  };

  const removeAllSources = async () => {
    if (removingAllSources) return;
    const library = useLibraryStore.getState();
    const folders = library.folders;
    if (folders.length === 0) return;
    setRemovingAllSources(true);
    library.setBusy(true);
    try {
      for (const folder of folders) {
        await library.removeFolder(folder.path, false);
      }
      library.showNotice(`Removed ${folders.length} source(s).`);
      setRemoveAllSourcesDialogOpen(false);
    } catch (e) {
      library.showErrorNotice(e, "Could not remove sources");
    } finally {
      library.setBusy(false);
      setRemovingAllSources(false);
    }
  };

  const confirmRemoveFolder = async () => {
    if (!folderPendingRemove || removingFolder) return;
    setRemovingFolder(true);
    try {
      const removed = await useLibraryStore.getState().removeFolder(folderPendingRemove.path);
      showNotice(
        removed > 0
          ? `Removed “${folderPendingRemove.name}” from VistoGallery. ${removed.toLocaleString()} item${removed === 1 ? "" : "s"} dropped from the library — your files are still on disk.`
          : `Removed empty folder “${folderPendingRemove.name}” from VistoGallery.`,
      );
      setFolderPendingRemove(null);
    } catch (error) {
      showErrorNotice(error, "Could not remove folder");
    } finally {
      setRemovingFolder(false);
    }
  };

  const importPathsIntoAlbum = async (paths: string[], albumId: string) => {
    const library = useLibraryStore.getState();
    const album = library.albums.find((a) => a.id === albumId);
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
            result.items.map((item) => item.id),
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
        result.items.map((item) => item.id),
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
      showErrorNotice(error, "Could not add items to the album");
    }
  };
  // The drop listener below lives across renders; it reaches the latest
  // import through this ref.
  const importPathsIntoAlbumRef = useRef(importPathsIntoAlbum);
  importPathsIntoAlbumRef.current = importPathsIntoAlbum;

  const addItemsToAlbum = async (albumId: string) => {
    let paths: string[];
    try {
      // The backend opens the picker so it can trust the paths it imports.
      paths = await tauri.library.pickMediaFiles();
      if (!paths.length) return;
    } catch (error) {
      showErrorNotice(error, "Could not open the file picker");
      return;
    }
    await importPathsIntoAlbum(paths, albumId);
  };

  // Native Finder drops are window-level events. While an album is open, a
  // drop adds the selected files to that album instead of doing nothing.
  const activeAlbum = useLibraryStore((s) => s.activeAlbum);
  useEffect(() => {
    if (screen !== "Library" || !activeAlbum) {
      setAlbumDragOver(false);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const stop = await getCurrentWindow().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "over") {
            setAlbumDragOver(true);
          } else if (payload.type === "leave") {
            setAlbumDragOver(false);
          } else if (payload.type === "drop") {
            setAlbumDragOver(false);
            const albumId = useLibraryStore.getState().activeAlbum;
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
  }, [screen, activeAlbum]);

  return {
    importFiles,
    importFolder,
    rescanSource,
    rescanSources,
    removeAllSources,
    removeAllSourcesDialogOpen,
    setRemoveAllSourcesDialogOpen,
    removingAllSources,
    folderPendingRemove,
    setFolderPendingRemove,
    removingFolder,
    setRemovingFolder,
    removeFolderDialogRef,
    confirmRemoveFolder,
    addItemsToAlbum,
    albumDragOver,
  };
}
