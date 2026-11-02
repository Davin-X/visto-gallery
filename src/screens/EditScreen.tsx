import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  CropIcon,
  FlipIcon,
  RotateIcon,
  SparkleIcon,
} from "../design/components/icons";
import { BrandMark } from "../design/components/BrandMark";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { tauri } from "../engine/commands/tauri";
import {
  useDraftTransforms,
  useDraftIds,
  clearEditDraft,
  refreshDraftMeta,
  draftTransformStyle,
} from "../engine/stores/useEditStore";
import type { MediaItem, EditValues, CropRect } from "../engine/types/media";
import { draftImageStyle } from "../engine/utils/draftImage";

function PickerThumbnail({
  itemId,
  name,
  style,
}: {
  itemId: string;
  name: string;
  style?: React.CSSProperties;
}) {
  return (
    <CachedThumbnail
      itemId={itemId}
      name={name}
      size={256}
      style={style}
      showStatus
      placeholderClassName="edit-picker-thumb"
    />
  );
}
const initialEdits = {
  exposure: 0,
  contrast: 0,
  warmth: 0,
  shadows: 0,
  highlights: 0,
  saturation: 0,
  rotation: 0,
  flip: false,
};

interface EditScreenProps {
  item: MediaItem | null;
  values: EditValues | null;
  crop: {
    enabled: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    aspectRatio?: number | "free";
  };
  history: EditValues[];
  historyIndex: number;
  items: MediaItem[];
  assetUrl: (path: string) => string;
  canUndo: boolean;
  canRedo: boolean;
  onSetValue: (key: keyof EditValues, value: any) => void;
  onSetValues: (values: EditValues) => void;
  onReset: () => void;
  onAuto: () => void;
  onRotate: (deg: number) => void;
  onFlip: () => void;
  onSetCrop: (
    crop: Partial<{
      enabled: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
      aspectRatio?: number | "free";
    }>,
  ) => void;
  onResetCrop: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void | Promise<void>;
  onSaveDraft: () => Promise<void>;
  onBack: () => void;
  onExport: (inPlace?: boolean) => void | Promise<void>;
  onClearDraft: (id: string) => void;
  onNotice: (text: string) => void;
  onOpenEdit: (item: MediaItem) => void | Promise<void>;
}

