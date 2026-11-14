import { useEffect, useRef, useState } from "react";
import { useLibraryStore, useSettingsStore } from "../../engine/stores";
import type { Screen } from "../screen";
import { useNavigationStore } from "../useNavigationStore";

export const LAST_SCREEN_KEY = "visto:lastScreen";
export const LAST_ALBUM_KEY = "visto:lastAlbum";

/**
 * Screens that can be restored on their own. Viewer, Video and Edit need an
 * item in context, and Hidden must not open before its lock does.
 */
const RESTORABLE_SCREENS: readonly Screen[] = [
  "Library",
  "Albums",
  "Duplicates",
  "Batch",
  "Settings",
];

function readStoredValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Storage is best effort; a blocked write only loses the "Last view" hint.
  }
}

export function readStoredLastScreen(): Screen | null {
  const stored = readStoredValue(LAST_SCREEN_KEY);
  return RESTORABLE_SCREENS.find((screen) => screen === stored) ?? null;
}

/**
 * Honor the startup_view setting once settings are hydrated (open to the
 * Library, or the last screen/folder), and persist the last screen and album
 * so "Last view" survives a relaunch.
 */
export function useStartupView(screen: Screen, settingsHydrated: boolean) {
  const [lastFolder, setLastFolder] = useState<string | null>(() =>
    readStoredValue(LAST_ALBUM_KEY),
  );
  const [lastScreen, setLastScreen] = useState<Screen | null>(() => readStoredLastScreen());
  const activeAlbum = useLibraryStore((s) => s.activeAlbum);
  const startupView = useSettingsStore((s) => s.startupView);
  const openLastFolder = useSettingsStore((s) => s.openLastFolder);

  const didRunStartup = useRef(false);
  // The commit that restores the view still carries the pre-restore screen, so
  // its tracking pass must not overwrite the stored value.
  const skipFirstTracking = useRef(true);

  useEffect(() => {
    if (!settingsHydrated || didRunStartup.current) return;
    didRunStartup.current = true;
    // Launch is not a step Back should return to.
    const { replaceScreen } = useNavigationStore.getState();
    const restoreAlbum =
      startupView === "last" && openLastFolder && lastScreen === "Albums" && lastFolder;
    const target: Screen = restoreAlbum
      ? "Library"
      : startupView === "last" && lastScreen
        ? lastScreen
        : "Library";

    if (restoreAlbum) {
      const library = useLibraryStore.getState();
      library.setActiveAlbum(lastFolder);
      library.setFilter("All");
      library.setQuery("");
      library.loadAlbumItems(lastFolder).catch(() => {
        // The album grid itself still loads through the active-album filter.
      });
      // Keep "Albums" + the folder stored so the next launch can restore it.
    } else {
      // Keep "last view" fresh when the setting is Library or the stored
      // screen was one that cannot be restored on its own.
      setLastScreen(target);
      writeStoredValue(LAST_SCREEN_KEY, target);
    }

    // If restoring does not change the screen prop, the first tracking pass is
    // a real navigation and must be recorded rather than skipped. An album
    // restore still keeps the skip: the album store update that follows writes
    // both "Albums" and the folder.
    if (target === screen && !restoreAlbum) skipFirstTracking.current = false;
    replaceScreen(target);
  }, [settingsHydrated, startupView, openLastFolder, lastScreen, lastFolder, screen]);

  useEffect(() => {
    if (!didRunStartup.current) return;
    if (skipFirstTracking.current) {
      skipFirstTracking.current = false;
      return;
    }
    if (RESTORABLE_SCREENS.includes(screen)) {
      setLastScreen(screen);
      writeStoredValue(LAST_SCREEN_KEY, screen);
    }
    if (activeAlbum) {
      setLastFolder(activeAlbum);
      setLastScreen("Albums");
      writeStoredValue(LAST_ALBUM_KEY, activeAlbum);
      writeStoredValue(LAST_SCREEN_KEY, "Albums");
    }
  }, [screen, activeAlbum]);
}
