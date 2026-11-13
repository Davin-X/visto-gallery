import type { CSSProperties } from "react";
import { GearIcon, ChevronDownIcon } from "../icons";
import type { AppSettings } from "../../../engine/types/settings";
import type { RenderAccentPicker, RenderRadioGroup, SettingsChange } from "./types";

export function GeneralPanel(props: {
  appearance: string;
  accentColor: string;
  sidebarWidth: number;
  animateTransitions: boolean;
  showExtensions: boolean;
  startupView: string;
  openLastFolder: boolean;
  restoreWindow: boolean;
  onChange: SettingsChange;
  onSidebarWidthChange: (width: number) => void;
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
            <b>Accent Color</b>
          </div>
          <div className="settings-row-control">
            {props.renderAccentPicker(props.accentColor, (v: string) =>
              props.onChange("accentColor", v as AppSettings["accentColor"]),
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Sidebar Width</b>
            <span className="settings-row-desc">Adjust the navigation sidebar size</span>
          </div>
          <div className="settings-row-control" style={{ alignItems: "center" }}>
            <input
              type="range"
              className="settings-slider"
              style={
                {
                  "--slider-progress": `${((props.sidebarWidth - 180) / 180) * 100}%`,
                } as CSSProperties
              }
              min={180}
              max={360}
              step={4}
              value={props.sidebarWidth}
              onChange={(e) => props.onSidebarWidthChange(Number(e.target.value))}
              aria-label="Sidebar width"
            />
            <span className="settings-slider-value">{props.sidebarWidth}px</span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Show File Extensions</b>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
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
            <b>Animate Transitions</b>
            <span className="settings-row-desc">Smooth animations for navigation and zoom</span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
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
            <b>Open On Launch</b>
          </div>
          <div className="settings-row-control">
            <span className="settings-select-wrap">
              <select
                className="settings-select"
                aria-label="Open on launch"
                value={props.startupView}
                onChange={(e) =>
                  props.onChange("startupView", e.target.value as AppSettings["startupView"])
                }
              >
                {STARTUP_VIEWS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <ChevronDownIcon size={16} className="settings-select-chevron" />
            </span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Open Last Library Folder</b>
            <span className="settings-row-desc">Automatically load the last opened folder</span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label="Open last library folder"
                checked={props.openLastFolder}
                onChange={(e) => props.onChange("openLastFolder", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Restore Window State</b>
            <span className="settings-row-desc">
              Remember window size, position, and sidebar width
            </span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
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
  { id: "last", label: "Last View" },
] as const;
