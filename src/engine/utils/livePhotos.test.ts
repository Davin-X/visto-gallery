import { describe, it, expect } from "vitest";
import { livePhotoMotionMap } from "./livePhotos";
import type { MediaItem } from "../types/media";

function item(overrides: Partial<MediaItem>): MediaItem {
  return {
    id: "id",
    path: "/lib/IMG_1.HEIC",
    name: "IMG_1.HEIC",
    title: null,
    extension: "heic",
    kind: "photo",
    size: 1,
    modified_at: 0,
    captured_at: null,
    width: null,
    height: null,
    camera: null,
    lens: null,
    exposure: null,
    iso: null,
    latitude: null,
    longitude: null,
    sha256: null,
    favorite: false,
    hidden: false,
    hidden_reason: null,
    is_animated: false,
    content_signature: null,
    rating: null,
    color_label: null,
    import_session_id: null,
    created_at: 0,
    updated_at: 0,
    tags: [],
    album_ids: [],
    ...overrides,
  } as MediaItem;
}

describe("livePhotoMotionMap", () => {
  it("pairs HEIC with same-stem MOV in the same folder", () => {
    const heic = item({ id: "h", path: "/lib/IMG_1.HEIC", name: "IMG_1.HEIC" });
    const mov = item({
      id: "m",
      path: "/lib/IMG_1.MOV",
      name: "IMG_1.MOV",
      extension: "mov",
      kind: "video",
    });
    const map = livePhotoMotionMap([heic, mov]);
    expect(map.get("h")?.id).toBe("m");
  });

  it("does not pair across folders or stems", () => {
    const heic = item({ id: "h", path: "/lib/a/IMG_1.HEIC", name: "IMG_1.HEIC" });
    const mov = item({
      id: "m",
      path: "/lib/b/IMG_1.MOV",
      name: "IMG_1.MOV",
      extension: "mov",
      kind: "video",
    });
    const map = livePhotoMotionMap([heic, mov]);
    expect(map.has("h")).toBe(false);
  });
});
