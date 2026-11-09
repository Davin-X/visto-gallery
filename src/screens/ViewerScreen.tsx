import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EditIcon,
  EyeOffIcon,
  FlipIcon,
  FullscreenIcon,
  HeartIcon,
  MinusIcon,
  PlusIcon,
  RotateIcon,
  SlideshowIcon,
  ViewerIcon,
} from "../design/components/icons";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { KindDot } from "../design/components/KindBadge";
import { useDraftTransforms, draftTransformStyle } from "../engine/stores/useEditStore";
import { useSlideshowStore } from "../engine/stores/useSlideshowStore";
import { tauri, thumbnailToDataUrl } from "../engine/commands/tauri";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import { formatDuration } from "../engine/utils/time";
import { draftImageStyle } from "../engine/utils/draftImage";
import type { MediaItem, EditValues } from "../engine/types/media";

interface ViewerScreenProps {
  active: boolean;
  items: MediaItem[];
  selected: MediaItem | null;
  zoom: number;
  fitMode: "fit" | "actual" | "fill";
  rotation: number;
  flipX: boolean;
  onNavigate: (delta: number) => void;
  onSetPhoto: (id: string) => void;
  onSetZoom: (zoom: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onToggleFitMode: () => void;
  onRotate: (deg: number) => void;
  onToggleFlip: () => void;
  onResetTransform: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  onToggleFavorite: (id: string) => void | Promise<void>;
  onToggleHidden: (id: string) => void | Promise<void>;
  onOpenEdit: (item: MediaItem) => void;
  onContextMenu: (items: MediaItem[], e: React.MouseEvent) => void;
  assetUrl: (path: string) => string;
}

function ViewerScreen(props: ViewerScreenProps) {
  const items = useMemo(() => props.items.filter((item) => item.kind !== "video"), [props.items]);
  const photoItems = useMemo(() => items.filter((item) => item.kind === "photo"), [items]);
  // Was the inspected item a video? The Viewer only shows photos — give the
  // user a real answer instead of the generic empty state.
  const inspectedVideo = props.selected?.kind === "video";
  const selected = props.selected?.kind === "video" ? null : props.selected;
  const draftTransforms = useDraftTransforms();
  // Folder context: the pill shows the containing folder, the subtle line the
  // full path. Deriving both from the media path keeps it honest (no fake
  // "LOCAL FILE" label).
  const folderPath = selected?.path
    ? String(selected.path).replace(/\\/g, "/").split("/").slice(0, -1).join("/")
    : "";
  const folderName = folderPath.split("/").filter(Boolean).pop() || "Local Files";
  const [hintsVisible, setHintsVisible] = useState(true);
  const [photoLoadState, setPhotoLoadState] = useState<{
    id: string;
    status: "loading" | "loaded" | "failed";
  } | null>(null);
  const [stripStart, setStripStart] = useState(() =>
    Math.max(0, items.findIndex((item) => item.id === selected?.id) - 18),
  );
  const hideTimerRef = useRef<number | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollRef = useRef(false);
  const stripWindowSize = 50;
  const selectedIndex = items.findIndex((item) => item.id === selected?.id);
  const stripEnd = Math.min(items.length, stripStart + stripWindowSize);
  const photoStatus =
    photoLoadState && photoLoadState.id === selected?.id ? photoLoadState.status : "loading";
  const imageRotation =
    (props.rotation + (draftTransforms.get(selected?.id ?? "")?.rotation || 0)) % 360;
  const startSlideshow = useCallback(() => {
    useSlideshowStore.getState().open(photoItems, selected?.id);
  }, [photoItems, selected?.id]);

  // Shortcut hints are shown on open and whenever the pointer moves over the
  // stage, then fade away after a short pause so the frame stays clean.
  const flashHints = useCallback(() => {
    setHintsVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500);
  }, []);

