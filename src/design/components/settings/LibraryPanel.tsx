import { FolderIcon, ShieldIcon } from "../icons";
import type { LibraryFolder } from "../../../engine/types/commands";
import { SourcesManager } from "../SourcesManager";
import type { SettingsChange } from "./types";

export function LibraryPanel(props: {
  autoImport: boolean;
  onAddFolder?: () => void;
  onRemoveFolder?: (folder: LibraryFolder) => void;
  onRescan?: () => void;
  onRescanFolder?: (folder: LibraryFolder) => void;
  onRemoveAllSources?: () => void;
  onChange: SettingsChange;
}) {
  return (
    <>
      <section className="settings-section">
        <h2 className="settings-section-title">
          <FolderIcon size={14} /> Import & Organization
        </h2>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Auto-import New Files</b>
            <span className="settings-row-desc">
              Automatically add files when dropped or saved to watched folders
            </span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label="Auto-import new files"
                checked={props.autoImport}
                onChange={(e) => props.onChange("autoImport", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
      </section>

      <SourcesManager
        variant="inline"
        onAddFolder={props.onAddFolder}
        onRemoveFolder={props.onRemoveFolder}
        onRescan={props.onRescan}
        onRescanFolder={props.onRescanFolder}
        onRemoveAllSources={props.onRemoveAllSources}
      />

      <div className="settings-warning">
        <span className="settings-warning-icon">
          <ShieldIcon size={15} />
        </span>
        <span>
          Folder watching requires granting Full Disk Access in System Settings → Privacy &
          Security. Without it, VistoGallery can only import files you explicitly select.
        </span>
      </div>
    </>
  );
}
