import { useCallback, useEffect, useRef, useState } from "react";
import { tauri, events } from "../../engine/commands/tauri";
import { debugLog, refreshDraftMeta, useSettingsStore } from "../../engine/stores";
import type { LibraryStats } from "../../engine/types/commands";

const EMPTY_STATS: LibraryStats = {
  photos: 0,
  videos: 0,
  raws: 0,
  animations: 0,
  animationsSize: 0,
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
};

/** Above this many items, warn (when enabled) that the library may be slower. */
const LARGE_LIBRARY_ITEMS = 10000;

/**
 * Exact catalog counts for the sidebar summary (not loaded-page counts),
 * refreshed on library change events and on demand after imports.
 */
export function useLibraryStats(showNotice: (text: string) => void) {
  const [libraryStats, setLibraryStats] = useState<LibraryStats>(EMPTY_STATS);
  const statsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `library-changed` is only emitted for removals, so imports and rescans have
  // to refresh the exact counts themselves. Without this the sidebar and the
  // type-chip counts keep describing the catalog from before the import (a
  // freshly imported set of GIFs would show in the grid but count as 0).
  const refreshLibraryStats = useCallback(() => {
    void tauri.library
      .getStats()
      .then(setLibraryStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void refreshDraftMeta();
    let cancelled = false;
    tauri.library
      .getStats()
      .then((stats) => {
        if (!cancelled) setLibraryStats(stats);
      })
      .catch((e) => {
        debugLog("get_library_stats failed:", e);
      });

    // Removals arrive as `library-changed`; scans and imports as
    // `library-counts-changed`. Both debounce through one timer so a bulk scan
    // does not fire a stats query per batch.
    const scheduleStatsRefresh = () => {
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
    };

    const unlisteners: Array<() => void> = [];
    events.onLibraryChanged(scheduleStatsRefresh).then((u) => {
      if (cancelled) u();
      else unlisteners.push(u);
    });
    events.onLibraryCountsChanged(scheduleStatsRefresh).then((u) => {
      if (cancelled) u();
      else unlisteners.push(u);
    });
    return () => {
      cancelled = true;
      if (statsDebounceRef.current) {
        clearTimeout(statsDebounceRef.current);
        statsDebounceRef.current = null;
      }
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  // Warn when the library is very large and show_native_limit_warnings is on.
  // Once per launch: the counts change after every import, rescan or delete,
  // and repeating the warning each time is noise.
  const showNativeWarnings = useSettingsStore((s) => s.showNativeLimitWarnings);
  const warnedLargeLibrary = useRef(false);
  useEffect(() => {
    if (!showNativeWarnings || warnedLargeLibrary.current) return;
    const total =
      libraryStats.photos +
      libraryStats.videos +
      libraryStats.raws +
      libraryStats.animations +
      libraryStats.uncategorized;
    if (total > LARGE_LIBRARY_ITEMS) {
      warnedLargeLibrary.current = true;
      showNotice(
        `Large library (${total.toLocaleString()} items) — thumbnail generation and scrolling may be slower on this system.`,
      );
    }
  }, [
    showNativeWarnings,
    libraryStats.photos,
    libraryStats.videos,
    libraryStats.raws,
    libraryStats.animations,
    libraryStats.uncategorized,
    showNotice,
  ]);

  return { libraryStats, refreshLibraryStats };
}
