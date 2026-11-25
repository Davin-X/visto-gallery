import {
  CropIcon,
  DownloadIcon,
  FlipIcon,
  RotateCcwIcon,
  RotateIcon,
  SparkleIcon,
} from "../../design/components/icons";
import type { EditValues, MediaItem } from "../../engine/types/media";
import { ASPECT_RATIO_OPTIONS } from "./aspectRatios";
import type { EditScreenProps } from "./types";

function SunMediumIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function ContrastIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" />
    </svg>
  );
}

function HighlightsIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
      <path
        d="M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M5.6 18.4l1.5-1.5M16.9 7.1l1.5-1.5"
        strokeWidth={1.4}
      />
    </svg>
  );
}

function ShadowsIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function WarmthIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
      <circle cx="11.5" cy="17.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

function SaturationIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
      <path d="M12 7v13a8 8 0 0 0 0-16z" fill="currentColor" opacity={0.35} />
    </svg>
  );
}

type EditControlActions = Pick<
  EditScreenProps,
  | "crop"
  | "onSetValue"
  | "onReset"
  | "onAuto"
  | "onRotate"
  | "onFlip"
  | "onSetCrop"
  | "onResetCrop"
  | "onSaveDraft"
  | "onExport"
  | "onClearDraft"
>;

interface EditControlsProps {
  item: MediaItem;
  values: EditValues;
  crop: EditScreenProps["crop"];
  hasAdjustments: boolean;
  setCropRatio: (ratio: number | "free") => void;
  onAdjust: () => void;
  onConfirmReplace: () => void;
  onConfirmRevert: () => void;
  actions: EditControlActions;
}

