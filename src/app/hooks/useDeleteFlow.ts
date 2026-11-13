import { useCallback, useRef, useState } from "react";
import { tauri } from "../../engine/commands/tauri";
import { useLibraryStore } from "../../engine/stores";
import type { DeleteRequest } from "../../engine/types/deleteRequest";
import { errorCode } from "../../engine/types/errors";
import type { MediaItem } from "../../engine/types/media";
import { formatBytesSimple } from "../../engine/utils/mediaTypes";
import type { ShowErrorNotice, ShowNotice } from "../types";

interface UseDeleteFlowOptions {
  showNotice: ShowNotice;
  showErrorNotice: ShowErrorNotice;
  refreshLibraryStats: () => void;
  /** Called with the trashed ids so the video session can drop them. */
  onItemsTrashed: (ids: string[]) => void;
}

/**
 * The move-to-Trash confirmation: the pending request, running the delete in
 * the background once confirmed, and the Undo that restores a duplicate
 * cleanup from the Trash.
 */
export function useDeleteFlow({
  showNotice,
  showErrorNotice,
  refreshLibraryStats,
  onItemsTrashed,
}: UseDeleteFlowOptions) {
  const [itemPendingDeleteCount, setItemPendingDeleteCount] = useState<number>(0);
  const [itemPendingDeleteSummary, setItemPendingDeleteSummary] = useState<string | null>(null);
  const itemPendingDeleteRef = useRef<DeleteRequest | null>(null);
  const deleteItemDialogRef = useRef<HTMLDivElement | null>(null);

  // Put trashed duplicates back where they were and re-import them so the
  // catalog matches disk. Best effort — entries that cannot be found in the
  // Trash are reported rather than silently skipped.
  const restoreTrashedItems = useCallback(
    async (items: MediaItem[]) => {
      try {
        const result = await tauri.items.restoreTrashedItems(
          items.map((item) => ({ path: item.path, name: item.name, size: item.size })),
        );
        const restored = result?.restored ?? [];
        if (restored.length === 0) {
          showNotice(
            "Could not find those items in the Trash (they may have been purged).",
            "internal",
          );
          return;
        }
        const importResult = await tauri.library.importFiles(restored);
        await useLibraryStore.getState().loadLibrary();
        refreshLibraryStats();
        const failures = result?.failed?.length ?? 0;
        showNotice(
          `Restored ${importResult.items.length.toLocaleString()} file(s) from the Trash${failures ? ` — ${failures} could not be found` : ""}.`,
        );
      } catch (error) {
        showErrorNotice(error, "Could not restore from the Trash");
      }
    },
    [refreshLibraryStats, showErrorNotice, showNotice],
  );

  const confirmDeleteItem = () => {
    if (itemPendingDeleteCount === 0 || !itemPendingDeleteRef.current) return;
    const request = itemPendingDeleteRef.current;
    const ids = request.ids;
    // Close dialog immediately
    setItemPendingDeleteCount(0);
    itemPendingDeleteRef.current = null;
    setItemPendingDeleteSummary(null);
    // Run delete in background
    void (async () => {
      try {
        const result = await useLibraryStore.getState().deleteItems(ids);
        const moved = result.status === "failed" ? 0 : result.trashed;
        if (moved > 0) onItemsTrashed(ids);
        // The duplicate manager can remove rows that are outside the loaded
        // page, so refresh canonical source/library totals after the native
        // transaction rather than estimating them from rendered tiles.
        if (moved > 0) refreshLibraryStats();
        if (result.status === "cancelled") {
          showNotice("Deletion cancelled.");
        } else if (result.status === "failed") {
          showNotice(
            `Could not move items to Trash: ${result.failures[0]?.error ?? "unknown error"}`,
            result.failures[0]?.code ?? "internal",
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
          const message = `Moved ${moved.toLocaleString()} item${
            moved === 1 ? "" : "s"
          } to Trash${reclaimed}.${suffix}${warning}`;
          // Duplicate cleanup passes the full items so the notice can offer an
          // undo; everything else keeps the plain confirmation.
          if (request.undoItems?.length) {
            const undoItems = request.undoItems;
            showNotice(message, undefined, {
              label: "Undo",
              run: () => void restoreTrashedItems(undoItems),
            });
          } else {
            showNotice(message);
          }
          if (result.failures.length > 0) console.warn("Trash refusals", result.failures);
        }
      } catch (error) {
        if (errorCode(error) !== "cancelled") {
          showErrorNotice(error, "Could not delete");
        }
      }
    })();
  };

  return {
    itemPendingDeleteCount,
    setItemPendingDeleteCount,
    itemPendingDeleteSummary,
    setItemPendingDeleteSummary,
    itemPendingDeleteRef,
    deleteItemDialogRef,
    confirmDeleteItem,
  };
}
