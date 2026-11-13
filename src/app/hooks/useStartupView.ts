import { useEffect, useRef, useState } from "react";
import { useLibraryStore, useSettingsStore } from "../../engine/stores";
import type { Screen } from "../screen";
import { setScreen } from "../useNavigationStore";

/**
 * Honor the startup_view setting once settings are hydrated (open to the
 * Library, or the last screen/folder), and track the last screen and folder
 * visited so "last" has something to restore.
 */
export function useStartupView(screen: Screen, settingsHydrated: boolean) {
  const [lastFolder, setLastFolder] = useState<string | null>(null);
  const [lastScreen, setLastScreen] = useState<Screen | null>(null);
  const activeAlbum = useLibraryStore((s) => s.activeAlbum);
  const startupView = useSettingsStore((s) => s.startupView);
  const openLastFolder = useSettingsStore((s) => s.openLastFolder);

  const didRunStartup = useRef(false);
  useEffect(() => {
    if (!settingsHydrated || didRunStartup.current) return;
    didRunStartup.current = true;
    if (startupView === "last" && openLastFolder && lastScreen === "Albums" && lastFolder) {
      const library = useLibraryStore.getState();
      library.setActiveAlbum(lastFolder);
      library.setFilter("All");
      library.setQuery("");
      library.loadAlbumItems(lastFolder).catch(() => {
        // The album grid itself still loads through the active-album filter.
      });
      setScreen("Library");
      return;
    }
    if (startupView === "last" && lastScreen) {
      setScreen(lastScreen);
      return;
    }
    // Default: Library.
    setScreen("Library");
  }, [settingsHydrated, startupView, openLastFolder, lastScreen, lastFolder]);

  useEffect(() => {
    if (screen !== "Library" && screen !== "Hidden") {
      setLastScreen(screen);
    }
    if (activeAlbum) {
      setLastFolder(activeAlbum);
      setLastScreen("Albums");
    }
  }, [screen, activeAlbum]);
}