  useEffect(() => {
    flashHints();
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [props.selected?.id, flashHints]);

  // Keep the active thumbnail in view as you navigate a long filmstrip.
  // Keep the active thumbnail in view as you navigate a long filmstrip.
  useEffect(() => {
    if (selectedIndex < 0) return;
    let nextStart = stripStart;
    if (selectedIndex < stripStart) {
      nextStart = selectedIndex;
    } else if (selectedIndex >= stripStart + stripWindowSize) {
      nextStart = Math.max(
        0,
        Math.min(selectedIndex - stripWindowSize + 1, items.length - stripWindowSize),
      );
    }
    if (nextStart !== stripStart) {
      const delta = (nextStart - stripStart) * 60;
      programmaticScrollRef.current = true;
      if (stripRef.current)
        stripRef.current.scrollLeft = Math.max(0, stripRef.current.scrollLeft + delta);
      window.setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 0);
      setStripStart(nextStart);
    }
  }, [selectedIndex, stripStart, items.length]);

  // On open, align scroll position with the initial window (no smooth animation).
  useEffect(() => {
    if (stripRef.current) {
      programmaticScrollRef.current = true;
      stripRef.current.scrollLeft = stripStart * 60;
      window.setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilmstripScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const strip = stripRef.current;
    if (!strip || items.length <= stripWindowSize) return;
    const nextStart = Math.max(
      0,
      Math.min(
        Math.floor(Math.max(0, strip.scrollLeft - 68) / 60) - 10,
        items.length - stripWindowSize,
      ),
    );
    setStripStart((current) => (Math.abs(nextStart - current) > 5 ? nextStart : current));
  }, [items.length]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selected) return;
      if (!props.active) return;
      // Ignore if typing in an input, or if the slideshow overlay is driving.
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (useSlideshowStore.getState().isOpen) return;

      switch (e.key) {
        case "ArrowUp":
          if (selected.kind === "photo") {
            e.preventDefault();
            props.onSetZoom(Math.min(300, props.zoom + 25));
          }
          break;
        case "ArrowDown":
          if (selected.kind === "photo") {
            e.preventDefault();
            props.onSetZoom(Math.max(25, props.zoom - 25));
          }
          break;
        case "r":
        case "R":
          if (selected.kind === "photo") {
            e.preventDefault();
            props.onRotate(90);
          }
          break;
        case "x":
        case "X":
          if (selected.kind === "photo") {
            e.preventDefault();
            props.onToggleFlip();
          }
          break;
        case "0":
          e.preventDefault();
          props.onSetZoom(100);
          break;
        case "1":
          e.preventDefault();
          props.onSetZoom(200);
          break;
        case "f":
        case "F":
          e.preventDefault();
          props.onToggleFavorite(selected.id);
          break;
        case " ":
          return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selected, props]);

  if (!selected)
    return (
      <div className="viewer-empty-state">
        <div className="first-run-art">
          <ViewerIcon size={30} />
        </div>
        {inspectedVideo ? (
          <>
            <h2>Videos don’t open in the Viewer</h2>
            <p>
              The item you’re inspecting is a video. Press the play button on its tile (or the Now
              Playing chip) to watch it.
            </p>
          </>
        ) : (
          <>
            <h2>No viewable media yet</h2>
            <p>
              This view has no photos. Import photos or RAW files, or open a video from its tile.
            </p>
          </>
        )}
      </div>
    );

