/**
 * Viewer zoom math, shared by the store, the toolbar, keyboard shortcuts and
 * trackpad/wheel gestures.
 *
 * Zoom is a percentage of the fitted size (100 = the photo fits the stage).
 */

export const MIN_ZOOM = 25;
export const MAX_ZOOM = 800;

/** Stops for the +/− buttons and ↑/↓ keys: fine near 100%, coarser beyond. */
export const ZOOM_STEPS = [25, 33, 50, 67, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 800];

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 100;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The next stop above (`1`) or below (`-1`) `current`. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const epsilon = 0.5;
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > current + epsilon) ?? MAX_ZOOM;
  }
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    if (ZOOM_STEPS[index] < current - epsilon) return ZOOM_STEPS[index];
  }
  return MIN_ZOOM;
}

/**
 * Multiplier for one wheel event. Trackpad pinches (Ctrl+wheel in Chromium)
 * send small deltas; a mouse wheel notch sends ~100, so each event is capped to
 * keep ⌘-scroll from jumping several stops at once.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const capped = Math.max(-50, Math.min(50, pixels));
  return Math.exp(-capped * 0.01);
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Pan that keeps the point under `anchor` (relative to the stage centre) fixed
 * while zooming from `from` to `to`. The image is scaled about its centre and
 * then translated by `pan`, so a stage point `a` shows image offset
 * `(a - pan) / from`; solving for the same offset at `to` gives the result.
 */
export function anchoredPan(pan: Point, anchor: Point, from: number, to: number): Point {
  const ratio = to / from;
  return {
    x: anchor.x - ratio * (anchor.x - pan.x),
    y: anchor.y - ratio * (anchor.y - pan.y),
  };
}

export interface Size {
  width: number;
  height: number;
}

/**
 * The photo's on-screen size at 100% when it is fitted (letterboxed) into the
 * stage. `aspect` is width / height as displayed (after rotation); without it
 * the photo is assumed to fill the stage.
 */
export function fittedSize(stage: Size, aspect: number | null): Size {
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0) return stage;
  return stage.width / stage.height > aspect
    ? { width: stage.height * aspect, height: stage.height }
    : { width: stage.width, height: stage.width / aspect };
}

/**
 * Zoom percentage (relative to fitted size) that displays one image pixel per
 * physical display pixel, accounting for Retina / HiDPI `devicePixelRatio`.
 */
export function oneToOneZoom(stage: Size, image: Size, devicePixelRatio = 1): number {
  if (stage.width <= 0 || stage.height <= 0 || image.width <= 0 || image.height <= 0) {
    return 100;
  }
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const fitted = fittedSize(stage, image.width / image.height);
  if (fitted.width <= 0) return 100;
  return clampZoom((image.width / dpr / fitted.width) * 100);
}

/**
 * Keep a zoomed photo covering the stage. Along an axis where the zoomed photo
 * is still narrower than the stage it stays centred, so no empty band can be
 * dragged into view.
 */
export function clampPan(pan: Point, zoom: number, stage: Size, content: Size = stage): Point {
  const scale = zoom / 100;
  const limitX = Math.max(0, (scale * content.width - stage.width) / 2);
  const limitY = Math.max(0, (scale * content.height - stage.height) / 2);
  return {
    x: Math.min(limitX, Math.max(-limitX, pan.x)),
    y: Math.min(limitY, Math.max(-limitY, pan.y)),
  };
}
