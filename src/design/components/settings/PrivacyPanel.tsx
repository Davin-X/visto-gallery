import { LockIcon, ShieldIcon } from "../icons";

export function PrivacyPanel(props: {
  checkForUpdatesOnLaunch: boolean;
  onChange: (key: "checkForUpdatesOnLaunch", value: boolean) => void;
}) {
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
            VistoGallery scans and processes media locally. There is no
            analytics, crash reporting, or media upload.
          </p>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-label">
          <b>Check for updates on launch</b>
          <span className="settings-row-desc">
            When enabled, VistoGallery contacts GitHub for public release
            metadata once after launch. No library data or media is sent. Use
            Help → Check for Updates to check at any time, even when this is
            off.
          </span>
        </div>
        <div className="settings-row-control">
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-label="Check for updates on launch"
              checked={props.checkForUpdatesOnLaunch}
              onChange={(e) =>
                props.onChange("checkForUpdatesOnLaunch", e.target.checked)
              }
            />
            <span className="toggle-track" />
          </label>
        </div>
      </div>

      <div
        className="privacy-facts"
        aria-label="How VistoGallery handles your data"
      >
        <div>
          <span>Library</span>
          <b>Local database</b>
          <small>
            Library details and preferences are stored on this device.
          </small>
        </div>
        <div>
          <span>Exports</span>
          <b>Re-encoded locally</b>
          <small>
            Edited copies are re-encoded and do not retain embedded source
            metadata.
          </small>
        </div>
        <div>
          <span>Network</span>
          <b>Release checks only</b>
          <small>
            The only network request is an optional GitHub release check. It
            never includes your photos, paths, or library contents.
          </small>
        </div>
      </div>
    </section>
  );
}
