import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";
import { KindBadge } from "./KindBadge";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { formatBytesSimple } from "../../engine/utils/mediaTypes";
import { compareRows, differenceCount } from "../../engine/duplicates/compare";
import type { MediaItem } from "../../engine/types/media";

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

export interface PanOffset {
  x: number;
  y: number;
}

/** Header summary for the number of metadata fields that differ. */
export function describeDifferences(differences: number): string {
  if (differences === 0) return "Identical metadata";
  return `${differences} ${differences === 1 ? "field differs" : "fields differ"}`;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Keeps the image from being dragged past its own edge. Both panes share the
 * same offset and are the same size, so clamping against one box keeps them in
 * lockstep.
 */
export function clampPan(
  pan: PanOffset,
  zoom: number,
  size: { width: number; height: number },
): PanOffset {
  const limitX = Math.max(0, ((zoom - 1) * size.width) / 2);
  const limitY = Math.max(0, ((zoom - 1) * size.height) / 2);
  // `+ 0` normalizes -0, which would otherwise render as `translate3d(-0px…)`
  // and fail strict equality.
  const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value)) + 0;
  return { x: clamp(pan.x, limitX), y: clamp(pan.y, limitY) };
}

interface CompareOverlayProps {
  keeper: MediaItem;
  copies: MediaItem[];
  initialCopyId?: string;
  assetUrl: (path: string) => string;
  onClose: () => void;
}

function ComparePreview({
  item,
  assetUrl,
  zoom,
  pan,
}: {
  item: MediaItem;
  assetUrl: (path: string) => string;
  zoom: number;
  pan: PanOffset;
}) {
  const transform = `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`;
  if (item.kind === "raw") {
    return (
      <span className="compare-raw">
        <KindBadge kind="raw" />
        <span>RAW preview needs the native backend</span>
      </span>
    );
  }
  if (item.kind === "video") {
    return (
      <video
        className="compare-image"
        src={assetUrl(item.path)}
        style={{ transform }}
        muted
        playsInline
        preload="metadata"
      />
    );
  }
  return (
    <img
      className="compare-image"
      src={assetUrl(item.path)}
      alt={`${item.name} preview`}
      style={{ transform }}
      draggable={false}
    />
  );
}

/**
 * Side-by-side inspection of the keeper and one copy: the two panes share a
 * single zoom/pan state so both images land on the same pixels, and the table
 * underneath flags every field that actually differs.
 */
