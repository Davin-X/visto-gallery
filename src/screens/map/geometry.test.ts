import { describe, expect, it } from "vitest";
import type { PhotoLocation } from "../../engine/types/commands";
import {
  clustersInView,
  fitView,
  mapScale,
  moveMap,
  project,
  WORLD_VIEW,
  zoomAt,
} from "./geometry";

const size = { width: 760, height: 400 }; // scale at zoom 1 = min(720/360, 360/180) = 2

const photo = (id: string, latitude: number, longitude: number): PhotoLocation => ({
  id,
  name: `${id}.jpg`,
  latitude,
  longitude,
  capturedAt: null,
  modifiedAt: 0,
});

describe("map geometry", () => {
  it("computes scale and returns 0 when canvas is smaller than padding", () => {
    expect(mapScale({ width: 0, height: 0 }, 1)).toBe(0);
    expect(mapScale({ width: 40, height: 40 }, 4)).toBe(0);
    expect(mapScale(size, 1)).toBe(2);
    expect(mapScale(size, 4)).toBe(8);
  });

  it("keeps world view centered at zoom 1 and clamps panning at zoom > 1", () => {
    expect(moveMap(WORLD_VIEW, 45, -120, size)).toBe(WORLD_VIEW);

    const zoomed = { latitude: 0, longitude: 0, zoom: 2 };
    // scale = 4: longitudeLimit = 180 - 360/4 = 90, latitudeLimit = 90 - 180/4 = 45
    expect(moveMap(zoomed, 80, -150, size)).toEqual({
      latitude: 45,
      longitude: -90,
      zoom: 2,
    });
    expect(moveMap(zoomed, 0, 0, size)).toBe(zoomed);
  });

  it("projects coordinates around the viewport center", () => {
    expect(project(0, 0, WORLD_VIEW, size)).toEqual({ x: 380, y: 200 });
    expect(project(10, -20, WORLD_VIEW, size)).toEqual({ x: 340, y: 180 });
  });

  it("returns no clusters for a 0-size canvas", () => {
    const photos = [photo("a", 0, 0)];
    expect(clustersInView(photos, WORLD_VIEW, { width: 0, height: 0 })).toEqual([]);
    expect(clustersInView(photos, WORLD_VIEW, { width: 20, height: 20 })).toEqual([]);
  });

  it("filters out-of-viewport markers with edge padding and averages cluster centroids", () => {
    const zoomed = { latitude: 0, longitude: 0, zoom: 2 }; // scale = 4, center = (380, 200)
    const photos = [
      // Same 48px cell around center (cell 7:4): (380, 200) and (382, 204) -> centroid (381, 202)
      photo("c1", 0, 0),
      photo("c2", -1, 0.5),
      // Just outside left edge by 12px (within 16px pad): lon = -98 -> x = 380 - 392 = -12
      photo("edge-in", 0, -98),
      // Far outside left edge: lon = -110 -> x = 380 - 440 = -60
      photo("edge-out", 0, -110),
    ];

    const clusters = clustersInView(photos, zoomed, size);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toEqual({
      x: 381,
      y: 202,
      photos: [photos[0], photos[1]],
    });
    expect(clusters[1]).toEqual({
      x: -12,
      y: 200,
      photos: [photos[2]],
    });
  });

  it("zooms around the pointer and clamps to the zoom range", () => {
    // scale 2 -> 4: the point 100px right of center (lon 50) stays under the pointer
    const next = zoomAt(WORLD_VIEW, 2, { x: 480, y: 200 }, size);
    expect(next).toEqual({ latitude: 0, longitude: 25, zoom: 2 });
    expect(project(0, 50, next, size).x).toBe(480);
    expect(zoomAt(WORLD_VIEW, 0.5, { x: 0, y: 0 }, size)).toBe(WORLD_VIEW);
  });

  it("fits photos, capping the zoom for a single place", () => {
    expect(fitView([], size)).toBe(WORLD_VIEW);
    expect(fitView([photo("a", 48.8, 2.3)], size)).toEqual({
      latitude: 48.8,
      longitude: 2.3,
      zoom: 8,
    });
    // spans 40° x 20°: zoom = min(640 / 80, 280 / 40) = 7
    expect(fitView([photo("a", 0, 0), photo("b", 20, 40)], size)).toEqual({
      latitude: 10,
      longitude: 20,
      zoom: 7,
    });
  });
});
