import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { anchoredPan, clampZoom, wheelZoomFactor, type Point } from "../../engine/utils/zoom";

/**
 * Trackpad pinch, Ctrl/⌘-scroll and two-finger panning on the viewer stage.
 * Listeners are native and non-passive so they prevent WebKit from scrolling or
 * magnifying the whole webview.
 */
export function useStageZoomGestures({
  stageRef,
  zoomable,
  itemId,
  zoom,
  pan,
  setPan,
  setPanning,
  onSetZoom,
  clampPanTo,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  zoomable: boolean;
  itemId: string | undefined;
  zoom: number;
  pan: Point;
  setPan: Dispatch<SetStateAction<Point>>;
  setPanning: Dispatch<SetStateAction<boolean>>;
  onSetZoom: (zoom: number) => void;
  clampPanTo: (next: Point, zoom: number) => Point;
}) {
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;
  const setZoomRef = useRef(onSetZoom);
  setZoomRef.current = onSetZoom;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !zoomable) return;
    let settleTimer: number | undefined;
    // Transforms animate for buttons and keys, but follow a gesture directly.
    const gesturing = () => {
      setPanning(true);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => setPanning(false), 160);
    };
    const zoomAt = (target: number, clientX: number, clientY: number) => {
      const rect = stage.getBoundingClientRect();
      const from = zoomRef.current;
      const to = clampZoom(target);
      if (Math.abs(to - from) < 0.01) return;
      const anchor = {
        x: clientX - (rect.left + rect.width / 2),
        y: clientY - (rect.top + rect.height / 2),
      };
      const next =
        to <= 100 ? { x: 0, y: 0 } : clampPanTo(anchoredPan(panRef.current, anchor, from, to), to);
      zoomRef.current = to;
      panRef.current = next;
      setPan(next);
      setZoomRef.current(to);
    };

    // WebKit reports a trackpad pinch as gesture events with a running scale.
    let pinchBase: number | null = null;
    type GestureEventLike = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      pinchBase = zoomRef.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (pinchBase === null) return;
      const gesture = event as GestureEventLike;
      gesturing();
      zoomAt(pinchBase * gesture.scale, gesture.clientX, gesture.clientY);
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      pinchBase = null;
    };

    const onWheel = (event: WheelEvent) => {
      // Chromium reports a pinch as Ctrl+wheel; ⌘-scroll zooms with a mouse.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (pinchBase !== null) return;
        gesturing();
        zoomAt(
          zoomRef.current * wheelZoomFactor(event.deltaY, event.deltaMode),
          event.clientX,
          event.clientY,
        );
        return;
      }
      // Two-finger scroll moves around a zoomed photo.
      if (zoomRef.current > 100) {
        event.preventDefault();
        gesturing();
        const next = clampPanTo(
          { x: panRef.current.x - event.deltaX, y: panRef.current.y - event.deltaY },
          zoomRef.current,
        );
        panRef.current = next;
        setPan(next);
      }
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("gesturestart", onGestureStart);
    stage.addEventListener("gesturechange", onGestureChange);
    stage.addEventListener("gestureend", onGestureEnd);
    return () => {
      window.clearTimeout(settleTimer);
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("gesturestart", onGestureStart);
      stage.removeEventListener("gesturechange", onGestureChange);
      stage.removeEventListener("gestureend", onGestureEnd);
    };
    // Re-register when itemId changes (e.g. empty state -> stage mount).
  }, [stageRef, zoomable, itemId, clampPanTo, setPan, setPanning]);
}
