import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftIcon,
  CameraIcon,
  CheckIcon,
  ChevronDownIcon,
  CropIcon,
  EditIcon,
  FlipIcon,
  GridIcon,
  RotateIcon,
} from "../design/components/icons";
import { CachedThumbnail, invalidateThumbnailCache } from "../design/components/CachedThumbnail";
import { useFocusTrap } from "../design/hooks/useFocusTrap";
import { useKeyboard } from "../engine/hooks/useKeyboard";
import { tauri, formatDimensions } from "../engine/commands/tauri";
import {
  useDraftTransforms,
  useDraftIds,
  clearEditDraft,
  refreshDraftMeta,
} from "../engine/stores/useEditStore";
import type { EditValues } from "../engine/types/media";
import { draftImageStyle } from "../engine/utils/draftImage";
import { useDraftItems } from "./useDraftItems";
import { formatBytesSimple } from "../engine/utils/mediaTypes";

/* ===== Dedicated Edit Icons ===== */

import { EditControls } from "./edit/EditControls";
import { ASPECT_RATIO_OPTIONS } from "./edit/aspectRatios";
import type { EditScreenProps } from "./edit/types";

function EyeCompareIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
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
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function AspectGuideIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
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
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 9v6M17 9v6" strokeDasharray="2 2" strokeWidth={1.2} />
    </svg>
  );
}

function PaletteToneIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
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
      <circle cx="13.5" cy="6.5" r="1.5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r="1.5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r="1.5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r="1.5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.92 0 1.5-.58 1.5-1.5 0-.42-.16-.8-.44-1.1-.28-.31-.44-.69-.44-1.12 0-.92.75-1.67 1.67-1.67H16c3.31 0 6-2.69 6-6 0-5.52-4.48-10-10-10z" />
    </svg>
  );
}

const initialEdits: EditValues = {
  exposure: 0,
  contrast: 0,
  warmth: 0,
  shadows: 0,
  highlights: 0,
  saturation: 0,
  rotation: 0,
  flip: false,
};

/** An in-progress crop-frame drag: where it started and the crop it started from. */
interface CropDrag {
  type: string;
  startX: number;
  startY: number;
  crop: EditScreenProps["crop"];
  rect: DOMRect;
}

