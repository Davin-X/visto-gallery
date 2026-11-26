import { GearIcon } from "../icons";
import type { AppSettings } from "../../../engine/types/settings";
import { SettingsSliderRow } from "./SettingsSliderRow";
import type { RenderAccentPicker, RenderRadioGroup, SettingsChange } from "./types";

export function GeneralPanel(props: {
  appearance: string;
  accentColor: string;
  sidebarWidth: number;
  inspectorWidth: number;
  animateTransitions: boolean;
  showExtensions: boolean;
  startupView: string;
  openLastFolder: boolean;
  restoreWindow: boolean;
  onChange: SettingsChange;
  renderRadioGroup: RenderRadioGroup;
  renderAccentPicker: RenderAccentPicker;
}) {
  return (
    <>
      <section className="settings-section">
        <h2 className="settings-section-title">
          <GearIcon size={14} /> Appearance
        </h2>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Theme</b>
          </div>
          <div className="settings-row-control">
            {props.renderRadioGroup(
              "theme",
              props.appearance,
              [
                { id: "light", label: "Light" },
                { id: "dark", label: "Dark" },
                { id: "system", label: "System" },
              ],
              (v: string) => props.onChange("appearance", v as AppSettings["appearance"]),
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Accent color</b>
          </div>
          <div className="settings-row-control">
            {props.renderAccentPicker(props.accentColor, (v: string) =>
              props.onChange("accentColor", v as AppSettings["accentColor"]),
            )}
          </div>
        </div>
        <SettingsSliderRow
          label="Sidebar width"
          description="Adjust the navigation sidebar size"
          value={props.sidebarWidth}
          min={180}
          max={360}
          step={4}
          unit="px"
          ariaLabel="Sidebar width"
          onChange={(v) => props.onChange("sidebarWidth", v)}
        />
        <SettingsSliderRow
          label="Inspector width"
          description="Adjust the right-hand inspector size"
          value={props.inspectorWidth}
          min={240}
          max={480}
          step={4}
          unit="px"
          ariaLabel="Inspector width"
          onChange={(v) => props.onChange("inspectorWidth", v)}
        />
        <div className="settings-row">
          <div className="settings-row-label">
            <b>
              <label htmlFor="setting-show-file-extensions">Show file extensions</label>
            </b>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                id="setting-show-file-extensions"
                type="checkbox"
                aria-label="Show file extensions"
                checked={props.showExtensions}
                onChange={(e) => props.onChange("showExtensions", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>
              <label htmlFor="setting-animate-transitions">Animate transitions</label>
            </b>
            <span className="settings-row-desc">Smooth animations for navigation and zoom</span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                id="setting-animate-transitions"
                type="checkbox"
                aria-label="Animate transitions"
                checked={props.animateTransitions}
                onChange={(e) => props.onChange("animateTransitions", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">
          <GearIcon size={14} /> Startup
        </h2>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Open on launch</b>
          </div>
          <div className="settings-row-control">
            {props.renderRadioGroup(
              "startup-view",
              props.startupView,
              [...STARTUP_VIEWS],
              (v: string) => props.onChange("startupView", v as AppSettings["startupView"]),
            )}
          </div>
        </div>
        {props.startupView === "last" && (
          <div className="settings-row">
            <div className="settings-row-label">
              <b>
                <label htmlFor="setting-open-last-library-folder">Open last library folder</label>
              </b>
              <span className="settings-row-desc">Automatically load the last opened folder</span>
            </div>
            <div className="settings-row-control">
              <label className="toggle-switch">
                <input
                  id="setting-open-last-library-folder"
                  type="checkbox"
                  aria-label="Open last library folder"
                  checked={props.openLastFolder}
                  onChange={(e) => props.onChange("openLastFolder", e.target.checked)}
                />
                <span className="toggle-track" />
              </label>
            </div>
          </div>
        )}
        <div className="settings-row">
          <div className="settings-row-label">
            <b>
              <label htmlFor="setting-restore-window-state">Restore window state</label>
            </b>
            <span className="settings-row-desc">
              Remember window size and position between launches
            </span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                id="setting-restore-window-state"
                type="checkbox"
                aria-label="Restore window state"
                checked={props.restoreWindow}
                onChange={(e) => props.onChange("restoreWindowState", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
      </section>
    </>
  );
}

const STARTUP_VIEWS = [
  { id: "library", label: "Library" },
  { id: "last", label: "Last view" },
] as const;
