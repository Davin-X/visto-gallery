import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

export interface PanelResizerProps {
  /** Which edge of the panel owns the handle. */
  side: "left" | "right";
  /** Committed width in CSS pixels. */
  width: number;
  min: number;
  /** Upper bound, or a function evaluated when a drag starts so the bound can
   *  adapt to the current window/layout size. */
  max: number | (() => number);
  /** Custom property read by the panel's CSS (`--sidebar-width`, …). */
  cssVar: `--${string}`;
  /** Element that owns the custom property. It is updated directly while
   *  dragging so a React render is not needed for every pointer move. */
  targetRef: React.RefObject<HTMLElement | null>;
  /** Persist the final width. Called once per drag (and per keyboard step). */
  onCommit: (width: number) => void;
  /** Width restored on double-click. */
  defaultWidth: number;
  disabled?: boolean;
  label: string;
}

const KEYBOARD_STEP = 12;
const KEYBOARD_LARGE_STEP = 48;

/**
 * Invisible vertical drag handle for a resizable side panel.
 *
 * - Updates a CSS custom property directly through requestAnimationFrame so
 *   dragging stays smooth even when the window is large.
 * - Uses pointer capture, so releasing outside the window still ends cleanly.
 * - Adds `is-resizing` to <body> to suppress CSS transitions and force the
 *   resize cursor for the duration of the drag.
 * - Keyboard accessible: arrow keys resize, Home/End jump to the bounds.
 */
export function PanelResizer({
  side,
  width,
  min,
  max,
  cssVar,
  targetRef,
  onCommit,
  defaultWidth,
  disabled = false,
  label,
}: PanelResizerProps) {
  const cleanupRef = useRef<(() => void) | null>(null);
  // Tracks the last width produced by keyboard/double-click within the current
  // render, so repeated key presses accumulate even before the parent commits.
  const liveWidthRef = useRef(width);

  useEffect(() => {
    liveWidthRef.current = width;
  }, [width]);

  const resolveMax = useCallback(() => {
    const value = typeof max === "function" ? max() : max;
    return Math.max(min, value);
  }, [max, min]);

  const clamp = useCallback(
    (value: number) => Math.round(Math.min(resolveMax(), Math.max(min, value))),
    [resolveMax, min],
  );

  const writeWidth = useCallback(
    (value: number) => {
      targetRef.current?.style.setProperty(cssVar, `${value}px`);
    },
    [cssVar, targetRef],
  );

  // If the panel is unmounted mid-drag, drop the listeners and body state.
  useEffect(() => () => cleanupRef.current?.(), []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    if (!targetRef.current) return;
    event.preventDefault();

    // A second pointerdown can only happen if a previous drag never ended.
    cleanupRef.current?.();

    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = width;
    let latest = clamp(startWidth);
    let frame = 0;

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // jsdom / older engines: window listeners below still work.
    }

    const apply = () => {
      frame = 0;
      writeWidth(latest);
    };

    const onMove = (moveEvent: PointerEvent) => {
      const delta = side === "left" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      latest = clamp(startWidth + delta);
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    function removeListeners() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      handle.classList.remove("is-resizing");
      document.body.classList.remove("is-resizing");
      cleanupRef.current = null;
    }

    function finish() {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      writeWidth(latest);
      liveWidthRef.current = latest;
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Capture may already have been released by the browser.
      }
      removeListeners();
      if (latest !== startWidth) onCommit(latest);
    }

    cleanupRef.current = () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      removeListeners();
    };

    document.body.classList.add("is-resizing");
    handle.classList.add("is-resizing");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;

    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    const from = liveWidthRef.current;
    let next = from;

    switch (event.key) {
      case "ArrowLeft":
        next = from + (side === "left" ? -step : step);
        break;
      case "ArrowRight":
        next = from + (side === "left" ? step : -step);
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = resolveMax();
        break;
      default:
        return;
    }

    event.preventDefault();
    const clamped = clamp(next);
    if (clamped === from) return;
    liveWidthRef.current = clamped;
    writeWidth(clamped);
    onCommit(clamped);
  };

  const handleDoubleClick = () => {
    if (disabled) return;
    const next = clamp(defaultWidth);
    if (next === liveWidthRef.current) return;
    liveWidthRef.current = next;
    writeWidth(next);
    onCommit(next);
  };

  return (
    <div
      className={`resizer resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={Math.round(resolveMax())}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
    />
  );
}