function EditScreen(props: EditScreenProps) {
  const [showOriginalPreview, setShowOriginalPreview] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const confirmReplaceDialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRevertDialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(confirmReplace, confirmReplaceDialogRef);
  useFocusTrap(confirmRevert, confirmRevertDialogRef);

  // Escape cancels whichever confirm modal is open (only one at a time).
  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (confirmReplace) {
          e.preventDefault();
          setConfirmReplace(false);
        } else if (confirmRevert) {
          e.preventDefault();
          setConfirmRevert(false);
        }
      },
      [confirmReplace, confirmRevert],
    ),
  ]);
  const [draftTrayOpen, setDraftTrayOpen] = useState(false);
  const [fileRevision, setFileRevision] = useState(0);
  const [showGrid, setShowGrid] = useState(false);
  const [canvasTone, setCanvasTone] = useState<"neutral" | "dark" | "black" | "white">("neutral");
  const [aspectGuide, setAspectGuide] = useState<number | "free" | null>(null);
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false);
  const [guideOffset, setGuideOffset] = useState({ x: 0, y: 0 });
  const guideDragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    maxX: number;
    maxY: number;
  } | null>(null);
  const [naturalDimensions, setNaturalDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const draftTriggerRef = useRef<HTMLButtonElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  const [draftPopoverPos, setDraftPopoverPos] = useState<{
    top: number;
    right: number;
  } | null>(null);
  // Measure Canvas Viewport
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewportSize({ width: rect.width, height: rect.height });
      }
    };

    updateSize();

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setViewportSize({ width, height });
        }
      }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (draftTrayOpen && draftTriggerRef.current) {
      const rect = draftTriggerRef.current.getBoundingClientRect();
      setDraftPopoverPos({
        top: rect.bottom + 8,
        right: Math.max(16, window.innerWidth - rect.right),
      });
    } else {
      setDraftPopoverPos(null);
    }
  }, [draftTrayOpen]);

  useEffect(() => {
    setGuideOffset({ x: 0, y: 0 });
  }, [aspectGuide, props.item?.id]);

  useEffect(() => {
    void refreshDraftMeta();
  }, []);

  const draftTransforms = useDraftTransforms();
  const draftIds = useDraftIds();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<CropDrag | null>(null);

  const values = (props.values || {}) as EditValues;

  const crop = props.crop || {
    enabled: false,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };

  // A crop is an edit too: without it a crop-only change would not show the
  // Draft chip and Replace/Discard/Reset stayed disabled.
  const hasAdjustments =
    crop.enabled ||
    Object.entries(initialEdits).some(([key, value]) => values[key as keyof EditValues] !== value);

  const savedDraftItems = useDraftItems(draftIds);

  const previewValues = showOriginalPreview ? initialEdits : values;
  const warmth = Number(previewValues.warmth || 0);
  const previewFilter = [
    `brightness(${100 + (previewValues.exposure || 0) + (previewValues.shadows || 0) * 0.22 + (previewValues.highlights || 0) * 0.1}%)`,
    `contrast(${100 + (previewValues.contrast || 0) - (previewValues.shadows || 0) * 0.08 + (previewValues.highlights || 0) * 0.12}%)`,
    `saturate(${100 + (previewValues.saturation || 0)}%)`,
    `sepia(${Math.abs(warmth) * 0.004})`,
    `hue-rotate(${warmth < 0 ? 180 : 0}deg)`,
  ].join(" ");

  const imgRef = useRef<HTMLImageElement | null>(null);
  const updateNaturalDimensions = useCallback((img: HTMLImageElement | null) => {
    if (!img) return;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNaturalDimensions((prev) => {
        if (prev?.width === img.naturalWidth && prev?.height === img.naturalHeight) {
          return prev;
        }
        return {
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
      });
    }
  }, []);

  useEffect(() => {
    setShowOriginalPreview(false);
    setFileRevision(0);
    setAspectGuide(null);
    if (props.item?.width && props.item?.height) {
      setNaturalDimensions({ width: props.item.width, height: props.item.height });
    }
  }, [props.item?.id, props.item?.width, props.item?.height]);

  // Save draft when leaving the edit screen or switching items. The cleanup
  // captures the latest onSaveDraft via a ref so a new callback identity from a
  // parent re-render never triggers a mid-session save.
  const exitItemId = props.item?.id;
  const onSaveDraftRef = useRef(props.onSaveDraft);
  useEffect(() => {
    onSaveDraftRef.current = props.onSaveDraft;
  });
  useEffect(() => {
    return () => {
      void onSaveDraftRef.current?.();
    };
  }, [exitItemId]);

  const handleRevert = async () => {
    if (!props.item) return;
    try {
      const reverted = await tauri.edit.revertRecipe(props.item.id);
      if (!reverted) {
        await props.onReset();
        props.onNotice?.("No file backup to restore — draft changes discarded");
        return;
      }
      invalidateThumbnailCache(props.item.id);
      await props.onReset();
      await props.onReloadLibrary?.();
      setFileRevision((n) => n + 1);
      props.onNotice?.("Restored original file");
      if (props.onOpenEdit) {
        await props.onOpenEdit(props.item);
      }
    } catch (error) {
      props.onNotice?.(`Revert failed: ${error}`);
    }
  };

  // Crop Drag Handling
  useEffect(() => {
    if (!drag || !props.item) return;
    const onMove = (e: PointerEvent) => {
      const dx = (e.clientX - drag.startX) / drag.rect.width;
      const dy = (e.clientY - drag.startY) / drag.rect.height;
      if (drag.type === "move") {
        const nx = Math.min(Math.max(drag.crop.x + dx, 0), 1 - drag.crop.width);
        const ny = Math.min(Math.max(drag.crop.y + dy, 0), 1 - drag.crop.height);
        props.onSetCrop({ x: nx, y: ny });
      } else if (typeof drag.crop.aspectRatio === "number") {
        const ratio = drag.crop.aspectRatio;
        const widthDeltaFromHeight = (dy * ratio) / (drag.rect.width / drag.rect.height);
        const widthDelta =
          Math.abs(dx) >= Math.abs(widthDeltaFromHeight) ? dx : widthDeltaFromHeight;
        const maxWidth = Math.min(
          1 - drag.crop.x,
          ((1 - drag.crop.y) * ratio) / (drag.rect.width / drag.rect.height),
        );
        const width = Math.min(maxWidth, Math.max(0.04, drag.crop.width + widthDelta));
        const height = (width * (drag.rect.width / drag.rect.height)) / ratio;
        props.onSetCrop({ width, height });
      } else {
        const nw = Math.min(Math.max(drag.crop.width + dx, 0.05), 1 - drag.crop.x);
        const nh = Math.min(Math.max(drag.crop.height + dy, 0.05), 1 - drag.crop.y);
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

  const startDrag = (type: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!stageRef.current) return;
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
      props.onSetCrop({
        aspectRatio: ratio,
        ...(ratio === "free" ? {} : { x: 0.04, y: 0.04, width: 0.92, height: 0.92 }),
      });
      return;
    }
    const stageRatio = rect.width / rect.height;
    // Pixel aspect: (w/h)*stageRatio == ratio. Maximize area within 92%.
    let width = 0.92;
    let height = (width * stageRatio) / ratio;
    if (height > 0.92) {
      height = 0.92;
      width = (height * ratio) / stageRatio;
    }
    width = Math.min(1, Math.max(0.05, width));
    height = Math.min(1, Math.max(0.05, height));
    props.onSetCrop({
      aspectRatio: ratio,
      x: (1 - width) / 2,
      y: (1 - height) / 2,
      width,
      height,
    });
  };

  const applyGuideAsCrop = (ratio: number | "free") => {
    const stageRect = stageRef.current?.getBoundingClientRect();
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    let cropBox: Partial<{ x: number; y: number; width: number; height: number }> = {};

    // Match the guide's current visual size/position when cropping from the guide.
    if (
      ratio !== "free" &&
      typeof aspectGuide === "number" &&
      fittedStageSize &&
      viewportRect &&
      stageRect &&
      stageRect.width > 0 &&
      stageRect.height > 0
    ) {
      const guideRatio = ratio;
      const photoRatio = effectiveWidth / effectiveHeight;
      let guideW = fittedStageSize.width;
      let guideH = fittedStageSize.height;
      if (guideRatio > photoRatio) {
        guideH = Math.max(10, Math.round(fittedStageSize.width / guideRatio));
      } else {
        guideW = Math.max(10, Math.round(fittedStageSize.height * guideRatio));
      }
      const guideLeftInViewport = (viewportRect.width - guideW) / 2 + guideOffset.x;
      const guideTopInViewport = (viewportRect.height - guideH) / 2 + guideOffset.y;
      const x = (viewportRect.left + guideLeftInViewport - stageRect.left) / stageRect.width;
      const y = (viewportRect.top + guideTopInViewport - stageRect.top) / stageRect.height;
      const width = guideW / stageRect.width;
      const height = guideH / stageRect.height;
      const cw = Math.min(1, Math.max(0.05, width));
      const ch = Math.min(1, Math.max(0.05, height));
      cropBox = {
        x: Math.min(1 - cw, Math.max(0, x)),
        y: Math.min(1 - ch, Math.max(0, y)),
        width: cw,
        height: ch,
      };
    } else if (ratio !== "free" && stageRect && stageRect.width > 0 && stageRect.height > 0) {
      const stageRatio = stageRect.width / stageRect.height;
      let width = 0.92;
      let height = (width * stageRatio) / ratio;
      if (height > 0.92) {
        height = 0.92;
        width = (height * ratio) / stageRatio;
      }
      width = Math.min(1, Math.max(0.05, width));
      height = Math.min(1, Math.max(0.05, height));
      cropBox = { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
    } else if (ratio !== "free") {
      cropBox = { x: 0.04, y: 0.04, width: 0.92, height: 0.92 };
    }
    props.onSetCrop({ enabled: true, aspectRatio: ratio, ...cropBox });
    setAspectGuide(null);
    setGuideOffset({ x: 0, y: 0 });
    const label =
      ratio === "free"
        ? "Free"
        : (ASPECT_RATIO_OPTIONS.find((opt) => opt.value === ratio)?.label ??
          (ratio < 1 ? `1:${(1 / ratio).toFixed(2)}` : `${ratio.toFixed(2)}:1`));
    props.onNotice?.(`Crop set to ${label}`);
  };

  // Dimensional and Aspect Ratio Computations
  const rotationMod = ((previewValues.rotation % 360) + 360) % 360;
  const isRotatedSideways = rotationMod === 90 || rotationMod === 270;

  const rawWidth = naturalDimensions?.width || props.item?.width || 0;
  const rawHeight = naturalDimensions?.height || props.item?.height || 0;
  const fallbackW = 4;
  const fallbackH = 3;
  const effectiveWidth = isRotatedSideways ? rawHeight || fallbackH : rawWidth || fallbackW;
  const effectiveHeight = isRotatedSideways ? rawWidth || fallbackW : rawHeight || fallbackH;

  // Accurately fit the stage container within the measured viewport
  const fittedStageSize = useMemo(() => {
    if (!viewportSize || viewportSize.width <= 0 || viewportSize.height <= 0) {
      return null;
    }
    // Clean breathing room inside the canvas
    const availW = Math.max(20, viewportSize.width - 24);
    const availH = Math.max(20, viewportSize.height - 24);

    const ratio = effectiveWidth / effectiveHeight;
    const availRatio = availW / availH;

    let stageW: number;
    let stageH: number;

    if (ratio > availRatio) {
      // Photo is wider than viewport ratio -> bound by width
      stageW = availW;
      stageH = Math.max(20, Math.round(availW / ratio));
      if (stageH > availH) {
        stageH = availH;
        stageW = Math.max(20, Math.round(availH * ratio));
      }
    } else {
      // Photo is taller than viewport ratio (e.g. 3008x4016 portrait) -> bound by height
      stageH = availH;
      stageW = Math.max(20, Math.round(availH * ratio));
      if (stageW > availW) {
        stageW = availW;
        stageH = Math.max(20, Math.round(availW / ratio));
      }
    }

    return { width: stageW, height: stageH };
  }, [viewportSize, effectiveWidth, effectiveHeight]);

  // Aspect Ratio Label
  const aspectRatioCategory = useMemo(() => {
    const ratio = effectiveWidth / effectiveHeight;
    if (Math.abs(ratio - 1) < 0.03) return "1:1 Square";
    if (Math.abs(ratio - 16 / 9) < 0.05) return "16:9 Widescreen";
    if (Math.abs(ratio - 9 / 16) < 0.05) return "9:16 Vertical";
    if (Math.abs(ratio - 3 / 2) < 0.04) return "3:2 Landscape";
    if (Math.abs(ratio - 2 / 3) < 0.04) return "2:3 Portrait";
    if (Math.abs(ratio - 4 / 3) < 0.04) return "4:3 Standard";
    if (Math.abs(ratio - 3 / 4) < 0.04) return "3:4 Portrait";
    if (Math.abs(ratio - 4 / 5) < 0.04) return "4:5 Portrait";
    if (Math.abs(ratio - 5 / 4) < 0.04) return "5:4 Landscape";
    return ratio > 1 ? `${ratio.toFixed(2)}:1 Landscape` : `1:${(1 / ratio).toFixed(2)} Portrait`;
  }, [effectiveWidth, effectiveHeight]);

  const megapixelsText = useMemo(() => {
    if (!rawWidth || !rawHeight) return "";
    const mp = (rawWidth * rawHeight) / 1_000_000;
    return mp >= 0.1 ? `${mp.toFixed(1)} MP` : "";
  }, [rawWidth, rawHeight]);

  const fileFormatText = useMemo(() => {
    if (!props.item) return "PHOTO";
    const ext = props.item.extension || props.item.name.split(".").pop() || "";
    return ext.toUpperCase();
  }, [props.item]);

  const cameraLensExif = useMemo(() => {
    if (!props.item) return null;
    const parts = [
      props.item.camera,
      props.item.exposure,
      props.item.iso ? `ISO ${props.item.iso}` : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [props.item]);

  // Cycle Background Tones
  const cycleCanvasTone = () => {
    const tones: Array<"neutral" | "dark" | "black" | "white"> = [
      "neutral",
      "dark",
      "black",
      "white",
    ];
    const nextIdx = (tones.indexOf(canvasTone) + 1) % tones.length;
    setCanvasTone(tones[nextIdx]);
  };

  // Close & Return
  const handleDone = async () => {
    await props.onClose?.();
  };

  /* ===== EMPTY STATE ===== */
  if (!props.item) {
    const draftTiles = savedDraftItems.map((item) => (
      <div key={item.id} className="edit-picker-tile">
        <button
          type="button"
          className="edit-picker-tile-main"
          onClick={() => props.onOpenEdit?.(item)}
        >
          <CachedThumbnail
            itemId={item.id}
            name={item.name}
            size={256}
            placeholderClassName="edit-picker-thumb"
            style={draftImageStyle(draftTransforms, item.id)}
          />
          <div className="picker-tile-caption">
            <span className="picker-tile-name">{item.name}</span>
            <span className="draft-badge">Draft</span>
          </div>
        </button>
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
      </div>
    ));

    return (
      <div className="edit-page edit-page--empty">
        {/* No photo is open yet, so this uses the same plain heading as the
            other screens. The boxed toolbar (back button, "Original safe"
            chip) belongs to an open photo. */}
        <div className="page-heading">
          <div>
            <p className="eyebrow">ADJUST</p>
            <h1>Edit</h1>
            <p className="page-subtitle">
              Adjust light and color, crop and rotate. Your original is kept until you replace it.
            </p>
          </div>
        </div>

        {savedDraftItems.length > 0 ? (
          <section className="edit-saved-drafts-section">
            <div className="section-head">
              <h3>Saved drafts</h3>
              <span className="count-pill">{savedDraftItems.length} photos</span>
            </div>
            <div className="edit-picker-grid">{draftTiles}</div>
          </section>
        ) : (
          <div className="duplicate-empty">
            <span className="duplicate-empty-icon" aria-hidden="true">
              <EditIcon size={26} />
            </span>
            <h2>No photo open</h2>
            <p>Choose a photo in your Library, then click Edit in the viewer or inspector.</p>
            <button type="button" className="primary-button" onClick={() => props.onBack?.()}>
              Go to Library
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ===== VIDEO GUARD ===== */
  if (props.item.kind === "video") {
    return (
      <div className="edit-page">
        <header className="page-heading edit-page-heading is-editing">
          <div className="edit-title-block">
            <button
              className="quiet-button edit-back-btn"
              type="button"
              onClick={() => props.onBack?.()}
              title="Back to Library"
              aria-label="Back to Library"
            >
              <ArrowLeftIcon size={16} />
            </button>
            <div className="edit-title-group">
              <div className="edit-title-row">
                <h1 title={props.item.name}>{props.item.name}</h1>
                <span className="edit-status-chip">Video</span>
              </div>
              <p className="page-subtitle">
                Videos are played in the Video Player. Use a video suite for color grading and cuts.
              </p>
            </div>
          </div>
        </header>
      </div>
    );
  }

  /* ===== MAIN EDITOR VIEW ===== */
  return (
    <div className={`edit-page tone-${canvasTone}`}>
      {/* 1. INFORMATION-RICH HEADER */}
      <header className="page-heading edit-page-heading is-editing">
        <div className="edit-title-block">
          <button
            className="quiet-button edit-back-btn"
            type="button"
            onClick={handleDone}
            title="Back to Library (auto-saves draft)"
            aria-label="Back to Library"
          >
            <ArrowLeftIcon size={16} />
          </button>

          <div className="edit-title-group">
            <div className="edit-title-row">
              <h1 title={props.item.name}>{props.item.name}</h1>
              <span
                className="edit-status-chip is-safe"
                title="Non-destructive editing: your original file stays safe on disk"
              >
                <CheckIcon size={11} /> Original safe
              </span>
              {hasAdjustments && (
                <span
                  className="edit-status-chip is-draft"
                  title="You have in-progress edits in this draft"
                >
                  Draft active
                </span>
              )}
            </div>

            {/* Information-Rich Metadata Strip */}
            <div className="edit-meta-strip" aria-label="Photo metadata">
              {rawWidth && rawHeight ? (
                <span className="edit-meta-pill" title="Pixel dimensions">
                  {formatDimensions({ width: rawWidth, height: rawHeight })}
                </span>
              ) : null}
              {megapixelsText ? (
                <span className="edit-meta-pill" title="Megapixels">
                  {megapixelsText}
                </span>
              ) : null}
              <span className="edit-meta-pill" title="Effective aspect ratio">
                {aspectRatioCategory}
              </span>
              <span className="edit-meta-pill" title="File size">
                {formatBytesSimple(props.item.size)}
              </span>
              <span className="edit-meta-pill is-format" title="File format">
                {fileFormatText}
              </span>
              {cameraLensExif && (
                <span className="edit-meta-pill is-exif" title={cameraLensExif}>
                  <CameraIcon size={12} /> {cameraLensExif}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons: Standard UX Hierarchy */}
        <div className="edit-heading-actions">
          {savedDraftItems.length > 0 && (
            <div className="edit-drafts-menu">
              <button
                ref={draftTriggerRef}
                className="quiet-button edit-drafts-trigger"
                type="button"
                aria-expanded={draftTrayOpen}
                onClick={() => setDraftTrayOpen((open) => !open)}
                title="Open saved drafts"
              >
                <span>Drafts</span>
                <span className="drafts-count-badge">{savedDraftItems.length}</span>
                <ChevronDownIcon size={12} />
              </button>

              {draftTrayOpen &&
                draftPopoverPos &&
                createPortal(
                  <>
                    <div className="edit-drafts-backdrop" onClick={() => setDraftTrayOpen(false)} />
                    <div
                      className="edit-drafts-popover"
                      style={{
                        position: "fixed",
                        top: draftPopoverPos.top,
                        right: draftPopoverPos.right,
                        left: "auto",
                        zIndex: "var(--z-popover)",
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
                        {savedDraftItems.map((item) => (
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
                              <span className="draft-card-name">{item.name}</span>
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
                    </div>
                  </>,
                  document.querySelector(".app-frame") || document.body,
                )}
            </div>
          )}

          <button
            className="primary-button edit-done-btn"
            type="button"
            onClick={handleDone}
            title="Done editing (saves draft and returns to Library)"
          >
            <CheckIcon size={14} />
            <span>Done</span>
          </button>
        </div>
      </header>

      {/* 2. MAIN WORKSPACE LAYOUT */}
      <div className="editor-layout">
        {/* PREVIEW CANVAS */}
        <main className={`edit-canvas tone-${canvasTone}`}>
          {/* Main Stage Viewport */}
          <div ref={viewportRef} className="canvas-viewport">
            {/* Aspect Ratio Framing Guide (when active in non-crop mode) */}
            {aspectGuide &&
              !crop.enabled &&
              typeof aspectGuide === "number" &&
              (() => {
                const guideRatio = aspectGuide;
                const photoRatio = effectiveWidth / effectiveHeight;
                let guideW = fittedStageSize?.width ?? 0;
                let guideH = fittedStageSize?.height ?? 0;
                if (fittedStageSize) {
                  if (guideRatio > photoRatio) {
                    guideH = Math.max(10, Math.round(fittedStageSize.width / guideRatio));
                  } else {
                    guideW = Math.max(10, Math.round(fittedStageSize.height * guideRatio));
                  }
                }
                const vpW = viewportSize?.width ?? 0;
                const vpH = viewportSize?.height ?? 0;
                const maxX = guideW && vpW ? Math.max(0, (vpW - guideW) / 2) : 0;
                const maxY = guideH && vpH ? Math.max(0, (vpH - guideH) / 2) : 0;
                const onGuidePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
                  if ((e.target as HTMLElement).closest("button")) return;
                  e.preventDefault();
                  e.stopPropagation();
                  guideDragRef.current = {
                    startX: e.clientX,
                    startY: e.clientY,
                    originX: guideOffset.x,
                    originY: guideOffset.y,
                    maxX,
                    maxY,
                  };
                  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                  const onMove = (ev: PointerEvent) => {
                    const d = guideDragRef.current;
                    if (!d) return;
                    setGuideOffset({
                      x: Math.max(-d.maxX, Math.min(d.maxX, d.originX + (ev.clientX - d.startX))),
                      y: Math.max(-d.maxY, Math.min(d.maxY, d.originY + (ev.clientY - d.startY))),
                    });
                  };
                  const onUp = () => {
                    guideDragRef.current = null;
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    window.removeEventListener("pointercancel", onUp);
                  };
                  window.addEventListener("pointermove", onMove);
                  window.addEventListener("pointerup", onUp);
                  window.addEventListener("pointercancel", onUp);
                };
                return (
                  <div
                    className="aspect-guide-frame"
                    onPointerDown={onGuidePointerDown}
                    style={{
                      ...(fittedStageSize
                        ? {
                            width: `${guideW}px`,
                            height: `${guideH}px`,
                            left: "50%",
                            top: "50%",
                            transform: `translate(calc(-50% + ${guideOffset.x}px), calc(-50% + ${guideOffset.y}px))`,
                          }
                        : {
                            aspectRatio: `${aspectGuide}`,
                            maxWidth: "100%",
                            maxHeight: "100%",
                          }),
                      pointerEvents: "auto",
                      cursor: fittedStageSize ? "grab" : "default",
                      touchAction: "none",
                    }}
                  >
                    <div className="aspect-guide-badge">
                      <span>
                        Preview: {ASPECT_RATIO_OPTIONS.find((r) => r.value === aspectGuide)?.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => applyGuideAsCrop(aspectGuide)}
                        className="apply-crop-btn"
                      >
                        Crop to this
                      </button>
                      <button
                        type="button"
                        onClick={() => setAspectGuide(null)}
                        className="close-guide-btn"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })()}

            {/* Stage Container */}
            <div
              ref={stageRef}
              className={`crop-stage${showOriginalPreview ? " is-original" : ""}${showGrid ? " show-grid" : ""}`}
            >
              {/* Photo Image */}
              <img
                ref={(el) => {
                  imgRef.current = el;
                }}
                key={`${props.item.id}-${props.item.size}-${props.item.modifiedAt}-${fileRevision}`}
                src={
                  props.assetUrl(props.item.path) +
                  `?v=${props.item.modifiedAt}-${props.item.size}-${fileRevision}`
                }
                alt={props.item.name}
                onLoad={(e) => updateNaturalDimensions(e.currentTarget)}
                style={{
                  maxWidth: isRotatedSideways
                    ? "min(calc(100cqh - 32px), calc(100vh - 180px))"
                    : "min(calc(100cqw - 32px), calc(100vw - 380px))",
                  maxHeight: isRotatedSideways
                    ? "min(calc(100cqw - 32px), calc(100vw - 380px))"
                    : "min(calc(100cqh - 32px), calc(100vh - 180px))",
                  width: "auto",
                  height: "auto",
                  objectFit: "contain",
                  display: "block",
                  transform: `rotate(${rotationMod}deg) scaleX(${previewValues.flip ? -1 : 1})`,
                  filter: previewFilter,
                }}
              />

              {/* Composition 3x3 Grid Overlay */}
              {showGrid && (
                <div className="composition-grid-overlay" aria-hidden="true">
                  <div className="grid-line grid-v-1" />
                  <div className="grid-line grid-v-2" />
                  <div className="grid-line grid-h-1" />
                  <div className="grid-line grid-h-2" />
                </div>
              )}

              {/* Interactive Crop Overlay */}
              {crop.enabled && !showOriginalPreview && (
                <div
                  className="crop-overlay"
                  style={{
                    position: "absolute",
                    left: `${crop.x * 100}%`,
                    top: `${crop.y * 100}%`,
                    width: `${crop.width * 100}%`,
                    height: `${crop.height * 100}%`,
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

              {/* Compare Mode Indicator */}
              {showOriginalPreview && (
                <div className="compare-floating-pill">
                  <EyeCompareIcon size={13} />
                  <span>Showing Original</span>
                </div>
              )}
            </div>
          </div>

          {/* Canvas Floating Action Toolbar */}
          <div className="canvas-actions" role="toolbar" aria-label="Preview tools">
            {/* History: Undo / Redo */}
            <div className="edit-history-controls" aria-label="Edit history">
              <button
                type="button"
                onClick={() => {
                  setShowOriginalPreview(false);
                  props.onUndo();
                }}
                disabled={!props.canUndo}
                aria-label="Undo edit"
                title="Undo (⌘Z)"
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
                aria-label="Redo edit"
                title="Redo (⇧⌘Z)"
              >
                ↷
              </button>
            </div>

            <span className="canvas-divider" aria-hidden="true" />

            {/* Transform Controls */}
            <button
              type="button"
              onClick={() => {
                setShowOriginalPreview(false);
                props.onRotate(90);
              }}
              title="Rotate 90° clockwise"
            >
              <RotateIcon size={14} />
              <span>Rotate</span>
            </button>
            <button
              type="button"
              className={values.flip ? "active" : ""}
              aria-pressed={!!values.flip}
              onClick={() => {
                setShowOriginalPreview(false);
                props.onFlip();
              }}
              title="Flip horizontally"
            >
              <FlipIcon size={14} />
              <span>Flip</span>
            </button>
            <button
              type="button"
              className={props.crop.enabled ? "active" : ""}
              aria-pressed={!!props.crop.enabled}
              onClick={() => {
                setShowOriginalPreview(false);
                props.crop.enabled ? props.onResetCrop?.() : props.onSetCrop({ enabled: true });
              }}
              title="Crop and straighten tool"
            >
              <CropIcon size={14} />
              <span>{props.crop.enabled ? "Reset crop" : "Crop"}</span>
            </button>

            <span className="canvas-divider" aria-hidden="true" />

            {/* Aspect Ratio Framing Preview Menu */}
            <div className="aspect-menu-container">
              <button
                type="button"
                className={aspectGuide ? "active" : ""}
                aria-pressed={!!aspectGuide}
                onClick={() => setAspectMenuOpen((o) => !o)}
                title="Preview framing in standard aspect ratios"
              >
                <AspectGuideIcon size={14} />
                <span>
                  {aspectGuide
                    ? ASPECT_RATIO_OPTIONS.find((r) => r.value === aspectGuide)?.label
                    : "Aspect"}
                </span>
              </button>

              {aspectMenuOpen && (
                <>
                  <div className="menu-dismiss-scrim" onClick={() => setAspectMenuOpen(false)} />
                  <div className="aspect-ratio-menu-popover" role="menu">
                    <div className="menu-header">Aspect Ratio Guide</div>
                    {ASPECT_RATIO_OPTIONS.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        role="menuitem"
                        className={aspectGuide === opt.value ? "active" : ""}
                        onClick={() => {
                          setAspectGuide(opt.value === aspectGuide ? null : opt.value);
                          setAspectMenuOpen(false);
                        }}
                      >
                        <b>{opt.label}</b>
                        <small>{opt.ratioName}</small>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Grid Overlay Toggle */}
            <button
              type="button"
              className={showGrid ? "active" : ""}
              aria-pressed={showGrid}
              onClick={() => setShowGrid((g) => !g)}
              title="Toggle Rule of Thirds composition grid"
            >
              <GridIcon size={14} />
              <span>Grid</span>
            </button>

            {/* Canvas Tone Cycler */}
            <button
              type="button"
              onClick={cycleCanvasTone}
              title={`Background tone: ${canvasTone}. Click to switch between neutral, dark, black, and white.`}
            >
              <PaletteToneIcon size={14} />
              <span>Tone</span>
            </button>

            <span className="canvas-divider" aria-hidden="true" />

            {/* Before / After Compare Button */}
            <button
              type="button"
              className={`compare-btn ${showOriginalPreview ? "active" : ""}`}
              aria-pressed={showOriginalPreview}
              title="Compare with original (unfiltered)"
              onClick={() => setShowOriginalPreview((v) => !v)}
            >
              <EyeCompareIcon size={14} />
              <span>{showOriginalPreview ? "Show edited" : "Compare"}</span>
            </button>
          </div>
        </main>

        {/* 3. TACTILE CONTROL PANEL */}
        <EditControls
          item={props.item}
          values={values}
          crop={crop}
          hasAdjustments={hasAdjustments}
          setCropRatio={setCropRatio}
          onAdjust={() => setShowOriginalPreview(false)}
          onConfirmReplace={() => setConfirmReplace(true)}
          onConfirmRevert={() => setConfirmRevert(true)}
          actions={props}
        />
      </div>

      {/* CONFIRM REPLACE MODAL */}
      {confirmReplace && (
        <div
          className="edit-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmReplace(false);
          }}
        >
          <div
            ref={confirmReplaceDialogRef}
            className="edit-modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-confirm-replace-title"
          >
            <h3 id="edit-confirm-replace-title" className="edit-modal-title">
              Replace original file?
            </h3>
            <p className="edit-modal-body">
              This bakes your current edits into <b>{props.item.name}</b> on disk. A backup is kept
              so you can undo this anytime using <b>Restore original</b>.
            </p>
            <div className="edit-modal-actions">
              <button
                className="quiet-button"
                type="button"
                onClick={() => setConfirmReplace(false)}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  setConfirmReplace(false);
                  props.onExport(true);
                }}
              >
                Replace original
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CONFIRM REVERT MODAL */}
      {confirmRevert && (
        <div
          className="edit-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmRevert(false);
          }}
        >
          <div
            ref={confirmRevertDialogRef}
            className="edit-modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-confirm-revert-title"
          >
            <h3 id="edit-confirm-revert-title" className="edit-modal-title">
              Restore original file?
            </h3>
            <p className="edit-modal-body">
              If <b>{props.item.name}</b> was previously replaced in-place, this restores the
              unedited backup file. If there is no backup, it resets your draft adjustments.
            </p>
            <div className="edit-modal-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setConfirmRevert(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={async () => {
                  setConfirmRevert(false);
                  await handleRevert();
                }}
              >
                Restore
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default EditScreen;
