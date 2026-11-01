import { describe, expect, it } from "vitest";
import {
  makeAlbum,
  makeDuplicateGroup,
  makeLibraryFixture,
  makeLibraryFolder,
  makeLibraryItemsPage,
  makeLibraryStats,
  makeMediaItem,
  makeTag,
} from "./fixtures";
import type { MediaItem } from "../engine/types/media";
import type { LibraryStats } from "../engine/types/commands";

describe("makeMediaItem", () => {
  it("returns a full MediaItem with sensible defaults", () => {
    const item = makeMediaItem();
    expect(item.id).toBe("item-1");
    expect(item.kind).toBe("photo");
    expect(item.favorite).toBe(false);
    expect(item.hidden).toBe(false);
    expect(item.tags).toEqual([]);
    expect(item.albumIds).toEqual([]);
  });

  it("applies overrides", () => {
    const item = makeMediaItem({
      id: "custom",
      name: "sunset.jpg",
      kind: "video",
      favorite: true,
      size: 5000,
    });
    expect(item.id).toBe("custom");
    expect(item.name).toBe("sunset.jpg");
    expect(item.kind).toBe("video");
    expect(item.favorite).toBe(true);
    expect(item.size).toBe(5000);
    // Non-overridden fields keep defaults.
    expect(item.extension).toBe("jpg");
    expect(item.hidden).toBe(false);
  });

  it("produces independent objects", () => {
    const a = makeMediaItem({ id: "a" });
    const b = makeMediaItem({ id: "b" });
    expect(a).not.toBe(b);
    a.favorite = true;
    expect(b.favorite).toBe(false);
  });
});

describe("makeAlbum", () => {
  it("returns a full Album with sensible defaults", () => {
    const album = makeAlbum();
    expect(album.itemIds).toEqual([]);
    expect(album.itemCount).toBe(0);
  });

  it("applies overrides", () => {
    const album = makeAlbum({ name: "Nature", itemCount: 3, colorIndex: 2 });
    expect(album.name).toBe("Nature");
    expect(album.itemCount).toBe(3);
    expect(album.colorIndex).toBe(2);
  });
});

describe("makeTag", () => {
  it("returns a full Tag with sensible defaults", () => {
    const tag = makeTag();
    expect(tag.itemCount).toBe(0);
    expect(tag.colorIndex).toBe(0);
  });

  it("applies overrides", () => {
    const tag = makeTag({ name: "Nature", itemCount: 5, colorIndex: 1 });
    expect(tag.name).toBe("Nature");
    expect(tag.itemCount).toBe(5);
    expect(tag.colorIndex).toBe(1);
  });
});

describe("makeLibraryFolder", () => {
  it("returns a full LibraryFolder", () => {
    const folder = makeLibraryFolder();
    expect(folder.path).toBe("/tmp/Photos");
    expect(folder.itemCount).toBe(0);
    expect(folder.totalSize).toBe(0);
  });

  it("applies overrides", () => {
    const folder = makeLibraryFolder({
      path: "/tmp/Movies",
      name: "Movies",
      itemCount: 10,
      totalSize: 5000,
    });
    expect(folder.path).toBe("/tmp/Movies");
    expect(folder.name).toBe("Movies");
    expect(folder.itemCount).toBe(10);
    expect(folder.totalSize).toBe(5000);
  });
});

describe("makeLibraryItemsPage", () => {
  it("returns an empty page by default", () => {
    const page = makeLibraryItemsPage();
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.totalCount).toBe(0);
  });

  it("applies overrides", () => {
    const item = makeMediaItem({ id: "x" });
    const page = makeLibraryItemsPage({
      items: [item],
      hasMore: true,
      totalCount: 10,
    });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.totalCount).toBe(10);
  });
});

describe("makeDuplicateGroup", () => {
  it("returns a full DuplicateGroup", () => {
    const group = makeDuplicateGroup();
    expect(group.sha256).toBe("abc123");
    expect(group.items).toEqual([]);
  });

  it("applies overrides", () => {
    const item = makeMediaItem({ id: "dup-1" });
    const group = makeDuplicateGroup({
      sha256: "deadbeef",
      items: [item, item],
    });
    expect(group.sha256).toBe("deadbeef");
    expect(group.items).toHaveLength(2);
  });
});

describe("makeLibraryStats", () => {
  it("returns zeroed stats by default", () => {
    const stats = makeLibraryStats();
    expect(stats.photos).toBe(0);
    expect(stats.totalSize).toBe(0);
  });

  it("applies overrides", () => {
    const stats = makeLibraryStats({ photos: 5, totalSize: 12345 });
    expect(stats.photos).toBe(5);
    expect(stats.totalSize).toBe(12345);
  });
});

describe("makeLibraryFixture", () => {
  it("builds a self-consistent library with exact counts", () => {
    // Specify ALL counts so defaults don't add extra items.
    const { items, albums, tags, folders } = makeLibraryFixture({
      itemCount: 5,
      photoCount: 3,
      videoCount: 1,
      rawCount: 1,
      hiddenCount: 0,
    });
    expect(items.length).toBe(5);
    expect(albums.length).toBe(2);
    expect(tags.length).toBe(2);
    expect(folders.length).toBe(2);
  });

  it("counts kinds correctly", () => {
    // Hidden items are kind "photo" too, so photos includes hidden.
    const { items } = makeLibraryFixture({
      itemCount: 6,
      photoCount: 3,
      videoCount: 1,
      rawCount: 1,
      hiddenCount: 1,
    });
    const photos = items.filter((i) => i.kind === "photo").length;
    const videos = items.filter((i) => i.kind === "video").length;
    const raws = items.filter((i) => i.kind === "raw").length;
    const hidden = items.filter((i) => i.hidden).length;
    // 3 visible photos + 1 hidden photo = 4 photos total.
    expect(photos).toBe(4);
    expect(videos).toBe(1);
    expect(raws).toBe(1);
    expect(hidden).toBe(1);
  });

  it("fills remaining slots with photos when itemCount exceeds specified", () => {
    // Only specify photoCount; video/raw/hidden default to 1 each.
    const { items } = makeLibraryFixture({
      itemCount: 10,
      photoCount: 1,
      videoCount: 0,
      rawCount: 0,
      hiddenCount: 0,
    });
    expect(items.length).toBe(10);
    const nonPhoto = items.filter((i) => i.kind !== "photo").length;
    expect(nonPhoto).toBe(0);
  });

  it("all items are valid MediaItem shapes", () => {
    const { items } = makeLibraryFixture({ itemCount: 20 });
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.path).toBe("string");
      expect(typeof item.name).toBe("string");
      expect(["photo", "video", "raw"]).toContain(item.kind);
      expect(typeof item.size).toBe("number");
      expect(Array.isArray(item.tags)).toBe(true);
      expect(Array.isArray(item.albumIds)).toBe(true);
    }
  });

  it("produces independent objects across calls", () => {
    const a = makeLibraryFixture({ itemCount: 5 });
    const b = makeLibraryFixture({ itemCount: 5 });
    expect(a.items).not.toBe(b.items);
    // Use a non-default favorite value to verify independence.
    a.items[2].favorite = true;
    expect(b.items[2].favorite).toBe(false);
  });

  it("produces independent arrays across calls", () => {
    const a = makeLibraryFixture({ itemCount: 3 });
    const b = makeLibraryFixture({ itemCount: 3 });
    a.items.push(makeMediaItem({ id: "extra" }));
    expect(b.items).toHaveLength(a.items.length - 1);
  });
});