export function CompareOverlay({
  keeper,
  copies,
  initialCopyId,
  assetUrl,
  onClose,
}: CompareOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [copyId, setCopyId] = useState(initialCopyId ?? copies[0]?.id ?? "");
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState<PanOffset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const copy = copies.find((item) => item.id === copyId) ?? copies[0];
  const copyIndex = copies.findIndex((item) => item.id === copy?.id);
  const rows = useMemo(() => (copy ? compareRows(keeper, copy) : []), [keeper, copy]);
  const differences = differenceCount(rows);

  useFocusTrap(true, dialogRef);

  const applyZoom = useCallback((next: number) => {
    const clamped = clampZoom(next);
    setZoom(clamped);
    if (clamped === MIN_ZOOM) setPan({ x: 0, y: 0 });
    else {
      const box = stageRef.current;
      const width = box ? box.clientWidth / 2 : 0;
      const height = box ? box.clientHeight : 0;
      setPan((current) => clampPan(current, clamped, { width, height }));
    }
  }, []);

  const reset = useCallback(() => {
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
  }, []);

  const step = useCallback(
    (direction: 1 | -1) => {
      const index = copies.findIndex((item) => item.id === copy?.id);
      const next = copies[index + direction];
      if (next) {
        setCopyId(next.id);
        reset();
      }
    },
    [copies, copy?.id, reset],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        applyZoom(zoom * 1.5);
      } else if (event.key === "-") {
        event.preventDefault();
        applyZoom(zoom / 1.5);
      } else if (event.key === "0") {
        event.preventDefault();
        reset();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyZoom, onClose, reset, step, zoom]);

  // React registers `onWheel` passively, so preventDefault() throws there and
  // the trackpad ends up scrolling the page under the dialog. Bind it directly
  // to get a cancelable listener.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      applyZoom(zoom * Math.exp(-event.deltaY / 320));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [applyZoom, zoom]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= MIN_ZOOM) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const box = stageRef.current;
    const width = box ? box.clientWidth / 2 : 0;
    const height = box ? box.clientHeight : 0;
    setPan(
      clampPan(
        {
          x: drag.originX + (event.clientX - drag.startX),
          y: drag.originY + (event.clientY - drag.startY),
        },
        zoom,
        { width, height },
      ),
    );
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const paneCaption = (item: MediaItem) =>
    [
      formatBytesSimple(item.size),
      item.width && item.height ? `${item.width}×${item.height}` : null,
      item.extension?.toUpperCase(),
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div
      className="dialog-backdrop compare-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="compare-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-title"
        ref={dialogRef}
      >
        <header className="compare-head">
          <div>
            <p className="eyebrow">COMPARE</p>
            <h2 id="compare-title">Keeper vs copy</h2>
          </div>
          <div className="compare-head-side">
            <span className={`compare-diff-count${differences === 0 ? " is-clean" : ""}`}>
              {describeDifferences(differences)}
            </span>
            <button
              type="button"
              className="quiet-button"
              onClick={onClose}
              aria-label="Close compare"
            >
              Close
            </button>
          </div>
        </header>

        <div className="compare-toolbar">
          <div className="compare-copy-tabs" role="group" aria-label="Copy to compare">
            <button
              type="button"
              className="compare-arrow"
              aria-label="Previous copy"
              disabled={copyIndex <= 0}
              onClick={() => step(-1)}
            >
              <ChevronLeftIcon size={12} />
            </button>
            {copies.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={`compare-copy-tab${item.id === copy?.id ? " is-active" : ""}`}
                aria-pressed={item.id === copy?.id}
                title={item.path}
                onClick={() => {
                  setCopyId(item.id);
                  reset();
                }}
              >
                Copy {index + 1}
              </button>
            ))}
            <button
              type="button"
              className="compare-arrow"
              aria-label="Next copy"
              disabled={copyIndex === -1 || copyIndex >= copies.length - 1}
              onClick={() => step(1)}
            >
              <ChevronRightIcon size={12} />
            </button>
          </div>

          <div className="compare-zoom">
            <button
              type="button"
              className="compare-zoom-button"
              aria-label="Zoom out"
              onClick={() => applyZoom(zoom / 1.5)}
            >
              −
            </button>
            <input
              type="range"
              min={Math.round(MIN_ZOOM * 100)}
              max={Math.round(MAX_ZOOM * 100)}
              step={5}
              value={Math.round(zoom * 100)}
              aria-label="Zoom level"
              onChange={(event) => applyZoom(Number(event.target.value) / 100)}
            />
            <button
              type="button"
              className="compare-zoom-button"
              aria-label="Zoom in"
              onClick={() => applyZoom(zoom * 1.5)}
            >
              +
            </button>
            <span className="compare-zoom-value">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              className="quiet-button compare-reset"
              onClick={reset}
              disabled={zoom === MIN_ZOOM && pan.x === 0 && pan.y === 0}
            >
              Reset
            </button>
          </div>
        </div>

        <div
          className={`compare-stage${dragging ? " is-dragging" : ""}${
            zoom > MIN_ZOOM ? " is-zoomed" : ""
          }`}
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
        >
          <figure className="compare-pane">
            <div className="compare-frame">
              <ComparePreview item={keeper} assetUrl={assetUrl} zoom={zoom} pan={pan} />
            </div>
            <figcaption className="compare-caption">
              <span className="compare-role is-keeper">Keep</span>
              <span className="compare-name" title={keeper.path}>
                {keeper.name}
              </span>
              <span className="compare-meta">{paneCaption(keeper)}</span>
            </figcaption>
          </figure>

          <figure className="compare-pane">
            <div className="compare-frame">
              {copy ? (
                <ComparePreview item={copy} assetUrl={assetUrl} zoom={zoom} pan={pan} />
              ) : null}
            </div>
            <figcaption className="compare-caption">
              <span className="compare-role">Copy</span>
              <span className="compare-name" title={copy?.path}>
                {copy?.name ?? "—"}
              </span>
              <span className="compare-meta">{copy ? paneCaption(copy) : ""}</span>
            </figcaption>
          </figure>
        </div>

        <div className="compare-table-wrap">
          <table className="compare-table">
            <caption className="visually-hidden">
              Metadata differences between keeper and copy
            </caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Keep</th>
                <th scope="col">Copy</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className={row.differs ? "is-diff" : undefined}>
                  <th scope="row">{row.label}</th>
                  <td>{row.keeper}</td>
                  <td>{row.copy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
