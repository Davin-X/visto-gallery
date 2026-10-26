import { LockIcon, ShieldIcon } from "../icons";

export function PrivacyPanel() {
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
            VistoGallery scans and processes media locally. This build does not
            include analytics, crash reporting, or update checks.
          </p>
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
          <b>No background reporting</b>
          <small>
            There are no network or crash-report switches because those features
            are not present.
          </small>
        </div>
      </div>
    </section>
  );
}
