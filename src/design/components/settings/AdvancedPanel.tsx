import { CpuIcon, TrashIcon } from "../icons";
import type { ErrorCode } from "../../../engine/types/commands";
import { RootPathMapping } from "./RootPathMapping";
import { SettingsSliderRow } from "./SettingsSliderRow";
import { StorageSection } from "./StorageSection";
import type { SettingsChange } from "./types";

export function AdvancedPanel(props: {
  maxCacheSize: number;
  thumbnailQuality: number;
  debugLogging: boolean;
  showNativeWarnings: boolean;
  onChange: SettingsChange;
  setShowResetConfirm: (v: boolean) => void;
  setShowDeleteConfirm: (v: boolean) => void;
  deleting: boolean;
  onRebuild: () => void;
  rebuilding: boolean;
  onCreateBackup: () => void;
  onChooseRestore: () => void;
  backupBusy: boolean;
  restoring: boolean;
  vacuuming: boolean;
  onVacuumCatalog: () => void;
  suggestedOldRoot: string | null;
  onRootMappingApplied: () => void;
  showNotice: (text: string, code?: ErrorCode) => void;
}) {
  return (
    <>
      <section className="settings-section settings-cache-perf">
        <h2 className="settings-section-title">
          <CpuIcon size={14} /> Cache & performance
        </h2>
        <SettingsSliderRow
          label="Maximum cache size"
          description="Limit for each cache: thumbnails, and videos converted for playback"
          value={props.maxCacheSize}
          min={1}
          max={50}
          step={1}
          unit=" GB"
          ariaLabel="Maximum cache size in gigabytes"
          onChange={(v) => props.onChange("maxCacheSizeGB", v)}
        />
        <SettingsSliderRow
          label="Thumbnail quality"
          description="JPEG quality for generated thumbnails (higher = larger files)"
          value={props.thumbnailQuality}
          min={50}
          max={100}
          step={5}
          unit="%"
          ariaLabel="Thumbnail JPEG quality percentage"
          onChange={(v) => props.onChange("thumbnailQuality", v)}
        />
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Rebuild library</b>
            <span className="settings-row-desc">
              Re-scan every source folder and refresh the catalog
            </span>
          </div>
          <div className="settings-row-control">
            <button
              className="quiet-button"
              type="button"
              onClick={props.onRebuild}
              disabled={props.rebuilding}
            >
              {props.rebuilding ? "Rebuilding…" : "Rebuild library"}
            </button>
          </div>
        </div>
      </section>

      <StorageSection showNotice={props.showNotice} />

      <section className="settings-section settings-catalog-actions">
        <h2 className="settings-section-title">
          <CpuIcon size={14} /> Catalog backup
        </h2>
        <p className="settings-section-desc">
          Back up albums, tags, ratings, Smart Albums, and library settings in one versioned SQLite
          snapshot. Original media files are never copied or modified.
        </p>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Save catalog backup…</b>
            <span className="settings-row-desc">
              Writes a validated snapshot that can be restored later
            </span>
          </div>
          <div className="settings-row-control">
            <button
              className="quiet-button"
              type="button"
              onClick={props.onCreateBackup}
              disabled={props.backupBusy || props.restoring}
            >
              {props.backupBusy ? "Saving…" : "Save backup…"}
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Restore catalog backup…</b>
            <span className="settings-row-desc">
              Validates first, creates a pre-restore snapshot, and reports files that are no longer
              at their saved paths
            </span>
          </div>
          <div className="settings-row-control">
            <button
              className="danger-button"
              type="button"
              onClick={props.onChooseRestore}
              disabled={props.backupBusy || props.restoring}
            >
              {props.restoring ? "Restoring…" : "Restore backup…"}
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Vacuum catalog</b>
            <span className="settings-row-desc">
              Reclaims disk space by defragmenting the catalog database
            </span>
          </div>
          <div className="settings-row-control">
            <button
              className="quiet-button"
              type="button"
              onClick={props.onVacuumCatalog}
              disabled={props.vacuuming}
            >
              {props.vacuuming ? "Vacuuming…" : "Vacuum"}
            </button>
          </div>
        </div>
      </section>

      <RootPathMapping
        suggestedOldRoot={props.suggestedOldRoot}
        onApplied={props.onRootMappingApplied}
        showNotice={props.showNotice}
      />

      <section className="settings-section settings-cache-perf">
        <h2 className="settings-section-title">
          <CpuIcon size={14} /> Developer
        </h2>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>
              <label htmlFor="setting-debug-logging">Debug logging</label>
            </b>
            <span className="settings-row-desc">
              Verbose logs in the developer console and Console.app for troubleshooting
            </span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                id="setting-debug-logging"
                type="checkbox"
                aria-label="Enable debug logging"
                checked={props.debugLogging}
                onChange={(e) => props.onChange("enableDebugLogging", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>
              <label htmlFor="setting-native-limit-warnings">Show native limit warnings</label>
            </b>
            <span className="settings-row-desc">
              Display notices when browser preview lacks native features
            </span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                id="setting-native-limit-warnings"
                type="checkbox"
                aria-label="Show native limit warnings"
                checked={props.showNativeWarnings}
                onChange={(e) => props.onChange("showNativeLimitWarnings", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
      </section>

      <section className="settings-section settings-danger-zone">
        <h2 className="settings-section-title">
          <TrashIcon size={14} /> Danger zone
        </h2>
        <p className="settings-section-desc">
          These actions change VistoGallery preferences or its catalog. Original media files are
          never deleted.
        </p>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Reset all settings</b>
            <span className="settings-row-desc">Restores all settings to defaults</span>
          </div>
          <div className="settings-row-control">
            <button
              className="danger-button"
              type="button"
              onClick={() => props.setShowResetConfirm(true)}
            >
              Reset all settings…
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Reset library</b>
            <span className="settings-row-desc">
              Removes every item, album and tag from VistoGallery. Your files stay on disk.
            </span>
          </div>
          <div className="settings-row-control">
            <button
              className="danger-button"
              type="button"
              onClick={() => props.setShowDeleteConfirm(true)}
              disabled={props.deleting}
            >
              {props.deleting ? "Resetting…" : "Reset library…"}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
