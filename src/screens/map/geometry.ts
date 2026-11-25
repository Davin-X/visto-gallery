import type { PhotoLocation } from "../../engine/types/commands";

export interface MapView {
  latitude: number;
  longitude: number;
  zoom: number;
}

export interface MapSize {
  width: number;
  height: number;
}

export const WORLD_VIEW: MapView = { latitude: 0, longitude: 0, zoom: 1 };
export const MAX_ZOOM = 32;
const MAP_PADDING = 20;

export function mapScale({ width, height }: MapSize, zoom: number): number {
  return (
    Math.max(0, Math.min((width - 2 * MAP_PADDING) / 360, (height - 2 * MAP_PADDING) / 180)) * zoom
  );
}

export function moveMap(
  view: MapView,
  latitude: number,
  longitude: number,
  size: MapSize,
): MapView {
  const scale = mapScale(size, view.zoom);
  if (!scale) return view;
  // At the overview the map is centered. At closer scales keep its edges in view.
  const longitudeLimit = Math.max(0, 180 - (size.width / 2 - MAP_PADDING) / scale);
  const latitudeLimit = Math.max(0, 90 - (size.height / 2 - MAP_PADDING) / scale);
  const nextLatitude = Math.max(-latitudeLimit, Math.min(latitudeLimit, latitude));
  const nextLongitude = Math.max(-longitudeLimit, Math.min(longitudeLimit, longitude));
  if (nextLatitude === view.latitude && nextLongitude === view.longitude) return view;
  return {
    ...view,
    latitude: nextLatitude,
    longitude: nextLongitude,
  };
}

export function project(latitude: number, longitude: number, view: MapView, size: MapSize) {
  const scale = mapScale(size, view.zoom);
  return {
    x: size.width / 2 + (longitude - view.longitude) * scale,
    y: size.height / 2 - (latitude - view.latitude) * scale,
  };
}

interface Cluster {
  x: number;
  y: number;
  photos: PhotoLocation[];
}

export function clustersInView(photos: PhotoLocation[], view: MapView, size: MapSize): Cluster[] {
  if (!size.width || !size.height) return [];
  const scale = mapScale(size, view.zoom);
  if (!scale) return [];
  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;
  const clusters = new Map<string, Cluster>();
  const cellSize = 48;
  const edgePad = 16;
  for (const photo of photos) {
    const x = halfWidth + (photo.longitude - view.longitude) * scale;
    const y = halfHeight - (photo.latitude - view.latitude) * scale;
    if (x < -edgePad || y < -edgePad || x > size.width + edgePad || y > size.height + edgePad) {
      continue;
    }
    const key = `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
    const cluster = clusters.get(key);
    if (cluster) {
      const count = cluster.photos.length;
      cluster.x = (cluster.x * count + x) / (count + 1);
      cluster.y = (cluster.y * count + y) / (count + 1);
      cluster.photos.push(photo);
    } else {
      clusters.set(key, { x, y, photos: [photo] });
    }
  }
  return [...clusters.values()];
}

// Zoom by `factor`, keeping the coordinate under `point` (canvas pixels) in place.
export function zoomAt(
  view: MapView,
  factor: number,
  point: { x: number; y: number },
  size: MapSize,
): MapView {
  const scale = mapScale(size, view.zoom);
  const zoom = Math.max(1, Math.min(MAX_ZOOM, view.zoom * factor));
  const next = mapScale(size, zoom);
  if (!scale || zoom === view.zoom) return view;
  const dx = point.x - size.width / 2;
  const dy = point.y - size.height / 2;
  return moveMap(
    { ...view, zoom },
    view.latitude - dy / scale + dy / next,
    view.longitude + dx / scale - dx / next,
    size,
  );
}

// Country-level detail is the most the 1:110m atlas can show.
const FIT_MAX_ZOOM = 8;
const FIT_MARGIN = 60;

export function fitView(photos: PhotoLocation[], size: MapSize): MapView {
  const scale = mapScale(size, 1);
  if (!photos.length || !scale) return WORLD_VIEW;
  let [south, north, west, east] = [90, -90, 180, -180];
  for (const { latitude, longitude } of photos) {
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
  }
  const zoom = Math.max(
    1,
    Math.min(
      FIT_MAX_ZOOM,
      (size.width - 2 * FIT_MARGIN) / ((east - west) * scale),
      (size.height - 2 * FIT_MARGIN) / ((north - south) * scale),
    ),
  );
  return moveMap({ ...WORLD_VIEW, zoom }, (south + north) / 2, (west + east) / 2, size);
}
