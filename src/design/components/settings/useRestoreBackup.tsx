import { useCallback, useRef, useState } from "react";
import { tauri } from "../../../engine/commands/tauri";
import { useKeyboard } from "../../../engine/hooks/useKeyboard";
import { useLibraryStore } from "../../../engine/stores";
import type { BackupInfo, RestoreResult } from "../../../engine/types/commands";
import { useFocusTrap } from "../../hooks/useFocusTrap";

/**
 * Shared backup-restore picker, validation, confirmation modal, and execution.
 * Used by both Settings -> Advanced and the empty-sources sheet.
 */
export function useRestoreBackup({
  onRestored,
  onBusyChange,
}: {
  onRestored?: (result: RestoreResult) => void;
  onBusyChange?: (busy: boolean) => void;
} = {}) {
  const loadLibrary = useLibraryStore((s) => s.loadLibrary);
  const showNotice = useLibraryStore((s) => s.showNotice);
  const showErrorNotice = useLibraryStore((s) => s.showErrorNotice);
  const [restoring, setRestoring] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{
    path: string;
    info: BackupInfo;
  } | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(!!pendingRestore, dialogRef);

  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (pendingRestore && !restoring) {
          e.preventDefault();
          setPendingRestore(null);
        }
      },
      [pendingRestore, restoring],
    ),
  ]);

  const chooseRestore = useCallback(async () => {
    try {
      const path = await tauri.backup.chooseFile();
      if (!path) return;
      onBusyChange?.(true);
      const info = await tauri.backup.validate(path);
      setPendingRestore({ path, info });
    } catch (error) {
      showNotice(
        `That file is not a restorable VistoGallery backup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      onBusyChange?.(false);
    }
  }, [onBusyChange, showNotice]);

  const confirmRestore = useCallback(async () => {
    if (!pendingRestore) return;
    setRestoring(true);
    try {
      const result = await tauri.backup.restore(pendingRestore.path);
      setPendingRestore(null);
      onRestored?.(result);
      await loadLibrary();
      const missing = result.missingRoots.length
        ? ` Missing source folder(s): ${result.missingRoots.slice(0, 3).join(", ")}${result.missingRoots.length > 3 ? ", …" : ""}.`
        : "";
      const ungranted = result.ungrantedRoots.length
        ? ` Not given file access because they are outside your home folder or a mounted volume: ${result.ungrantedRoots.slice(0, 3).join(", ")}${result.ungrantedRoots.length > 3 ? ", …" : ""}. Remove or re-locate them in Sources.`
        : "";
      showNotice(
        `Catalog restored (${result.backup.itemCount.toLocaleString()} items, ${result.backup.albumCount.toLocaleString()} albums). Pre-restore backup: ${result.preRestoreBackup}.${missing}${ungranted} Original media files were not modified.`,
      );
    } catch (error) {
      showErrorNotice(error, "Restore failed; the active catalog was left in place");
    } finally {
      setRestoring(false);
    }
  }, [loadLibrary, onRestored, pendingRestore, showErrorNotice, showNotice]);

  const modal = pendingRestore ? (
    <div
      className="dialog-backdrop"
      onClick={() => {
        if (!restoring) setPendingRestore(null);
      }}
    >
      <div
        ref={dialogRef}
        className="album-dialog delete-album-dialog confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-restore-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">RESTORE</p>
            <h2 id="settings-restore-title">Replace the Current Catalog?</h2>
          </div>
        </div>
        <p className="dialog-body">
          This backup contains <b>{pendingRestore.info.itemCount.toLocaleString()} items</b>,{" "}
          {pendingRestore.info.albumCount.toLocaleString()} albums, and{" "}
          {pendingRestore.info.tagCount.toLocaleString()} tags, created with app version{" "}
          {pendingRestore.info.appVersion}. Restoring replaces the current catalog organization. A
          pre-restore snapshot is written automatically, and{" "}
          <b>original media files are never modified</b>.
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={() => setPendingRestore(null)}
            disabled={restoring}
          >
            Cancel
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={confirmRestore}
            disabled={restoring}
          >
            {restoring ? "Restoring…" : "Restore catalog"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return {
    open: !!pendingRestore,
    restoring,
    chooseRestore,
    modal,
  };
}
