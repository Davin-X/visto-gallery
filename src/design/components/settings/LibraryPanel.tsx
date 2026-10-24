import { FolderIcon, InfoIcon } from "../icons";
import type { LibraryFolder } from "../../../engine/types/commands";
import { SourcesManager } from "../SourcesManager";

export function LibraryPanel(props: {
  autoImport: boolean;
  pairRawJpeg: boolean;
  stackBursts: boolean;
  onAddFolder?: () => void;
  onRemoveFolder?: (folder: LibraryFolder) => void;
  onRescan?: () => void;
  onRescanFolder?: (folder: LibraryFolder) => void;
  onChange: (key: any, value: any) => void;
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
            <span className="settings-row-desc">Automatically add files when dropped or saved to watched folders</span>
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
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Pair RAW + JPEG</b>
            <span className="settings-row-desc">Group RAW and JPEG files shot together as a single item</span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label="Pair RAW and JPEG files"
                checked={props.pairRawJpeg}
                onChange={(e) => props.onChange("pairRawJpeg", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Stack Burst Photos</b>
            <span className="settings-row-desc">Group rapid-sequence shots (burst mode) into stacks</span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label="Stack burst photos"
                checked={props.stackBursts}
                onChange={(e) => props.onChange("stackBursts", e.target.checked)}
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
      />

      <div className="settings-warning">
        <span className="settings-warning-icon"><InfoIcon size={14} /></span>
        <span>Folder watching requires granting Full Disk Access in System Settings → Privacy & Security. Without it, Stillroom can only import files you explicitly select.</span>
      </div>
    </>
  );
}

