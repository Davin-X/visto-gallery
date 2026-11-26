import React, { useCallback, useEffect, useMemo, useState } from "react";
import { tauri } from "../../engine/commands/tauri";
import { draftTransformStyle, type DraftTransform } from "../../engine/stores/useEditStore";
import type { MediaItem } from "../../engine/types/media";
import type { Point } from "../../engine/utils/zoom";
import { CachedThumbnail, getCachedThumbnailUrl } from "../../design/components/CachedThumbnail";

/**
 * Build image sizing and transform styles for a single viewer still (`A` or `B`)
 * using its own intrinsic dimensions and draft edits while sharing `zoom` and `pan`.
 */
export function buildViewerImageStyle({
  item,
  fitMode,
  zoom,
  pan,
  rotation,
  flipX,
  draftTransform,
  naturalSize,
}: {
  item: MediaItem;
  fitMode: "fit" | "actual" | "fill";
  zoom: number;
  pan: Point;
  rotation: number;
  flipX: boolean;
  draftTransform?: DraftTransform;
  naturalSize?: { width?: number; height?: number } | null;
}): React.CSSProperties {
  const imageRotation = (rotation + (draftTransform?.rotation || 0)) % 360;
  const dpr = window.devicePixelRatio || 1;
  const actualW = item.width ?? naturalSize?.width;
  const actualH = item.height ?? naturalSize?.height;
  return {
    aspectRatio: item.width && item.height ? `auto ${item.width} / ${item.height}` : undefined,
    width: fitMode === "actual" ? (actualW ? actualW / dpr : undefined) : "100%",
    height: fitMode === "actual" ? (actualH ? actualH / dpr : undefined) : "100%",
    maxWidth: fitMode === "actual" ? "none" : imageRotation % 180 ? "min(100%, 100cqh)" : "100%",
    maxHeight: fitMode === "actual" ? "none" : imageRotation % 180 ? "min(100%, 100cqw)" : "100%",
    objectFit: fitMode === "fill" ? "cover" : "contain",
    transform: [
      `translate3d(${pan.x}px, ${pan.y}px, 0)`,
      `rotate(${rotation || 0}deg)`,
      `scaleX(${flipX ? -1 : 1})`,
      item.kind === "photo" ? draftTransformStyle(draftTransform) : "",
      `scale(${zoom / 100})`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * Manages A/B comparison state (pinned anchor, 2-up split vs. A/B flip) for
 * the viewer stage.
 */
export function useViewerCompare(
  items: MediaItem[],
  selected: MediaItem | null,
  selectedIndex: number,
  onNavigate: (delta: number) => void,
) {
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [mode, setMode] = useState<"split" | "flip">("split");
  const [flipShowA, setFlipShowA] = useState(false);

  const anchor = useMemo(
    () => (anchorId ? (items.find((item) => item.id === anchorId) ?? null) : null),
    [anchorId, items],
  );
  const active = Boolean(anchor && selected && anchor.id !== selected.id);

  const toggleCompare = useCallback(() => {
    if (anchorId) {
      setAnchorId(null);
      return;
    }
    if (!selected || (selected.kind !== "photo" && selected.kind !== "raw")) return;
    setAnchorId(selected.id);
    setMode("split");
    setFlipShowA(false);
    const hasNext =
      selectedIndex >= 0 &&
      (items[selectedIndex + 1]?.kind === "photo" || items[selectedIndex + 1]?.kind === "raw");
    const hasPrev =
      selectedIndex > 0 &&
      (items[selectedIndex - 1]?.kind === "photo" || items[selectedIndex - 1]?.kind === "raw");
    if (hasNext) onNavigate(1);
    else if (hasPrev) onNavigate(-1);
  }, [anchorId, selected, selectedIndex, items, onNavigate]);

  const flipCompare = useCallback(() => {
    if (!anchorId) return;
    if (mode === "split") {
      setMode("flip");
      setFlipShowA(true);
    } else {
      setFlipShowA((value) => !value);
    }
  }, [anchorId, mode]);

  const toggleMode = useCallback(() => {
    setMode((value) => (value === "split" ? "flip" : "split"));
  }, []);

  return { anchorId, anchor, active, mode, flipShowA, toggleCompare, flipCompare, toggleMode };
}

export function CompareToolbarButtons({
  anchorId,
  active,
  mode,
  flipShowA,
  onToggleCompare,
  onToggleMode,
  onFlip,
}: {
  anchorId: string | null;
  active: boolean;
  mode: "split" | "flip";
  flipShowA: boolean;
  onFlip: () => void;
  onToggleCompare: () => void;
  onToggleMode: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`viewer-fit-button${anchorId ? " active" : ""}`}
        onClick={onToggleCompare}
        aria-label="Compare shots (C)"
        aria-pressed={Boolean(anchorId)}
        title="Compare shots (C)"
      >
        Compare
      </button>
      {active && (
        <button
          type="button"
          className="viewer-fit-button"
          onClick={onToggleMode}
          aria-label={mode === "split" ? "Flip A/B (\\)" : "Split side-by-side"}
          title={mode === "split" ? "Enter A/B flip mode" : "Split side-by-side"}
        >
          {mode === "split" ? "Flip" : "Split"}
        </button>
      )}
      {active && mode === "flip" && (
        <button
          type="button"
          className="viewer-fit-button"
          onClick={onFlip}
          title="Switch A/B (\\)"
        >
          {flipShowA ? "Show B" : "Show A"}
        </button>
      )}
    </>
  );
}

/**
 * Renders the pinned comparison item (`A`) alongside the active viewer item (`B`)
 * with synchronized zoom, pan, and fit styling.
 */
export function CompareStageView({
  anchor,
  selectedName,
  mode,
  flipShowA,
  wantsFull,
  fitMode,
  zoom,
  pan,
  rotation,
  flipX,
  anchorDraft,
  panning,
  assetUrl,
  activeNode,
}: {
  anchor: MediaItem;
  selectedName: string;
  mode: "split" | "flip";
  flipShowA: boolean;
  wantsFull: boolean;
  fitMode: "fit" | "actual" | "fill";
  zoom: number;
  pan: Point;
  rotation: number;
  flipX: boolean;
  anchorDraft?: DraftTransform;
  panning: boolean;
  assetUrl: (path: string) => string;
  activeNode: React.ReactNode;
}) {
  const anchorNode = (
    <CompareAnchorImage
      item={anchor}
      wantsFull={wantsFull}
      fitMode={fitMode}
      zoom={zoom}
      pan={pan}
      rotation={rotation}
      flipX={flipX}
      anchorDraft={anchorDraft}
      panning={panning}
      assetUrl={assetUrl}
    />
  );
  if (mode === "flip") {
    return (
      <>
        <span className="viewer-compare-badge">
          {flipShowA ? `A · ${anchor.name}` : `B · ${selectedName}`}
        </span>
        {flipShowA ? anchorNode : activeNode}
      </>
    );
  }
  return (
    <div className="viewer-compare-stage">
      <div className="viewer-compare-pane">
        <span className="viewer-compare-badge">A · {anchor.name}</span>
        {anchorNode}
      </div>
      <div className="viewer-compare-pane">
        <span className="viewer-compare-badge">B · {selectedName}</span>
        {activeNode}
      </div>
    </div>
  );
}

function CompareAnchorImage({
  item,
  wantsFull,
  fitMode,
  zoom,
  pan,
  rotation,
  flipX,
  anchorDraft,
  panning,
  assetUrl,
}: {
  item: MediaItem;
  wantsFull: boolean;
  fitMode: "fit" | "actual" | "fill";
  zoom: number;
  pan: Point;
  rotation: number;
  flipX: boolean;
  anchorDraft?: DraftTransform;
  panning: boolean;
  assetUrl: (path: string) => string;
}) {
  const [preview, setPreview] = useState<{ id: string; src: string; full: boolean } | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; width?: number; height?: number } | null>(
    null,
  );
  const [fallbackId, setFallbackId] = useState<string | null>(null);
  const viaPreview = item.kind === "raw" || fallbackId === item.id;

  useEffect(() => {
    if (!viaPreview) return;
    const current = preview?.id === item.id ? preview : null;
    if (current && (!wantsFull || current.full)) return;
    let cancelled = false;
    tauri.library
      .getDisplayPreview(item.id, wantsFull)
      .then((result) => {
        if (cancelled) return;
        const src = result.path ? assetUrl(result.path) : result.dataUrl;
        if (src) setPreview({ id: item.id, src, full: result.full });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [item.id, viaPreview, wantsFull, preview, assetUrl]);

  const src = viaPreview
    ? preview?.id === item.id
      ? preview.src
      : null
    : `${assetUrl(item.path)}?v=${item.id}-${item.modifiedAt}-${item.size}`;
  const loadKey = `${item.id}:${src ?? ""}`;
  const isLoaded = loaded?.key === loadKey;
  const backdrop = !viaPreview && !isLoaded ? getCachedThumbnailUrl(item.id) : null;
  const stillStyle = buildViewerImageStyle({
    item,
    fitMode,
    zoom,
    pan,
    rotation,
    flipX,
    draftTransform: anchorDraft,
    naturalSize: isLoaded ? loaded : null,
  });

  return (
    <>
      {backdrop && (
        <img
          className="photo-viewer-image photo-viewer-backdrop is-loaded"
          src={backdrop}
          alt=""
          aria-hidden="true"
          style={stillStyle}
        />
      )}
      {src ? (
        <img
          key={`${item.id}-${viaPreview ? "preview" : "original"}`}
          className={`photo-viewer-image${isLoaded ? " is-loaded" : ""}${panning ? " is-panning" : ""}`}
          src={src}
          alt={item.name}
          decoding="async"
          onLoad={(e) =>
            setLoaded({
              key: loadKey,
              width: e.currentTarget.naturalWidth || undefined,
              height: e.currentTarget.naturalHeight || undefined,
            })
          }
          onError={() => {
            if (!viaPreview) setFallbackId(item.id);
          }}
          style={stillStyle}
        />
      ) : (
        <CachedThumbnail
          itemId={item.id}
          name={item.name}
          size={1024}
          eager
          style={{ ...stillStyle, aspectRatio: undefined, objectFit: "contain" }}
        />
      )}
    </>
  );
}
