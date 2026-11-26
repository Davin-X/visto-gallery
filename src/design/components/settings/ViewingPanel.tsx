import type { CSSProperties } from "react";
import { EyeIcon } from "../icons";
import type { AppSettings } from "../../../engine/types/settings";
import type { RenderRadioGroup, SettingsChange } from "./types";

export function ViewingPanel(props: {
  defaultLayout: string;
  thumbnailSize: string;
  slideshowInterval: number;
  slideshowShuffle: boolean;
  slideshowLoop: boolean;
  slideshowBackgroundAudio: boolean;
  slideshowBackgroundAudioPath: string | null;
  videoAutoPlay: boolean;
  videoLoop: boolean;
  onChange: SettingsChange;
  onPickAmbientAudio: () => void;
  onClearAmbientAudio: () => void;
  renderRadioGroup: RenderRadioGroup;
}) {
  return (
    <>
      <section className="settings-section">
        <h2 className="settings-section-title">
          <EyeIcon size={14} /> Grid & layout
        </h2>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Default layout</b>
            <span className="settings-row-desc">Starting layout when opening the library</span>
          </div>
          <div className="settings-row-control">
            {props.renderRadioGroup("layout", props.defaultLayout, LAYOUT_OPTIONS, (v: string) =>
              props.onChange("defaultLayout", v as AppSettings["defaultLayout"]),
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>Thumbnail size</b>
            <span className="settings-row-desc">Default thumbnail dimensions in grid view</span>
          </div>
          <div className="settings-row-control">
            {props.renderRadioGroup(
              "Thumbnail size",
              props.thumbnailSize,
              THUMBNAIL_SIZES,
              (v: string) => props.onChange("thumbnailSize", v as AppSettings["thumbnailSize"]),
            )}
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
          <div className="settings-row-control" style={{ alignItems: "center" }}>
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
              onChange={(e) => props.onChange("slideshowInterval", Number(e.target.value))}
              aria-label="Slideshow interval in seconds"
            />
            <span className="settings-slider-value">{props.slideshowInterval}s</span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>
              <label htmlFor="setting-shuffle-slideshow">Shuffle</label>
            </b>
            <span className="settings-row-desc">Randomize slide order</span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                id="setting-shuffle-slideshow"
                type="checkbox"
                aria-label="Shuffle slideshow"
                checked={props.slideshowShuffle}
                onChange={(e) => props.onChange("slideshowShuffle", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>
              <label htmlFor="setting-loop-slideshow">Loop</label>
            </b>
            <span className="settings-row-desc">Restart from beginning when reaching the end</span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                id="setting-loop-slideshow"
                type="checkbox"
                aria-label="Loop slideshow"
                checked={props.slideshowLoop}
                onChange={(e) => props.onChange("slideshowLoop", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>
              <label htmlFor="setting-enable-ambient-audio">Ambient audio</label>
            </b>
            <span className="settings-row-desc">
              Play a track under the slideshow. Off by default; the track is not cataloged, so it
              never touches your library.
            </span>
          </div>
          <div className="settings-row-control settings-ambient-control">
            <label className="toggle-switch">
              <input
                id="setting-enable-ambient-audio"
                type="checkbox"
                aria-label="Enable ambient audio"
                checked={props.slideshowBackgroundAudio}
                onChange={(e) => props.onChange("slideshowBackgroundAudio", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
            {props.slideshowBackgroundAudio && (
              <div className="settings-ambient-track">
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    color: "var(--text-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={props.slideshowBackgroundAudioPath || "No track chosen"}
                >
                  {props.slideshowBackgroundAudioPath
                    ? props.slideshowBackgroundAudioPath.split("/").pop()
                    : "No track chosen"}
                </span>
                <button type="button" className="settings-btn" onClick={props.onPickAmbientAudio}>
                  Choose…
                </button>
                {props.slideshowBackgroundAudioPath && (
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={props.onClearAmbientAudio}
                  >
                    Remove
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">
          <EyeIcon size={14} /> Video playback
        </h2>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>
              <label htmlFor="setting-auto-play-videos">Auto-play</label>
            </b>
            <span className="settings-row-desc">Start playing videos when opened in viewer</span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                id="setting-auto-play-videos"
                type="checkbox"
                aria-label="Auto-play videos"
                checked={props.videoAutoPlay}
                onChange={(e) => props.onChange("videoAutoPlay", e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <b>
              <label htmlFor="setting-loop-videos">Loop videos</label>
            </b>
            <span className="settings-row-desc">Restart video when it ends</span>
          </div>
          <div className="settings-row-control">
            <label className="toggle-switch">
              <input
                id="setting-loop-videos"
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
