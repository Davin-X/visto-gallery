import { LockIcon, ShieldIcon } from "../icons";
import { useHiddenLockStore } from "../../../engine/stores/useHiddenLockStore";
import { tauri } from "../../../engine/commands/tauri";

export function PrivacyPanel(props: {
  checkForUpdatesOnLaunch: boolean;
  requireHiddenUnlock: boolean;
  onChange: (key: "checkForUpdatesOnLaunch" | "requireHiddenUnlock", value: boolean) => void;
}) {
  const unlocking = useHiddenLockStore((s) => s.unlocking);
  // Turning the lock off is itself protected: otherwise anyone at the Mac
  // could switch it off and open Hidden.
  const setRequireUnlock = async (value: boolean) => {
    if (!value && !(await useHiddenLockStore.getState().unlock())) return;
    props.onChange("requireHiddenUnlock", value);
    // Save at once rather than after the settings debounce: the backend reads
    // this on every Hidden request, and the lock state shown must match it.
    try {
      await tauri.settings.save({ requireHiddenUnlock: value });
    } finally {
      await useHiddenLockStore.getState().refresh();
    }
  };
  return (
    <section className="settings-section privacy-section">
      <h2 className="settings-section-title">
        <ShieldIcon size={14} /> Privacy
      </h2>
      <div className="privacy-overview">
        <span className="privacy-overview-icon" aria-hidden="true">
          <LockIcon size={17} />
        </span>
        <div>
          <b>Your library stays on this Mac</b>
          <p>
            VistoGallery scans and processes media locally. There is no analytics, crash reporting,
            or media upload.
          </p>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-label">
          <b>Check for updates on launch</b>
          <span className="settings-row-desc">
            When enabled, VistoGallery contacts GitHub for public release metadata once after
            launch. No library data or media is sent. Use Help → Check for Updates to check at any
            time, even when this is off.
          </span>
        </div>
        <div className="settings-row-control">
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label="Check for updates on launch"
              checked={props.checkForUpdatesOnLaunch}
              onChange={(e) => props.onChange("checkForUpdatesOnLaunch", e.target.checked)}
            />
            <span className="toggle-track" />
          </label>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-label">
          <b>Require Touch ID or password for Hidden</b>
          <span className="settings-row-desc">
            Hidden asks for Touch ID or your Mac password before it shows anything, and its count is
            not shown while locked. It locks again when the screen locks, when the window closes,
            and 5 minutes after you leave it. Hidden files are not encrypted and stay in their
            folders.
          </span>
        </div>
        <div className="settings-row-control">
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label="Require Touch ID or password for Hidden"
              checked={props.requireHiddenUnlock}
              disabled={unlocking}
              onChange={(e) => void setRequireUnlock(e.target.checked)}
            />
            <span className="toggle-track" />
          </label>
        </div>
      </div>

      <div className="privacy-facts" aria-label="How VistoGallery handles your data">
        <div>
          <span>Library</span>
          <b>Local database</b>
          <small>Library details and preferences are stored on this device.</small>
        </div>
        <div>
          <span>Exports</span>
          <b>Re-encoded locally</b>
          <small>
            Edited copies keep the source's embedded metadata (camera details, GPS). Batch export is
            stripped by default.
          </small>
        </div>
        <div>
          <span>Network</span>
          <b>Release checks only</b>
          <small>
            The only network request is an optional GitHub release check. It never includes your
            photos, paths, or library contents.
          </small>
        </div>
      </div>
    </section>
  );
}
