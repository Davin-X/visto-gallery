import { useEffect } from "react";
import { events } from "../../engine/commands/tauri";
import { useLibraryStore } from "../../engine/stores";
import { progressBelongsToOperation } from "../../engine/progressPhases";
import type { ImportProgressEvent } from "../../engine/types/commands";

/** Rapid progress events are applied at most this often. */
const MIN_PROGRESS_INTERVAL_MS = 200;

/**
 * Mirror native scan/import progress events into the library store's
 * progress overlay, throttled so a fast scan does not re-render per file.
 */
export function useImportProgress() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let lastProgressApplyAt = 0;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingProgress: ImportProgressEvent | null = null;

    const applyProgress = (p: ImportProgressEvent) => {
      const { phase, processed, total } = p;
      const library = useLibraryStore.getState();
      const currentPhase = library.progress?.phase ?? "";
      // The command that started an operation owns `busy` and `progress`.
      // Progress events are presentation-only: don't let a scan/import
      // event flip the overlay away from an active operation (e.g. trash).
      // Conversely, allow the active operation's own events to update it —
      // which needs the phase mapping, because an import reports `scanning`.
      if (!progressBelongsToOperation(currentPhase, phase)) return;
      library.setProgress({
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

    void events
      .onImportProgress((progress) => {
        const now = Date.now();
        // Always apply terminal/first updates promptly; throttle rapid progress.
        if (
          progress.processed === progress.total ||
          now - lastProgressApplyAt >= MIN_PROGRESS_INTERVAL_MS
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
          progressTimer = setTimeout(
            () => {
              progressTimer = null;
              if (pendingProgress) {
                lastProgressApplyAt = Date.now();
                applyProgress(pendingProgress);
                pendingProgress = null;
              }
            },
            MIN_PROGRESS_INTERVAL_MS - (now - lastProgressApplyAt),
          );
        }
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      });

    return () => {
      cancelled = true;
      if (progressTimer) clearTimeout(progressTimer);
      unlisten?.();
    };
  }, []);
}