  return (
    <div className="viewer-screen">
      <div className="page-heading viewer-heading">
        <div className="viewer-title-block">
          <h1 title={selected.name}>{selected.name}</h1>
          <div className="viewer-meta">
            <div className="meta-row">
              <span className="meta-chip">
                <svg
                  className="meta-icon"
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <path d="M8 2v4M8 10v4M2 8h4M10 8h4" />
                </svg>
                {new Date(selected.capturedAt ?? selected.modifiedAt).toLocaleDateString()}
              </span>
              <span className="meta-chip">
                <svg
                  className="meta-icon"
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path d="M4 4h8v8H4z" />
                  <path d="M4 8h8" />
                </svg>
                {selected.extension.toUpperCase()}
              </span>
              <span className="meta-chip">
                <svg
                  className="meta-icon"
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <circle cx="8" cy="8" r="6" />
                  <path d="M8 4v4l3 3" />
                </svg>
                {formatBytesSimple(selected.size)}
              </span>
              {selected.kind === "photo" && selected.width && selected.height && (
                <span className="meta-chip">
                  <svg
                    className="meta-icon"
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <rect x="2" y="2" width="12" height="12" rx="2" />
                    <path d="M6 2v12M10 2v12M2 6h12M2 10h12" />
                  </svg>
                  {selected.width} × {selected.height}
                </span>
              )}
              {selected.kind === "video" && selected.duration && (
                <span className="meta-chip">
                  <svg
                    className="meta-icon"
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <circle cx="8" cy="8" r="7" />
                    <path d="M8 4v4l3 3" />
                  </svg>
                  {formatDuration(selected.duration)}
                </span>
              )}
              {selected.camera && (
                <span className="meta-chip" title={`Camera: ${selected.camera}`}>
                  {selected.camera}
                </span>
              )}
              {selected.lens && (
                <span className="meta-chip" title={`Lens: ${selected.lens}`}>
                  {selected.lens}
                </span>
              )}
            </div>
            {folderPath && (
              <span className="meta-chip path-chip" title={selected.path}>
                <svg
                  className="meta-icon"
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path d="M4 4h8v8H4z" />
                  <path d="M4 8h8" />
                </svg>
                {folderPath}
              </span>
            )}
          </div>
        </div>
      </div>
      <div
        className="viewer-stage"
        aria-busy={selected.kind === "photo" && photoStatus === "loading"}
        onMouseMove={() => flashHints()}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          if (selected.kind !== "photo") return;
          props.onSetZoom(props.zoom === 100 ? 200 : 100);
        }}
      >
        <button
          className={`viewer-arrow left${hintsVisible ? "" : " hidden"}`}
          type="button"
          onMouseEnter={() => {
            setHintsVisible(true);
            if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
          }}
          onMouseLeave={() => {
            hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500);
          }}
          onClick={() => props.onNavigate(-1)}
          aria-label="Previous"
        >
          <ChevronLeftIcon size={21} strokeWidth={2.1} />
        </button>
        {selected.kind === "photo" ? (
          <>
            <img
              key={`${selected.id}-${selected.size}-${selected.modifiedAt}`}
              className={`photo-viewer-image${photoStatus === "loaded" ? " is-loaded" : ""}`}
              src={props.assetUrl(selected.path) + `?v=${selected.modifiedAt}-${selected.size}`}
              alt={selected.name}
              decoding="async"
              onLoad={() => setPhotoLoadState({ id: selected.id, status: "loaded" })}
              onError={(e) => {
                const target = e.currentTarget;
                if (target.dataset.fallback === "1") {
                  setPhotoLoadState({ id: selected.id, status: "failed" });
                  target.alt = "Preview unavailable";
                  target.src =
                    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
                  return;
                }
                target.dataset.fallback = "1";
                setPhotoLoadState({ id: selected.id, status: "loading" });
                void tauri.library
                  .getThumbnail({ itemId: selected.id, size: 1024 })
                  .then((response) => {
                    if (target.isConnected && response?.dataUrl) {
                      target.src = response.dataUrl;
                    } else if (target.isConnected) {
                      setPhotoLoadState({ id: selected.id, status: "failed" });
                    }
                  })
                  .catch(() => {
                    if (target.isConnected) {
                      setPhotoLoadState({ id: selected.id, status: "failed" });
                      target.alt = "Preview unavailable";
                      target.src =
                        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
                    }
                  });
              }}
              style={{
                aspectRatio:
                  selected.width && selected.height
                    ? `auto ${selected.width} / ${selected.height}`
                    : "auto",
                width: props.fitMode === "fill" ? "100%" : undefined,
                height: props.fitMode === "fill" ? "100%" : undefined,
                maxWidth:
                  props.fitMode === "actual"
                    ? "none"
                    : imageRotation % 180
                      ? "min(100%, 100cqh)"
                      : "100%",
                maxHeight:
                  props.fitMode === "actual"
                    ? "none"
                    : imageRotation % 180
                      ? "min(100%, 100cqw)"
                      : "100%",
                objectFit: props.fitMode === "fill" ? "cover" : "contain",
                transform: [
                  `rotate(${props.rotation || 0}deg)`,
                  `scaleX(${props.flipX ? -1 : 1})`,
                  draftTransformStyle(draftTransforms.get(selected.id)),
                  `scale(${props.zoom / 100})`,
                ]
                  .filter(Boolean)
                  .join(" "),
              }}
            />
            {photoStatus !== "loaded" && (
              <div
                className={`photo-preview-state${photoStatus === "failed" ? " is-failed" : ""}`}
                role={photoStatus === "failed" ? "alert" : "status"}
              >
                <span className="photo-preview-indicator" aria-hidden="true" />
                <span>
                  {photoStatus === "failed"
                    ? "Could not load this photo preview"
                    : "Loading full-resolution photo…"}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="raw-viewer">
            <b>{selected.extension.toUpperCase()}</b>
            <span>RAW preview requires native backend</span>
          </div>
        )}
        <button
          className={`viewer-arrow right${hintsVisible ? "" : " hidden"}`}
          type="button"
          onMouseEnter={() => {
            setHintsVisible(true);
            if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
          }}
          onMouseLeave={() => {
            hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500);
          }}
          onClick={() => props.onNavigate(1)}
          aria-label="Next"
        >
          <ChevronRightIcon size={21} strokeWidth={2.1} />
        </button>
        <div
          className={`viewer-overlay-top${hintsVisible ? "" : " hidden"}`}
          onMouseEnter={() => {
            setHintsVisible(true);
            if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
          }}
          onMouseLeave={() => {
            hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500);
          }}
        >
          <span className="viewer-transform-state">
            {props.rotation ? `${props.rotation}°` : ""}
            {props.rotation && props.flipX ? " · " : ""}
            {props.flipX ? "Flipped" : ""}
            {selectedIndex + 1} / {items.length}
          </span>
        </div>
        {/* Compact shortcut hints live in the stage corner so the frame keeps
            all of its room for the media and the control bar. */}
        <div className={`viewer-hints${hintsVisible ? "" : " hidden"}`} aria-hidden="true">
          <span>
            <kbd>←</kbd>
            <kbd>→</kbd> Navigate
          </span>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Zoom
          </span>
          {selected.kind === "photo" && (
            <span>
              <kbd>R</kbd>
              <kbd>X</kbd> Rotate/Flip
            </span>
          )}
          <span>
            <kbd>0</kbd> Reset zoom
          </span>
          <span>
            <kbd>F</kbd> Favorite
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>
        {selected.kind !== "video" && (
          <div
            className={`viewer-overlay-bottom${hintsVisible ? "" : " hidden"}`}
            onMouseEnter={() => {
              setHintsVisible(true);
              if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
            }}
            onMouseLeave={() => {
              hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500);
            }}
          >
            {selected.kind === "photo" && (
              <>
                <button
                  type="button"
                  onClick={props.onResetZoom}
                  aria-label="Reset zoom"
                  title="Reset zoom"
                >
                  {props.zoom}%
                </button>
                <button
                  type="button"
                  className="viewer-fit-button"
                  onClick={props.onToggleFitMode}
                  aria-label={`Image scaling: ${props.fitMode}. Click to change`}
                  aria-pressed={props.fitMode !== "fit"}
                  title={
                    props.fitMode === "fill"
                      ? "Fill the frame by cropping edges; image proportions stay unchanged"
                      : `Image scaling: ${props.fitMode}. Image proportions stay unchanged`
                  }
                >
                  {props.fitMode === "actual"
                    ? "Actual"
                    : props.fitMode === "fill"
                      ? "Fill"
                      : "Fit"}
                </button>
                <button
                  type="button"
                  onClick={() => props.onSetZoom(Math.max(25, props.zoom - 25))}
                  aria-label="Zoom out"
                >
                  <MinusIcon size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => props.onSetZoom(Math.min(300, props.zoom + 25))}
                  aria-label="Zoom in"
                >
                  <PlusIcon size={15} />
                </button>
                <span className="viewer-divider" />
              </>
            )}
            {selected.kind === "photo" && (
              <button
                type="button"
                onClick={() => props.onRotate(90)}
                aria-label="Rotate 90 degrees"
                title="Rotate 90°"
              >
                <RotateIcon size={14} /> Rotate
              </button>
            )}
            {selected.kind === "photo" && (
              <button
                type="button"
                onClick={() => props.onToggleFlip()}
                aria-label="Flip horizontally"
                title="Flip horizontal"
                className={props.flipX ? "active" : ""}
              >
                <FlipIcon size={14} /> Flip
              </button>
            )}
            {selected.kind === "photo" && (props.rotation !== 0 || props.flipX) && (
              <button
                type="button"
                onClick={() => props.onResetTransform()}
                aria-label="Reset rotation and flip"
                title="Reset rotation & flip"
              >
                Reset
              </button>
            )}
            <button
              type="button"
              onClick={() => props.onToggleFavorite(selected.id)}
              aria-pressed={!!selected.favorite}
              aria-label={selected.favorite ? "Remove favorite" : "Add favorite"}
            >
              <HeartIcon size={14} filled={!!selected.favorite} /> Favorite
            </button>
            <button
              type="button"
              onClick={() => void props.onToggleHidden(selected.id)}
              aria-pressed={!!selected.hidden}
              aria-label={selected.hidden ? "Unhide item" : "Hide item"}
            >
              <EyeOffIcon size={14} />
              {selected.hidden ? "Unhide" : "Hide"}
            </button>
            {selected.kind === "photo" && (
              <button type="button" onClick={() => props.onOpenEdit(selected)}>
                <EditIcon size={14} /> Edit
              </button>
            )}
            {selected.kind === "photo" && photoItems.length > 1 && (
              <button type="button" onClick={startSlideshow} aria-label="Start photo slideshow">
                <SlideshowIcon size={14} /> Slideshow
              </button>
            )}
            <button type="button" onClick={() => void props.onToggleFullscreen()}>
              <FullscreenIcon size={14} /> Full screen
            </button>
          </div>
        )}
      </div>
      <div className="filmstrip" ref={stripRef} onScroll={handleFilmstripScroll}>
        <span className="filmstrip-label">FOLDER</span>
        {stripStart > 0 && (
          <span
            className="filmstrip-spacer"
            aria-hidden="true"
            style={{ flexBasis: `${stripStart * 60}px` }}
          />
        )}
        {items.slice(stripStart, stripEnd).map((item) => (
          <button
            type="button"
            title={item.name}
            className={item.id === props.selected?.id ? "active" : ""}
            key={item.id}
            onClick={() => props.onSetPhoto(item.id)}
          >
            {item.kind === "photo" ? (
              <CachedThumbnail
                itemId={item.id}
                name={item.name}
                size={128}
                style={draftImageStyle(draftTransforms, item.id)}
              />
            ) : (
              <span>{item.extension.toUpperCase()}</span>
            )}
            <KindDot kind={item.kind} />
          </button>
        ))}
        {stripEnd < items.length && (
          <span
            className="filmstrip-spacer"
            aria-hidden="true"
            style={{ flexBasis: `${(items.length - stripEnd) * 60}px` }}
          />
        )}
      </div>
    </div>
  );
}

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
  onSetValue: (key: keyof EditValues, value: EditValues[keyof EditValues]) => void;
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
  onClose: () => void;
  onSaveDraft: () => Promise<void>;
  onBack: () => void;
  onExport: (inPlace?: boolean) => void | Promise<void>;
  onClearDraft: (id: string) => void;
  onNotice: (text: string) => void;
  onOpenEdit: (item: MediaItem) => void;
}

export default ViewerScreen;