export function EditControls({
  item,
  values,
  crop,
  hasAdjustments,
  setCropRatio,
  onAdjust,
  onConfirmReplace,
  onConfirmRevert,
  actions: props,
}: EditControlsProps) {
  return (
    <aside className="edit-controls">
      {/* Segmented Tool Tabs */}
      <div className="edit-tabs" role="group" aria-label="Edit tools">
        <button
          type="button"
          className={!props.crop.enabled ? "active" : ""}
          aria-pressed={!props.crop.enabled}
          onClick={() => props.onSetCrop({ enabled: false })}
        >
          <SunMediumIcon size={14} />
          <span>Adjust</span>
        </button>
        <button
          type="button"
          className={props.crop.enabled ? "active" : ""}
          aria-pressed={props.crop.enabled}
          onClick={() => props.onSetCrop({ enabled: true })}
        >
          <CropIcon size={14} />
          <span>Crop</span>
        </button>
      </div>

      {/* Scrollable Adjustments / Crop Rail */}
      <div className="edit-rail-scroll">
        {props.crop.enabled ? (
          /* CROP & STRAIGHTEN PANEL */
          <div className="edit-crop-panel">
            <div className="edit-panel-heading">
              <div>
                <b>Crop &amp; straighten</b>
                <small>Drag the frame to reposition, resize with corner handle</small>
              </div>
              <button
                type="button"
                className="quiet-button"
                onClick={props.onResetCrop}
                title="Reset crop to full frame"
              >
                Reset
              </button>
            </div>

            <div className="crop-ratio-section">
              <span className="edit-option-label">Aspect ratio</span>
              <div className="crop-ratio-options" role="group" aria-label="Crop aspect ratio">
                {ASPECT_RATIO_OPTIONS.map((ratio) => (
                  <button
                    type="button"
                    key={ratio.label}
                    className={crop.aspectRatio === ratio.value ? "active" : ""}
                    aria-pressed={crop.aspectRatio === ratio.value}
                    onClick={() => setCropRatio(ratio.value)}
                    title={`${ratio.label} (${ratio.ratioName})`}
                  >
                    <span>{ratio.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="crop-quick-transforms">
              <span className="edit-option-label">Orientation</span>
              <div className="crop-transform-buttons">
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => props.onRotate(90)}
                  title="Rotate 90° clockwise"
                >
                  <RotateIcon size={13} />
                  <span>Rotate 90°</span>
                </button>
                <button
                  type="button"
                  className={`quiet-button ${values.flip ? "active" : ""}`}
                  onClick={() => props.onFlip()}
                  title="Flip horizontal"
                >
                  <FlipIcon size={13} />
                  <span>Flip horizontal</span>
                </button>
              </div>
            </div>

            <p className="edit-crop-help">
              The crop frame stays locked inside the photo dimensions. Press Shift while dragging
              for finer step adjustments.
            </p>
          </div>
        ) : (
          /* LIGHT & COLOR ADJUSTMENTS PANEL */
          <>
            <div className="edit-adjustment-header">
              <div className="edit-adjustment-heading">
                <b>Adjustments</b>
              </div>
              <div className="edit-adjustment-actions">
                <button
                  className="edit-auto-button"
                  type="button"
                  onClick={() => {
                    onAdjust();
                    props.onAuto();
                  }}
                  title="Auto enhance exposure, contrast, and color balance"
                >
                  <SparkleIcon size={13} />
                  <span>Auto</span>
                </button>
                <button
                  className="edit-reset-button"
                  type="button"
                  onClick={() => {
                    onAdjust();
                    props.onReset();
                  }}
                  disabled={!hasAdjustments}
                  title="Reset all adjustments back to 0%"
                >
                  <RotateCcwIcon size={12} />
                  <span>Reset all</span>
                </button>
              </div>
            </div>

            {/* Adjustment Groups */}
            {[
              {
                title: "Light",
                controls: [
                  { key: "exposure" as const, label: "Exposure", Icon: SunMediumIcon },
                  { key: "contrast" as const, label: "Contrast", Icon: ContrastIcon },
                  { key: "highlights" as const, label: "Highlights", Icon: HighlightsIcon },
                  { key: "shadows" as const, label: "Shadows", Icon: ShadowsIcon },
                ],
              },
              {
                title: "Color",
                controls: [
                  { key: "warmth" as const, label: "Warmth", Icon: WarmthIcon },
                  { key: "saturation" as const, label: "Saturation", Icon: SaturationIcon },
                ],
              },
            ].map((group) => (
              <section
                className="edit-adjustment-group"
                key={group.title}
                aria-label={`${group.title} adjustments`}
              >
                <h3>{group.title}</h3>
                {group.controls.map(({ key, label, Icon }) => {
                  const val = values[key] || 0;
                  return (
                    <div className="slider-control" key={key}>
                      <div className="slider-label-row">
                        <label htmlFor={`edit-${key}`} className="slider-label">
                          <Icon size={13} className="slider-icon" />
                          <span>{label}</span>
                        </label>
                        <button
                          type="button"
                          className={`slider-value-pill ${val !== 0 ? "is-modified" : ""}`}
                          aria-label={`Reset ${label}`}
                          title={`${label}: ${val > 0 ? "+" : ""}${val}%. Double-click to reset.`}
                          onClick={() => {
                            onAdjust();
                            props.onSetValue(key, 0);
                          }}
                        >
                          {val > 0 ? `+${val}` : val}
                          <small>%</small>
                        </button>
                      </div>
                      <div className="slider-track-wrap">
                        <input
                          id={`edit-${key}`}
                          type="range"
                          min={-80}
                          max={80}
                          value={val}
                          aria-label={label}
                          title={`${label} — drag to adjust, double-click to reset`}
                          onChange={(e) => {
                            onAdjust();
                            props.onSetValue(key, Number(e.target.value));
                          }}
                          onDoubleClick={() => {
                            onAdjust();
                            props.onSetValue(key, 0);
                          }}
                        />
                        {/* Center Detent Marker */}
                        <span className="slider-center-detent" aria-hidden="true" />
                        {/* Dynamic Fill Bar from Center (0%) */}
                        {val !== 0 && (
                          <span
                            className={`slider-fill-bar ${val > 0 ? "is-positive" : "is-negative"}`}
                            style={
                              val > 0
                                ? { left: "50%", width: `${(val / 80) * 50}%` }
                                : { right: "50%", width: `${(Math.abs(val) / 80) * 50}%` }
                            }
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            ))}
          </>
        )}
      </div>

      {/* CONTROL PANEL FOOTER */}
      <footer className="edit-footer">
        {/* Draft Controls */}
        <div className="edit-footer-row" role="group" aria-label="Draft actions">
          <button
            className="quiet-button edit-discard-draft-btn"
            type="button"
            onClick={() => item && props.onClearDraft(item.id)}
            disabled={!hasAdjustments}
            title="Discard all changes in the current draft"
          >
            Discard draft
          </button>
          <button
            className="quiet-button edit-save-draft-btn"
            type="button"
            onClick={async () => {
              await props.onSaveDraft();
            }}
            title="Save draft adjustments without modifying the original file"
          >
            Save draft
          </button>
        </div>

        {/* Permanent File Operations */}
        <div className="edit-footer-row" role="group" aria-label="File actions">
          <button
            className="quiet-button edit-restore-button"
            type="button"
            onClick={onConfirmRevert}
            disabled={!item}
            title="Restore the photo from its pre-edit backup, or discard draft changes"
          >
            Restore original
          </button>
          <button
            className="quiet-button edit-replace-button"
            type="button"
            disabled={
              !hasAdjustments ||
              !["jpg", "jpeg", "png", "webp"].includes(
                String(item.extension || item.name.split(".").pop() || "").toLowerCase(),
              )
            }
            title={
              !hasAdjustments
                ? "Make adjustments first — this bakes edits into the original file"
                : !["jpg", "jpeg", "png", "webp"].includes(
                      String(item.extension || item.name.split(".").pop() || "").toLowerCase(),
                    )
                  ? "Replace file is available for JPEG, PNG, and WebP files"
                  : "Bake current edits into the original file (a .bak backup is safely kept)"
            }
            onClick={onConfirmReplace}
          >
            Replace file
          </button>
        </div>

        {/* Primary Action Button */}
        <div className="edit-footer-primary-wrap">
          <button
            className="primary-button edit-save-copy"
            type="button"
            onClick={() => props.onExport(false)}
            title="Export an edited copy to a new file"
          >
            <DownloadIcon size={13} />
            <span>Save copy</span>
          </button>
        </div>

        <p className="edit-footer-note">
          Non-destructive editing · Original file safe until export
        </p>
      </footer>
    </aside>
  );
}
