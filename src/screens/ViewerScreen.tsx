import React, { useState, useMemo, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EditIcon,
  EyeOffIcon,
  FilmstripIcon,
  FlipIcon,
  FullscreenIcon,
  HeartIcon,
  InfoIcon,
  MinusIcon,
  MoreIcon,
  PlusIcon,
  RotateIcon,
  SlideshowIcon,
  ViewerIcon,
} from "../design/components/icons";
import { CachedThumbnail } from "../design/components/CachedThumbnail";

import { KindDot } from "../design/components/KindBadge";
import { useDraftTransforms, draftTransformStyle } from "../engine/stores/useEditStore";
import { useSlideshowStore } from "../engine/stores/useSlideshowStore";
import { tauri } from "../engine/commands/tauri";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import { formatDuration } from "../engine/utils/time";
import { draftImageStyle } from "../engine/utils/draftImage";
import type { MediaItem } from "../engine/types/media";
import { formatItemDate } from "../engine/utils/mediaDate";

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
  /** More of this view exists than the loaded page holds. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => unknown;
}

function ViewerScreen(props: ViewerScreenProps) {
  const { hasMore, loadingMore, onLoadMore } = props;
  const items = useMemo(() => props.items.filter((item) => item.kind !== "video"), [props.items]);
  const photoItems = useMemo(() => items.filter((item) => item.kind === "photo"), [items]);
  // Was the inspected item a video? The Viewer only shows photos — give the
  // user a real answer instead of the generic empty state.
  const inspectedVideo = props.selected?.kind === "video";
  const selected = props.selected?.kind === "video" ? null : props.selected;
  const draftTransforms = useDraftTransforms();
  // Drag-to-pan for zoomed photos. State resets when the selected item
  // changes and whenever zoom/fitMode moves away from its last value.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // True while a drag is in flight: the photo's transform transition would
  // otherwise make every pointer move lag 180 ms behind the cursor.
  const [panning, setPanning] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({
    pointerId: -1,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  });
  // Folder context: the pill shows the containing folder, the subtle line the
  // full path. Deriving both from the media path keeps it honest (no fake
  // "LOCAL FILE" label).
  const folderPath = selected?.path
    ? String(selected.path).replace(/\\/g, "/").split("/").slice(0, -1).join("/")
    : "";
  const [hintsVisible, setHintsVisible] = useState(true);
  const [photoLoadState, setPhotoLoadState] = useState<{
    id: string;
    status: "loading" | "loaded" | "failed";
  } | null>(null);
  const stripWindowSize = 50;
  // One strip item occupies `stripStride` px. It is measured from the rendered
  // strip rather than duplicated here: the thumbnail size and gap belong to
  // the CSS and change with the window.
  const [stripStride, setStripStride] = useState(66);
  const [stripStart, setStripStart] = useState(() =>
    Math.max(0, items.findIndex((item) => item.id === selected?.id) - stripWindowSize / 2),
  );
  const hideTimerRef = useRef<number | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement | null>(null);

  // Rotate, flip and hide live behind one menu in the docked bar instead of
  // sitting at the same weight as zoom and full screen, and the shortcut list
  // opens from a help button beside it rather than as a strip pinned over the
  // picture. Clicking elsewhere closes either; Escape is left to the viewer,
  // which closes the whole surface.
  useEffect(() => {
    if (!moreOpen && !helpOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!moreRef.current?.contains(target)) setMoreOpen(false);
      if (!helpRef.current?.contains(target)) setHelpOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [moreOpen, helpOpen]);

  // The idle timer fades the bar out, and a popover is a child of the bar, so
  // it would fade with it. Hold the bar open while one is showing, then restart
  // the timer once both are closed. The first render is skipped so opening the
  // viewer does not start a countdown it never had before.
  const popoverOpenedRef = useRef(false);
  useEffect(() => {
    if (moreOpen || helpOpen) {
      popoverOpenedRef.current = true;
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
      return;
    }
    if (!popoverOpenedRef.current) return;
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500);
  }, [moreOpen, helpOpen]);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripStrideRef = useRef(stripStride);
  const stripStartRef = useRef(stripStart);
  const lastRevealedRef = useRef<string | null>(null);
  const loadMoreLockRef = useRef(false);
  const selectedIndex = items.findIndex((item) => item.id === selected?.id);
  const stripEnd = Math.min(items.length, stripStart + stripWindowSize);
  const photoStatus =
    photoLoadState && photoLoadState.id === selected?.id ? photoLoadState.status : "loading";
  const imageRotation =
    (props.rotation + (draftTransforms.get(selected?.id ?? "")?.rotation || 0)) % 360;
  const startSlideshow = useCallback(() => {
    useSlideshowStore.getState().open(photoItems, selected?.id);
  }, [photoItems, selected?.id]);
  const shortcutHints = buildShortcuts(selected?.kind);

  // Shortcut hints are shown on open and whenever the pointer moves over the
  // stage, then fade away after a short pause so the frame stays clean.
  const flashHints = useCallback(() => {
    setHintsVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500);
  }, []);

  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setPanning(false);
  }, [selected?.id]);

  // Whenever zoom changes, clamp the current pan back inside the new image
  // box so the photo never gets stranded off-stage.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const scale = props.zoom / 100;
    const rect = stage.getBoundingClientRect();
    const limitX = Math.max(0, ((scale - 1) * rect.width) / 2);
    const limitY = Math.max(0, ((scale - 1) * rect.height) / 2);
    setPan((current) => ({
      x: Math.min(limitX, Math.max(-limitX, current.x)),
      y: Math.min(limitY, Math.max(-limitY, current.y)),
    }));
  }, [props.zoom, props.fitMode]);

  const handleStagePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (props.zoom <= 100 || !selected) return;
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, a")) return;
    stageRef.current?.setPointerCapture(event.pointerId);
    setPanning(true);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
  };

  const handleStagePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    const stage = stageRef.current;
    if (!stage) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const scale = props.zoom / 100;
    const rect = stage.getBoundingClientRect();
    const limitX = Math.max(0, ((scale - 1) * rect.width) / 2);
    const limitY = Math.max(0, ((scale - 1) * rect.height) / 2);
    setPan({
      x: Math.min(limitX, Math.max(-limitX, drag.originX + dx)),
      y: Math.min(limitY, Math.max(-limitY, drag.originY + dy)),
    });
  };

  const handleStagePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current.pointerId = -1;
    setPanning(false);
    stageRef.current?.releasePointerCapture(event.pointerId);
  };

  useEffect(() => {
    flashHints();
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [props.selected?.id, flashHints]);

  // Measure the real stride from the rendered strip. The CSS owns the
  // thumbnail size and gap, so a duplicated constant drifts out of step with
  // the spacers and the strip renders the wrong slice of the list.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const button = strip.querySelector<HTMLElement>("button");
    const width = button?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return;
    const gap = Number.parseFloat(window.getComputedStyle(strip).columnGap || "0") || 0;
    const stride = width + gap;
    if (Math.abs(stride - stripStrideRef.current) > 0.5) {
      stripStrideRef.current = stride;
      setStripStride(stride);
    }
  }, [items.length]);

  // Bring the current photo to the middle of the strip when the selection
  // changes, and once on open. Deliberately not keyed on the scroll position:
  // re-running this on every scroll event snapped the strip back to the
  // current photo the moment the user tried to browse elsewhere.
  // Pull in the next page when the strip reaches the end of what is loaded.
  // The viewer used to stop dead at the library's page size ("250 of 250").
  const maybeLoadMore = useCallback(() => {
    if (!hasMore || !onLoadMore || loadMoreLockRef.current) return;
    loadMoreLockRef.current = true;
    void Promise.resolve(onLoadMore()).finally(() => {
      loadMoreLockRef.current = false;
    });
  }, [hasMore, onLoadMore]);

  useEffect(() => {
    loadMoreLockRef.current = false;
  }, [items.length]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || selectedIndex < 0) return;
    const currentId = selected?.id ?? null;
    const selectionChanged = lastRevealedRef.current !== currentId;
    lastRevealedRef.current = currentId;
    const stride = stripStrideRef.current;
    const maxStart = Math.max(0, items.length - stripWindowSize);
    let start = stripStartRef.current;
    const outsideWindow = selectedIndex < start || selectedIndex >= start + stripWindowSize;
    if (outsideWindow) {
      start = Math.max(0, Math.min(selectedIndex - Math.floor(stripWindowSize / 2), maxStart));
      stripStartRef.current = start;
      setStripStart(start);
    } else if (!selectionChanged) {
      // A page arrived: leave the strip where the user left it.
      return;
    }
    // A leading spacer of exactly one stride per skipped item means every
    // thumbnail sits at `index × stride` regardless of the rendered window.
    strip.scrollLeft = Math.max(
      0,
      selectedIndex * stride - Math.max(0, (strip.clientWidth - stride) / 2),
    );
  }, [selectedIndex, selected?.id, items.length, stripWindowSize]);

  // Slide the rendered window along as the user scrolls. The scroll position
  // needs no correction: a spacer of exactly one stride per skipped item keeps
  // every thumbnail at the same offset, so the strip moves under the pointer
  // without jumping.
  const handleFilmstripScroll = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || items.length <= stripWindowSize) return;
    const stride = stripStrideRef.current;
    if (stride <= 0) return;
    const start = stripStartRef.current;
    const lead = 10;
    const first = Math.max(0, Math.floor(strip.scrollLeft / stride));
    const last = first + Math.ceil(strip.clientWidth / stride) + 1;
    if (last > items.length - 10) maybeLoadMore();
    let next = start;
    if (first < start + lead) {
      next = Math.max(0, first - lead);
    } else if (last > start + stripWindowSize - lead) {
      next = Math.min(Math.max(0, items.length - stripWindowSize), last - stripWindowSize + lead);
    }
    if (next === start) return;
    stripStartRef.current = next;
    setStripStart(next);
  }, [items.length, stripWindowSize, maybeLoadMore]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selected) return;
      if (!props.active) return;
      // Ignore if typing in an input, or if the slideshow overlay is driving.
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      if (useSlideshowStore.getState().isOpen) return;
      // These are bare-key shortcuts. A ⌘/Ctrl/⌥ combination belongs to the
      // global map (⌘F focuses search, ⌘R reloads), so it must not also
      // favorite or rotate the photo behind it.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "ArrowUp":
          if (selected.kind === "photo" || selected.kind === "raw") {
            e.preventDefault();
            props.onSetZoom(Math.min(300, props.zoom + 25));
          }
          break;
        case "ArrowDown":
          if (selected.kind === "photo" || selected.kind === "raw") {
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
        case " ":
        case "k":
        case "K":
          // Space advances, and K mirrors J below so a keyboard-first user
          // never has to leave the home row.
          e.preventDefault();
          props.onNavigate(1);
          break;
        case "j":
        case "J":
          e.preventDefault();
          props.onNavigate(-1);
          break;
        case "l":
        case "L":
          e.preventDefault();
          props.onToggleFavorite(selected.id);
          break;
        case "f":
        case "F":
          e.preventDefault();
          props.onToggleFullscreen();
          break;
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
      <header className="page-heading video-player-heading viewer-heading">
        <button
          type="button"
          className="video-player-back"
          onClick={props.onClose}
          aria-label="Close viewer"
          title="Close viewer (Esc)"
        >
          <ChevronLeftIcon size={17} strokeWidth={2.1} />
        </button>
        <div className="video-player-title">
          <h1 title={selected.name}>{selected.name}</h1>
          <div className="viewer-meta">
            <div className="meta-row">
              <span
                className="video-player-meta-chip"
                title={`Photo ${selectedIndex + 1} of ${items.length} in this view`}
              >
                <FilmstripIcon size={11} strokeWidth={2} />
                {`${selectedIndex + 1} of ${items.length}${hasMore ? "+" : ""}`}
              </span>
              <span className="meta-chip">
                <svg
                  className="meta-icon"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <path d="M8 2v4M8 10v4M2 8h4M10 8h4" />
                </svg>
                {formatItemDate(selected)}
              </span>
              <span className="meta-chip">
                <svg
                  className="meta-icon"
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
      </header>
      <div
        ref={stageRef}
        className="viewer-stage"
        aria-busy={selected.kind === "photo" && photoStatus === "loading"}
        onContextMenu={(event) => props.onContextMenu([selected], event)}
        onMouseMove={() => flashHints()}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerUp}
        onPointerCancel={handleStagePointerUp}
        style={{
          touchAction: props.zoom > 100 ? "none" : "auto",
          cursor: props.zoom > 100 ? "grab" : "default",
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          if (selected.kind !== "photo" && selected.kind !== "raw") return;
          setPan({ x: 0, y: 0 });
          props.onSetZoom(props.zoom === 100 ? 200 : 100);
        }}
      >
        {/* Video keeps the floating arrows: its own transport bar already owns
            the stage floor, and a second bar there would collide with it.
            Stills get the same pair inside the docked bar below. */}
        {selected.kind === "video" && (
          <button
            className="viewer-arrow left"
            type="button"
            onClick={() => props.onNavigate(-1)}
            aria-label="Previous"
            title="Previous item (←)"
          >
            <ChevronLeftIcon size={21} strokeWidth={2.1} />
          </button>
        )}
        {selected.kind === "photo" || selected.kind === "raw" ? (
          <>
            {selected.kind === "photo" ? (
              <>
                <img
                  key={`${selected.id}-${selected.size}-${selected.modifiedAt}`}
                  className={`photo-viewer-image${photoStatus === "loaded" ? " is-loaded" : ""}${panning ? " is-panning" : ""}`}
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
                        : undefined,
                    width: props.fitMode === "actual" ? undefined : "100%",
                    height: props.fitMode === "actual" ? undefined : "100%",
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
                      `translate3d(${pan.x}px, ${pan.y}px, 0)`,
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
              <CachedThumbnail
                itemId={selected.id}
                name={selected.name}
                size={1024}
                eager
                style={{
                  width: props.fitMode === "actual" ? undefined : "100%",
                  height: props.fitMode === "actual" ? undefined : "100%",
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
                  objectFit: "contain",
                  transform: [
                    `translate3d(${pan.x}px, ${pan.y}px, 0)`,
                    `rotate(${props.rotation || 0}deg)`,
                    `scaleX(${props.flipX ? -1 : 1})`,
                    `scale(${props.zoom / 100})`,
                  ]
                    .filter(Boolean)
                    .join(" "),
                }}
              />
            )}
          </>
        ) : null}
        {selected.kind === "video" && (
          <button
            className="viewer-arrow right"
            type="button"
            onClick={() => props.onNavigate(1)}
            aria-label="Next"
            title="Next item (→)"
          >
            <ChevronRightIcon size={21} strokeWidth={2.1} />
          </button>
        )}
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
            <button
              type="button"
              className="viewer-arrow is-docked"
              onClick={() => props.onNavigate(-1)}
              aria-label="Previous"
              title="Previous item (←)"
            >
              <ChevronLeftIcon size={19} strokeWidth={2.1} />
            </button>
            <button
              type="button"
              className="viewer-arrow is-docked"
              onClick={() => props.onNavigate(1)}
              aria-label="Next"
              title="Next item (→)"
            >
              <ChevronRightIcon size={19} strokeWidth={2.1} />
            </button>
            <span className="viewer-divider" />
            {(selected.kind === "photo" || selected.kind === "raw") && (
              <>
                {/* Stepper around the value, then the fit mode: the value sits
                    between the two controls that change it. */}
                <button
                  type="button"
                  onClick={() => props.onSetZoom(Math.max(25, props.zoom - 25))}
                  aria-label="Zoom out"
                  title="Zoom out (↓)"
                >
                  <MinusIcon size={15} />
                </button>
                <button
                  type="button"
                  className="viewer-zoom-value"
                  onClick={props.onResetZoom}
                  aria-label="Reset zoom"
                  title="Reset zoom"
                >
                  {props.zoom}%
                </button>
                <button
                  type="button"
                  onClick={() => props.onSetZoom(Math.min(300, props.zoom + 25))}
                  aria-label="Zoom in"
                  title="Zoom in (↑)"
                >
                  <PlusIcon size={15} />
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
                <span className="viewer-divider" />
              </>
            )}
            {/* Occasional actions, one level down: they are the same weight in
                the bar as zoom and full screen, but not the same frequency. */}
            {(selected.kind === "photo" || selected.kind === "raw") && (
              <div className="viewer-more" ref={moreRef}>
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  aria-label="More actions"
                  title="More actions"
                  className={moreOpen ? "active" : ""}
                  onClick={() => setMoreOpen((value) => !value)}
                >
                  <MoreIcon size={15} />
                </button>
                {moreOpen && (
                  <div className="viewer-more-menu" role="menu" aria-label="More actions">
                    {selected.kind === "photo" && (
                      <button
                        type="button"
                        role="menuitem"
                        aria-label="Rotate 90 degrees"
                        onClick={() => {
                          props.onRotate(90);
                          setMoreOpen(false);
                        }}
                      >
                        <RotateIcon size={14} /> Rotate 90°
                      </button>
                    )}
                    {selected.kind === "photo" && (
                      <button
                        type="button"
                        role="menuitem"
                        aria-label="Flip horizontally"
                        className={props.flipX ? "active" : ""}
                        onClick={() => {
                          props.onToggleFlip();
                          setMoreOpen(false);
                        }}
                      >
                        <FlipIcon size={14} /> Flip horizontally
                      </button>
                    )}
                    {selected.kind === "photo" && (props.rotation !== 0 || props.flipX) && (
                      <button
                        type="button"
                        role="menuitem"
                        aria-label="Reset rotation and flip"
                        onClick={() => {
                          props.onResetTransform();
                          setMoreOpen(false);
                        }}
                      >
                        Reset rotation and flip
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={selected.hidden ? "Unhide item" : "Hide item"}
                      onClick={() => {
                        void props.onToggleHidden(selected.id);
                        setMoreOpen(false);
                      }}
                    >
                      <EyeOffIcon size={14} /> {selected.hidden ? "Unhide" : "Hide"}
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => props.onToggleFavorite(selected.id)}
              aria-pressed={!!selected.favorite}
              aria-label={selected.favorite ? "Remove favorite" : "Add favorite"}
              title={selected.favorite ? "Remove favorite (L)" : "Favorite (L)"}
            >
              <HeartIcon size={14} filled={!!selected.favorite} />
              <span className="viewer-bar-label">
                {selected.favorite ? "Unfavorite" : "Favorite"}
              </span>
            </button>
            {selected.kind === "photo" && (
              <button
                type="button"
                onClick={() => props.onOpenEdit(selected)}
                aria-label="Edit photo"
                title="Edit photo"
              >
                <EditIcon size={14} /> <span className="viewer-bar-label">Edit</span>
              </button>
            )}
            {selected.kind === "photo" && photoItems.length > 1 && (
              <button
                type="button"
                onClick={startSlideshow}
                aria-label="Start photo slideshow"
                title="Start photo slideshow"
              >
                <SlideshowIcon size={14} />
                <span className="viewer-bar-label">Slideshow</span>
              </button>
            )}
            <span className="viewer-divider" />
            <button
              type="button"
              onClick={() => void props.onToggleFullscreen()}
              aria-label="Toggle full screen"
              title="Full screen (F)"
            >
              <FullscreenIcon size={14} />
              <span className="viewer-bar-label">Full screen</span>
            </button>
            <div className="viewer-more viewer-help" ref={helpRef}>
              <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={helpOpen}
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts"
                className={helpOpen ? "active" : ""}
                onClick={() => setHelpOpen((value) => !value)}
              >
                <InfoIcon size={15} />
              </button>
              {helpOpen && (
                <div
                  className="viewer-more-menu viewer-shortcuts"
                  role="dialog"
                  aria-label="Keyboard shortcuts"
                >
                  {shortcutHints.map((hint) => (
                    <React.Fragment key={hint.label}>
                      <span className="viewer-shortcut-keys">
                        {hint.keys.map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                      </span>
                      <span className="viewer-shortcut-label">{hint.label}</span>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="filmstrip" ref={stripRef} onScroll={handleFilmstripScroll}>
        {stripStart > 0 && (
          <span
            className="filmstrip-spacer"
            aria-hidden="true"
            style={{ flexBasis: `${stripStart * stripStride}px` }}
          />
        )}
        {items.slice(stripStart, stripEnd).map((item) => (
          <button
            type="button"
            title={item.name}
            className={item.id === props.selected?.id ? "active" : ""}
            aria-current={item.id === props.selected?.id ? "true" : undefined}
            key={item.id}
            onClick={() => props.onSetPhoto(item.id)}
          >
            {item.kind === "photo" || item.kind === "raw" ? (
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
            style={{ flexBasis: `${(items.length - stripEnd) * stripStride}px` }}
          />
        )}
        {hasMore ? (
          <button
            type="button"
            className="filmstrip-more"
            onClick={() => void onLoadMore?.()}
            disabled={loadingMore}
            aria-label="Load more photos"
            title="Load more photos into this strip"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default ViewerScreen;

// Shortcut list shown from the help button in the bar. Same keys as the strip
// that used to float over the top of the picture, plus the ones that only apply
// to stills.
function buildShortcuts(kind: string | undefined) {
  const photo = kind === "photo";
  const still = photo || kind === "raw";
  const rows: Array<{ keys: string[]; label: string }> = [
    { keys: ["←", "→", "J", "K", "Space"], label: "Navigate" },
    { keys: ["↑", "↓"], label: "Zoom" },
  ];
  if (photo) rows.push({ keys: ["R", "X"], label: "Rotate / flip" });
  rows.push({ keys: ["0"], label: "Reset zoom" });
  if (still) rows.push({ keys: ["1"], label: "200%" });
  rows.push(
    { keys: ["L"], label: "Favorite" },
    { keys: ["F"], label: "Full screen" },
    { keys: ["Esc"], label: "Close" },
  );
  return rows;
}
