import { useEffect, useState, useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  FolderIcon,
  ShieldIcon,
} from "../icons";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { tauri } from "../../../engine/commands/tauri";
import type { RootPathMappingPreview } from "../../../engine/types/commands";

/**
 * Explicit recovery for a source folder that moved on disk.
 *
 * Nothing is rewritten until the user previews an exact source root and picks
 * the replacement folder. Only descendants of that root are remapped, and only
 * after conflicts with existing catalog paths are ruled out.
 */
export function RootPathMapping(props: {
  suggestedOldRoot?: string | null;
  onApplied: () => void | Promise<void>;
  showNotice: (text: string) => void;
}) {
  const [oldRoot, setOldRoot] = useState("");
  const [newRoot, setNewRoot] = useState("");
  const [preview, setPreview] = useState<RootPathMappingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const applyDialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(applyOpen, applyDialogRef);

  useEffect(() => {
    if (props.suggestedOldRoot && !oldRoot.trim()) {
      setOldRoot(props.suggestedOldRoot);
      setPreview(null);
    }
  }, [props.suggestedOldRoot, oldRoot]);

  const resetPreview = () => setPreview(null);

  const browse = async () => {
    try {
      const selected = await openDialog({
        title: "Choose the folder that now contains the moved library",
        directory: true,
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) return;
      setNewRoot(selected);
      resetPreview();
    } catch (error) {
      props.showNotice(
        `Could not open the folder picker: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const runPreview = async () => {
    setBusy(true);
    try {
      const result = await tauri.rootMap.preview(oldRoot, newRoot);
      setPreview(result);
      if (result.conflictingPaths.length > 0) {
        props.showNotice(
          `Mapping not applied: ${result.conflictingPaths.length} conflicting catalog path(s). No paths were changed.`,
        );
      } else if (result.itemCount === 0) {
        props.showNotice(
          "No catalog items live under that source root, so there is nothing to remap.",
        );
      }
    } catch (error) {
      setPreview(null);
      props.showNotice(
        `Could not preview the mapping: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await tauri.rootMap.apply(preview.oldRoot, preview.newRoot);
      setApplyOpen(false);
      setPreview(null);
      await props.onApplied();
      props.showNotice(
        `Remapped ${result.updatedItemCount.toLocaleString()} catalog item(s) from ${result.oldRoot} to ${result.newRoot}. Original media files were not modified.`,
      );
    } catch (error) {
      props.showNotice(
        `Could not apply the mapping: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section root-mapping-section">
      <h2 className="settings-section-title">
        <FolderIcon size={14} /> Moved source folder
      </h2>
      <p className="settings-section-desc">
        If a source moved after a backup or drive reconnect, map the registered
        root to its new location. This only rewrites paths under that exact
        root; it never touches media files or unrelated library paths.
      </p>
      <div className="settings-row">
        <div className="settings-row-label">
          <b>Missing source root</b>
          <span className="settings-row-desc">
            The registered path exactly as shown in Sources
          </span>
        </div>
        <div className="settings-row-control">
          <input
            type="text"
            className="settings-text-input"
            value={oldRoot}
            placeholder="/Volumes/Old/Photos"
            aria-label="Missing source root"
            onChange={(e) => {
              setOldRoot(e.target.value);
              resetPreview();
            }}
          />
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <b>New source root</b>
          <span className="settings-row-desc">
            The folder that now contains the same library
          </span>
        </div>
        <div className="settings-row-control root-mapping-new">
          <input
            type="text"
            className="settings-text-input"
            value={newRoot}
            placeholder="/Volumes/New/Photos"
            aria-label="New source root"
            onChange={(e) => {
              setNewRoot(e.target.value);
              resetPreview();
            }}
          />
          <button
            type="button"
            className="quiet-button"
            onClick={browse}
            disabled={busy}
          >
            Choose…
          </button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <b>Preview</b>
          <span className="settings-row-desc">
            Shows exactly how many items would be remapped before anything changes
          </span>
        </div>
        <div className="settings-row-control">
          <button
            type="button"
            className="quiet-button"
            onClick={runPreview}
            disabled={busy || !oldRoot.trim() || !newRoot.trim()}
          >
            {busy ? "Checking…" : "Preview mapping"}
          </button>
        </div>
      </div>
      {preview && (
        <div className="root-mapping-preview" role="status">
          <div>
            <b>{preview.itemCount.toLocaleString()} catalog item(s)</b> would move
            from <code>{preview.oldRoot}</code> to <code>{preview.newRoot}</code>.
          </div>
          <div>
            {preview.existingNewPathCount.toLocaleString()} of the mapped files
            currently exist at the new location.
          </div>
          {preview.samplePaths.length > 0 && (
            <details>
              <summary>Sample affected paths</summary>
              <pre>{preview.samplePaths.join("\n")}</pre>
            </details>
          )}
          {preview.conflictingPaths.length > 0 ? (
            <p className="root-mapping-conflict">
              <ShieldIcon size={13} /> Conflicts with existing catalog paths:{" "}
              {preview.conflictingPaths.join(", ")}. Apply is disabled.
            </p>
          ) : (
            <button
              type="button"
              className="danger-button"
              disabled={busy || preview.itemCount === 0}
              onClick={() => setApplyOpen(true)}
            >
              Apply mapping…
            </button>
          )}
        </div>
      )}

      {applyOpen && preview && (
        <div
          className="dialog-backdrop"
          onClick={() => {
            if (!busy) setApplyOpen(false);
          }}
        >
          <div
            ref={applyDialogRef}
            className="album-dialog delete-album-dialog confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">MAP SOURCE</p>
                <h2>Remap {preview.itemCount.toLocaleString()} catalog paths?</h2>
              </div>
            </div>
            <p className="dialog-body">
              Only paths under <code>{preview.oldRoot}</code> will be rewritten
              to <code>{preview.newRoot}</code>. A catalog snapshot should be
              taken before applying this if you have not already backed up.
              Original media files are not moved or modified.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setApplyOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={apply}
                disabled={busy}
              >
                {busy ? "Remapping…" : "Apply Mapping"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
