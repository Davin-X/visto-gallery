/// <reference types="vitest/globals" />
import { compareRows, differenceCount } from "./compare";
import type { MediaItem } from "../types/media";

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "a",
    path: "/Users/dev/Pictures/beach.jpg",
    name: "beach.jpg",
    extension: "jpg",
    kind: "photo",
    size: 4_000_000,
    modifiedAt: 1_700_000_000_000,
    width: 4032,
    height: 3024,
    favorite: false,
    hidden: false,
    isAnimated: false,
    tags: [],
    albumIds: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const row = (rows: ReturnType<typeof compareRows>, label: string) => {
  const found = rows.find((entry) => entry.label === label);
  if (!found) throw new Error(`missing row ${label}`);
  return found;
};

test("flags the fields that actually differ", () => {
  const keeper = item({ id: "k", name: "keeper.jpg", camera: "X-T5" });
  const copy = item({
    id: "c",
    name: "copy.jpg",
    path: "/Volumes/Card/copy.jpg",
    size: 4_100_000,
    camera: "X-T5",
  });

  const rows = compareRows(keeper, copy);

  expect(row(rows, "File").differs).toBe(true);
  expect(row(rows, "Folder").differs).toBe(true);
  expect(row(rows, "Size").differs).toBe(true);
  expect(row(rows, "Camera").differs).toBe(false);
  expect(row(rows, "Dimensions").differs).toBe(false);
  expect(differenceCount(rows)).toBe(3);
});

test("survives null optional fields (the backend sends null, not undefined)", () => {
  // Regression: a photo without GPS crashed the compare view with
  // "null is not an object (evaluating 'item.latitude.toFixed')".
  const bare = {
    ...item(),
    latitude: null,
    longitude: null,
    camera: null,
    iso: null,
    rating: null,
    sha256: null,
    width: null,
    height: null,
    capturedAt: null,
  } as unknown as MediaItem;

  const rows = compareRows(bare, bare);

  expect(row(rows, "Location").keeper).toBe("—");
  expect(row(rows, "Camera").keeper).toBe("—");
  expect(row(rows, "Hash").keeper).toBe("—");
  expect(row(rows, "Dimensions").keeper).toBe("—");
  expect(row(rows, "Captured").keeper).toBe("—");
  expect(differenceCount(rows)).toBe(0);
});

test("treats a missing value on one side as a difference", () => {
  const rows = compareRows(item({ iso: 200 }), item({}));
  expect(row(rows, "ISO").keeper).toBe("200");
  expect(row(rows, "ISO").copy).toBe("—");
  expect(row(rows, "ISO").differs).toBe(true);
});

test("formats size, dimensions and location for reading, not for debugging", () => {
  const rows = compareRows(
    item({ latitude: 48.8584, longitude: 2.2945, extension: "heic" }),
    item({ latitude: 48.8584, longitude: 2.2945, extension: "heic" }),
  );

  expect(row(rows, "Size").keeper).toMatch(/MB/);
  expect(row(rows, "Dimensions").keeper).toBe("4032 × 3024");
  expect(row(rows, "Format").keeper).toBe("HEIC");
  expect(row(rows, "Location").keeper).toBe("48.8584, 2.2945");
  expect(differenceCount(rows)).toBe(0);
});

test("a matching group reports zero differences", () => {
  const rows = compareRows(item({ id: "k" }), item({ id: "c" }));
  // ids are not a compared field, so identical files agree on every row.
  expect(differenceCount(rows)).toBe(0);
});
