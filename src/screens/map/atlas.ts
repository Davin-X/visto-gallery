import countries from "./countries.json";
import { mapScale, type MapSize, type MapView } from "./geometry";

// Natural Earth 1:110m Admin 0 countries, v5.1.2, public domain.
// Country polygon rings retain their geometry, rounded to three decimal places.
// https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2/geojson
let land: Path2D | undefined;

function landPath(): Path2D {
  if (land) return land;
  land = new Path2D();
  for (const polygon of countries) {
    for (const ring of polygon) {
      const [[longitude, latitude], ...points] = ring;
      land.moveTo(longitude, -latitude);
      for (const [x, y] of points) land.lineTo(x, -y);
      land.closePath();
    }
  }
  return land;
}

export function drawAtlas(canvas: HTMLCanvasElement, view: MapView, size: MapSize) {
  const scale = mapScale(size, view.zoom);
  if (!scale) return;
  const context = canvas.getContext("2d");
  if (!context) return;

  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(size.width * ratio);
  canvas.height = Math.round(size.height * ratio);
  context.scale(ratio, ratio);

  const css = getComputedStyle(canvas);
  context.translate(
    size.width / 2 - view.longitude * scale,
    size.height / 2 + view.latitude * scale,
  );
  context.scale(scale, scale);
  context.lineWidth = 0.7 / scale;
  const shapes = landPath();
  context.fillStyle = css.getPropertyValue("--map-land").trim();
  context.fill(shapes, "evenodd");
  context.strokeStyle = css.getPropertyValue("--map-coast").trim();
  context.stroke(shapes);
}
