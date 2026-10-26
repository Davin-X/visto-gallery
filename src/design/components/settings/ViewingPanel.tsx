import type { CSSProperties } from "react";
import { EyeIcon } from "../icons";

export function ViewingPanel(props: {
  defaultLayout: string;
  thumbnailSize: string;
  slideshowInterval: number;
  slideshowShuffle: boolean;
  slideshowLoop: boolean;
  videoAutoPlay: boolean;
  videoLoop: boolean;
  onChange: (key: any, value: any) => void;
  renderRadioGroup: any;
}) {
  return (
    <>
      <section className="settings-section">
        <h2 className="settings-section-title">
          <EyeIcon size={14} /> Grid & Layout
        </h2>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Default Layout</b>
            <span className="settings-row-desc">
              Starting layout when opening the library
            </span>
          </div>
          <div className="settings-row-control">
            {props.renderRadioGroup(
              "layout",
              props.defaultLayout,
              LAYOUT_OPTIONS,
              (v: string) => props.onChange("defaultLayout", v),
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Thumbnail Size</b>
            <span className="settings-row-desc">
              Default thumbnail dimensions in grid view
            </span>
          </div>
          <div className="settings-row-control">
            <select
              className="settings-select"
              aria-label="Thumbnail size"
              value={props.thumbnailSize}
              onChange={(e) => props.onChange("thumbnailSize", e.target.value)}
            >
              {THUMBNAIL_SIZES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">
          <EyeIcon size={14} /> Slideshow
        </h2>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Interval</b>
            <span className="settings-row-desc">Seconds between slides</span>
          </div>
          <div
            className="settings-row-control"
            style={{ alignItems: "center" }}
          >
            <input
              type="range"
              className="settings-slider"
              style={
                {
                  "--slider-progress": `${((props.slideshowInterval - 2) / 28) * 100}%`,
                } as CSSProperties
              }
              min={2}
              max={30}
              step={1}
              value={props.slideshowInterval}
              onChange={(e) =>
                props.onChange("slideshowInterval", Number(e.target.value))
              }
              aria-label="Slideshow interval in seconds"
            />
            <span className="settings-slider-value">
              {props.slideshowInterval}s
            </span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Shuffle</b>
            <span className="settings-row-desc">Randomize slide order</span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label="Shuffle slideshow"
                checked={props.slideshowShuffle}
                onChange={(e) =>
                  props.onChange("slideshowShuffle", e.target.checked)
                }
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Loop</b>
            <span className="settings-row-desc">
              Restart from beginning when reaching the end
            </span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label="Loop slideshow"
                checked={props.slideshowLoop}
                onChange={(e) =>
                  props.onChange("slideshowLoop", e.target.checked)
                }
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">
          <EyeIcon size={14} /> Video Playback
        </h2>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Auto-play</b>
            <span className="settings-row-desc">
              Start playing videos when opened in viewer
            </span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label="Auto-play videos"
                checked={props.videoAutoPlay}
                onChange={(e) =>
                  props.onChange("videoAutoPlay", e.target.checked)
                }
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Loop Videos</b>
            <span className="settings-row-desc">
              Restart video when it ends
            </span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label="Loop videos"
                checked={props.videoLoop}
                onChange={(e) => props.onChange("videoLoop", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
      </section>
    </>
  );
}

const LAYOUT_OPTIONS = [
  { id: "grid", label: "Grid" },
  { id: "details", label: "Details" },
  { id: "timeline", label: "Timeline" },
] as const;

const THUMBNAIL_SIZES = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
] as const;