function EditScreen(props: EditScreenProps) {
  const [showOriginalPreview, setShowOriginalPreview] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [draftTrayOpen, setDraftTrayOpen] = useState(false);
  const draftTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [draftPopoverPos, setDraftPopoverPos] = useState<{
    top: number;
    right: number;
  } | null>(null);
  useEffect(() => {
    if (draftTrayOpen && draftTriggerRef.current) {
      const rect = draftTriggerRef.current.getBoundingClientRect();
      setDraftPopoverPos({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      });
    } else {
      setDraftPopoverPos(null);
    }
  }, [draftTrayOpen]);
  useEffect(() => {
    void refreshDraftMeta();
  }, []);

  const draftTransforms = useDraftTransforms();
  const draftIds = useDraftIds();
  const stageRef = useRef<any>(null);
  const [drag, setDrag] = useState<any>(null);
  const values = (props.values || {}) as EditValues;
  const hasAdjustments = Object.entries(initialEdits).some(
    ([key, value]) => (values as any)[key] !== value,
  );
  const crop = props.crop || {
    enabled: false,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };
  const savedDraftItems = useMemo(
    () =>
      (props.items || []).filter(
        (item: any) => draftIds.has(item.id) && !item.hidden,
      ),
    [props.items, draftIds],
  );
  const previewValues = showOriginalPreview ? initialEdits : values;
  const warmth = Number(previewValues.warmth || 0);
  const previewFilter = [
    `brightness(${100 + (previewValues.exposure || 0) + (previewValues.shadows || 0) * 0.22 + (previewValues.highlights || 0) * 0.1}%)`,
    `contrast(${100 + (previewValues.contrast || 0) - (previewValues.shadows || 0) * 0.08 + (previewValues.highlights || 0) * 0.12}%)`,
    `saturate(${100 + (previewValues.saturation || 0)}%)`,
    `sepia(${Math.abs(warmth) * 0.004})`,
    `hue-rotate(${warmth < 0 ? 180 : 0}deg)`,
  ].join(" ");
  useEffect(() => {
    setShowOriginalPreview(false);
  }, [props.item?.id]);

  // Save draft when leaving the edit screen or switching items, as a
  // safety net for any navigation path that doesn't explicitly call onSaveDraft.
  const exitItemId = props.item?.id;
  useEffect(() => {
    return () => {
      void props.onSaveDraft?.();
    };
  }, [exitItemId, props.onSaveDraft]);
  useEffect(() => {
    if (!drag || !props.item) return;
    const onMove = (e: any) => {
      const dx = (e.clientX - drag.startX) / drag.rect.width;
      const dy = (e.clientY - drag.startY) / drag.rect.height;
      if (drag.type === "move") {
        const nx = Math.min(Math.max(drag.crop.x + dx, 0), 1 - drag.crop.width);
        const ny = Math.min(
          Math.max(drag.crop.y + dy, 0),
          1 - drag.crop.height,
        );
        props.onSetCrop({ x: nx, y: ny });
      } else if (typeof drag.crop.aspectRatio === "number") {
        const ratio = drag.crop.aspectRatio;
        const widthDeltaFromHeight =
          (dy * ratio) / (drag.rect.width / drag.rect.height);
        const widthDelta =
          Math.abs(dx) >= Math.abs(widthDeltaFromHeight)
            ? dx
            : widthDeltaFromHeight;
        const maxWidth = Math.min(
          1 - drag.crop.x,
          ((1 - drag.crop.y) * ratio) / (drag.rect.width / drag.rect.height),
        );
        const width = Math.min(
          maxWidth,
          Math.max(0.04, drag.crop.width + widthDelta),
        );
        const height = (width * (drag.rect.width / drag.rect.height)) / ratio;
        props.onSetCrop({ width, height });
      } else {
        const nw = Math.min(
          Math.max(drag.crop.width + dx, 0.05),
          1 - drag.crop.x,
        );
        const nh = Math.min(
          Math.max(drag.crop.height + dy, 0.05),
          1 - drag.crop.y,
        );
        props.onSetCrop({ width: nw, height: nh });
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, props]);
  const startDrag = (type: string, e: any) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = stageRef.current.getBoundingClientRect();
    setDrag({
      type,
      startX: e.clientX,
      startY: e.clientY,
      crop: { ...crop },
      rect,
    });
  };
  const setCropRatio = (ratio: number | "free") => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect?.height || ratio === "free") {
      props.onSetCrop({ aspectRatio: ratio });
      return;
    }
    const stageRatio = rect.width / rect.height;
    const cropRatio = ratio;
    let width = Math.min(0.78, (0.78 * stageRatio) / cropRatio);
    let height = (width * stageRatio) / cropRatio;
    if (height > 0.78) {
      height = 0.78;
      width = (height * cropRatio) / stageRatio;
    }
    props.onSetCrop({
      aspectRatio: ratio,
      x: (1 - width) / 2,
      y: (1 - height) / 2,
      width,
      height,
    });
  };

  if (!props.item) {
    const draftTiles = savedDraftItems.map((item: any) => (
      <button
        key={item.id}
        type="button"
        className="edit-picker-tile"
        style={{ minWidth: 140, width: 140 }}
        onClick={() => props.onOpenEdit?.(item)}
      >
        <CachedThumbnail
          itemId={item.id}
          name={item.name}
          size={256}
          style={draftImageStyle(draftTransforms, item.id)}
        />
        <span>{item.name}</span>
        <span className="draft-badge">Draft</span>
        <button
          className="draft-remove"
          type="button"
          aria-label={`Remove draft for ${item.name}`}
          title="Remove draft"
          onClick={(e) => {
            e.stopPropagation();
            clearEditDraft(item.id);
            props.onNotice?.("Draft removed");
          }}
        >
          ×
        </button>
      </button>
    ));
    return (
      <div className="edit-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">NON-DESTRUCTIVE EDITING</p>
            <h1>Select a photo to edit</h1>
            <p className="page-subtitle">
              Open a photo from the Library to begin editing.
            </p>
          </div>
          <div style={{ marginTop: 20 }}>
            <button
              className="primary-button"
              type="button"
              onClick={() => props.onBack?.()}
            >
              Back to Library
            </button>
          </div>
        </div>
        {savedDraftItems.length > 0 && (
          <div style={{ marginTop: 24, marginLeft: 16 }}>
            <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>
              Saved drafts
            </h3>
            <div
              style={{
                display: "flex",
                gap: 8,
                overflowX: "auto",
                paddingBottom: 12,
                marginBottom: 8,
              }}
            >
              {draftTiles}
            </div>
          </div>
        )}
      </div>
    );
  }

  // The editor is a still-image pipeline. Rendering a video here used to pull
  // the whole file through the asset protocol (a 3 GB MKV froze the app), so
  // videos get an explanation instead of a preview.
  if (props.item.kind === "video") {
    return (
      <div className="edit-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">NON-DESTRUCTIVE EDITING</p>
            <h1>{props.item.name}</h1>
            <p className="page-subtitle">
              Videos aren't edited here. Play it from the Library, or use a
              desktop video editor for cuts and colour work.
            </p>
          </div>
          <div style={{ marginTop: 20 }}>
            <button
              className="primary-button"
              type="button"
              onClick={() => props.onBack?.()}
            >
              Back to Library
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="edit-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">NON-DESTRUCTIVE EDITING</p>
          <h1>{props.item.name}</h1>
          <p className="page-subtitle">
            Adjustments are applied only when you export a new copy.
          </p>
        </div>
        <div className="edit-heading-actions">
          {savedDraftItems.length > 0 && (
            <div className="edit-drafts-menu">
              <button
                ref={draftTriggerRef}
                className="quiet-button edit-drafts-trigger"
                type="button"
                aria-expanded={draftTrayOpen}
                onClick={() => setDraftTrayOpen((open) => !open)}
              >
                Drafts <span>{savedDraftItems.length}</span>
              </button>
              {draftTrayOpen &&
                draftPopoverPos &&
                createPortal(
                  <div
                    className="edit-drafts-popover"
                    style={{
                      position: "fixed",
                      top: draftPopoverPos.top,
                      right: draftPopoverPos.right,
                      left: "auto",
                      zIndex: 1001,
                    }}
                    aria-label="Saved edit drafts"
                  >
                    <div className="edit-drafts-popover-head">
                      <b>Saved drafts</b>
                      <small>
                        {savedDraftItems.length}{" "}
                        {savedDraftItems.length === 1 ? "photo" : "photos"}
                      </small>
                    </div>
                    <div className="edit-drafts-list">
                      {savedDraftItems.map((item: any) => (
                        <div key={item.id} className="edit-draft-card">
                          <button
                            className="edit-draft-open"
                            type="button"
                            onClick={async () => {
                              await props.onSaveDraft?.();
                              await props.onOpenEdit?.(item);
                              setDraftTrayOpen(false);
                            }}
                            title={`Open draft for ${item.name}`}
                          >
                            <CachedThumbnail
                              itemId={item.id}
                              name={item.name}
                              size={256}
                              style={draftImageStyle(draftTransforms, item.id)}
                            />
                            <span>{item.name}</span>
                          </button>
                          <button
                            className="edit-draft-remove"
                            type="button"
                            aria-label={`Remove draft for ${item.name}`}
                            title="Remove draft"
                            onClick={() => {
                              clearEditDraft(item.id);
                              props.onNotice?.("Draft removed");
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>,
                  document.querySelector(".app-frame") || document.body,
                )}
            </div>
          )}
          <button
            className="primary-button"
            type="button"
            onClick={async () => {
              await props.onClose?.();
            }}
          >
            Select photo
          </button>
          <span className="saved-indicator">
            <i /> Original unchanged
          </span>
        </div>
      </div>
      <div className="editor-layout">
        <div className="edit-canvas">
          <div className="edit-preview-toolbar">
            <span title={props.item.name}>{props.item.name}</span>
            <div className="edit-history-controls" aria-label="Edit history">
              <button
                type="button"
                onClick={() => {
                  setShowOriginalPreview(false);
                  props.onUndo();
                }}
                disabled={!props.canUndo}
                aria-label="Undo"
                title="Undo"
              >
                ↶
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowOriginalPreview(false);
                  props.onRedo();
                }}
                disabled={!props.canRedo}
                aria-label="Redo"
                title="Redo"
              >
                ↷
              </button>
            </div>
            <button
              type="button"
              className={showOriginalPreview ? "active" : ""}
              aria-pressed={showOriginalPreview}
              onClick={() => setShowOriginalPreview((value) => !value)}
            >
              {showOriginalPreview ? "Show edits" : "Compare"}
            </button>
          </div>
          <div
            ref={stageRef}
            className={`crop-stage${showOriginalPreview ? " is-original" : ""}`}
          >
            <img
              src={props.assetUrl(props.item.path)}
              alt={props.item.name}
              style={{
                transform: `rotate(${previewValues.rotation}deg) scaleX(${previewValues.flip ? -1 : 1})`,
                filter: previewFilter,
              }}
            />
            {crop.enabled && !showOriginalPreview && (
              <div
                className="crop-overlay"
                style={{
                  position: "absolute",
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.width * 100}%`,
                  height: `${crop.height * 100}%`,
                  border: "2px solid #fff",
                  boxShadow: "0 0 0 9999px rgba(0,0,0,.45)",
                  cursor: "move",
                }}
                tabIndex={0}
                role="application"
                aria-label="Crop frame"
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 0.05 : 0.01;
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    props.onSetCrop({ x: Math.max(0, crop.x - step) });
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    props.onSetCrop({
                      x: Math.min(1 - crop.width, crop.x + step),
                    });
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    props.onSetCrop({ y: Math.max(0, crop.y - step) });
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    props.onSetCrop({
                      y: Math.min(1 - crop.height, crop.y + step),
                    });
                  }
                }}
                onPointerDown={(e) => startDrag("move", e)}
              >
                <span
                  className="crop-handle br"
                  style={{
                    position: "absolute",
                    right: -6,
                    bottom: -6,
                    width: 12,
                    height: 12,
                    background: "#fff",
                    border: "1px solid #333",
                    cursor: "nwse-resize",
                    borderRadius: 2,
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label="Resize crop"
                  onKeyDown={(e) => {
                    const step = e.shiftKey ? 0.05 : 0.01;
                    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                      e.preventDefault();
                      props.onSetCrop({
                        width: Math.min(1 - crop.x, crop.width + step),
                        height: Math.min(1 - crop.y, crop.height + step),
                      });
                    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                      e.preventDefault();
                      props.onSetCrop({
                        width: Math.max(0.05, crop.width - step),
                        height: Math.max(0.05, crop.height - step),
                      });
                    }
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    startDrag("resize", e);
                  }}
                />
              </div>
            )}
          </div>
          <div className="canvas-actions">
            <button
              type="button"
              onClick={() => {
                setShowOriginalPreview(false);
                props.onRotate(90);
              }}
            >
              <RotateIcon size={14} /> Rotate
            </button>
            <button
              type="button"
              className={values.flip ? "active" : ""}
              aria-pressed={!!values.flip}
              onClick={() => {
                setShowOriginalPreview(false);
                props.onFlip();
              }}
            >
              <FlipIcon size={14} /> Flip
            </button>
            <button
              type="button"
              className={props.crop.enabled ? "active" : ""}
              aria-pressed={!!props.crop.enabled}
              onClick={() => {
                setShowOriginalPreview(false);
                props.crop.enabled
                  ? props.onResetCrop?.()
                  : props.onSetCrop({ enabled: true });
              }}
            >
              <CropIcon size={14} />{" "}
              {props.crop.enabled ? "Reset crop" : "Crop"}
            </button>
          </div>
        </div>
        <aside className="edit-controls">
          <div className="edit-tabs" role="group" aria-label="Edit tools">
            <button
              type="button"
              className={!props.crop.enabled ? "active" : ""}
              aria-pressed={!props.crop.enabled}
              onClick={() => props.onSetCrop({ enabled: false })}
            >
              Light &amp; color
            </button>
            <button
              type="button"
              className={props.crop.enabled ? "active" : ""}
              aria-pressed={props.crop.enabled}
              onClick={() => props.onSetCrop({ enabled: true })}
            >
              Crop
            </button>
          </div>
          {props.crop.enabled ? (
            <div className="edit-crop-panel">
              <div className="edit-panel-heading">
                <div>
                  <b>Crop &amp; straighten</b>
                  <small>Drag the frame to reposition it</small>
                </div>
                <button type="button" onClick={props.onResetCrop}>
                  Reset
                </button>
              </div>
              <span className="edit-option-label">Aspect ratio</span>
              <div
                className="crop-ratio-options"
                role="group"
                aria-label="Crop aspect ratio"
              >
                {[
                  { label: "Free", value: "free" as const },
                  { label: "1:1", value: 1 },
                  { label: "4:3", value: 4 / 3 },
                  { label: "3:2", value: 3 / 2 },
                  { label: "16:9", value: 16 / 9 },
                ].map((ratio) => (
                  <button
                    type="button"
                    key={ratio.label}
                    className={crop.aspectRatio === ratio.value ? "active" : ""}
                    aria-pressed={crop.aspectRatio === ratio.value}
                    onClick={() => setCropRatio(ratio.value)}
                  >
                    {ratio.label}
                  </button>
                ))}
              </div>
              <p className="edit-crop-help">
                Resize from the lower-right handle. The crop stays inside the
                photo.
              </p>
            </div>
          ) : (
            <>
              <div className="edit-adjustment-header">
                <div className="edit-adjustment-heading">
                  <span className="edit-adjustment-mark">
                    <SparkleIcon size={15} />
                  </span>
                  <div>
                    <b>Adjustments</b>
                    <small>Live preview · non-destructive</small>
                  </div>
                </div>
                <div className="edit-adjustment-actions">
                  <button
                    className="edit-auto-button"
                    type="button"
                    onClick={() => {
                      setShowOriginalPreview(false);
                      props.onAuto();
                    }}
                  >
                    <SparkleIcon size={13} /> Auto
                  </button>
                  <button
                    className="edit-reset-button"
                    type="button"
                    onClick={() => {
                      setShowOriginalPreview(false);
                      props.onReset();
                    }}
                    disabled={!hasAdjustments}
                  >
                    Reset all
                  </button>
                </div>
              </div>
              {[
                {
                  title: "Light",
                  controls: [
                    { key: "exposure" as const, label: "Exposure" },
                    { key: "shadows" as const, label: "Shadows" },
                    { key: "highlights" as const, label: "Highlights" },
                    { key: "contrast" as const, label: "Contrast" },
                  ],
                },
                {
                  title: "Color",
                  controls: [
                    { key: "warmth" as const, label: "Warmth" },
                    { key: "saturation" as const, label: "Saturation" },
                  ],
                },
              ].map((group) => (
                <section
                  className="edit-adjustment-group"
                  key={group.title}
                  aria-label={`${group.title} adjustments`}
                >
                  <h3>{group.title}</h3>
                  {group.controls.map(({ key, label }) => (
                    <div className="slider-control" key={key}>
                      <span>
                        <label htmlFor={`edit-${key}`}>{label}</label>
                        <button
                          type="button"
                          className="slider-value-reset"
                          aria-label={`Reset ${label}`}
                          title={`Reset ${label}`}
                          onClick={() => {
                            setShowOriginalPreview(false);
                            props.onSetValue(key, 0);
                          }}
                        >
                          {values[key] > 0 ? "+" : ""}
                          {values[key] || 0}
                          <i>%</i>
                        </button>
                      </span>
                      <input
                        id={`edit-${key}`}
                        type="range"
                        min={-80}
                        max={80}
                        value={values[key]}
                        aria-label={label}
                        onChange={(e) => {
                          setShowOriginalPreview(false);
                          props.onSetValue(key, Number(e.target.value));
                        }}
                      />
                    </div>
                  ))}
                </section>
              ))}
            </>
          )}
          <div className="edit-footer">
            <button
              className="quiet-button"
              type="button"
              onClick={() => props.item && props.onClearDraft(props.item.id)}
            >
              Discard draft
            </button>
            <button
              className="quiet-button"
              type="button"
              onClick={async () => {
                await props.onSaveDraft();
              }}
            >
              Save draft
            </button>
            <button
              className="quiet-button"
              type="button"
              style={{ color: "#d33" }}
              disabled={
                !["jpg", "jpeg", "png", "webp"].includes(
                  String(
                    props.item.extension ||
                      props.item.name.split(".").pop() ||
                      "",
                  ).toLowerCase(),
                )
              }
              title="Replace original is available for JPEG, PNG, and WebP files"
              onClick={() => setConfirmReplace(true)}
            >
              Replace original
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => props.onExport(false)}
            >
              Save copy
            </button>
          </div>
        </aside>
      </div>
      <p className="browser-capability-warning">
        Browser canvas export supports JPEG, PNG, and WebP input when the
        browser can decode it. HEIC and RAW need native macOS image frameworks.
        Metadata is removed from re-encoded exports.
      </p>
      {confirmReplace && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "var(--surface)",
              padding: 20,
              borderRadius: 8,
              maxWidth: 420,
              width: "90%",
            }}
          >
            <h3 style={{ margin: "0 0 8px", color: "var(--text)" }}>
              Replace original file?
            </h3>
            <p style={{ margin: "0 0 16px", color: "var(--muted)" }}>
              This will overwrite the original image with the edited version.
              This cannot be undone.
            </p>
            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
              <button
                className="quiet-button"
                type="button"
                onClick={() => setConfirmReplace(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                style={{ background: "#d33", borderColor: "#d33" }}
                onClick={() => {
                  setConfirmReplace(false);
                  props.onExport(true);
                }}
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default EditScreen;
