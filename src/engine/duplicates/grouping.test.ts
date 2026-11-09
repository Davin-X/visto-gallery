import { describe, expect, test } from "vitest";
import type { DuplicateGroup, MediaItem } from "../types/media";
import { buildGroupViews, keeperQuality, orderGroup } from "./grouping";

function makeItem(overrides: Partial<MediaItem> & { id: string }): MediaItem {
  const { id, ...rest } = overrides;
  return {
    name: `${id}.jpg`,
    path: `/photos/${id}.jpg`,
    extension: "jpg",
    size: 1000,
    kind: "photo",
    createdAt: 100,
    modifiedAt: 100,
    width: 1000,
    height: 1000,
    ...rest,
    id,
  } as MediaItem;
}

function makeGroup(items: MediaItem[]): DuplicateGroup {
  return { id: `group-${items[0].id}`, sha256: "hash", size: items[0].size, items };
}

describe("keeperQuality", () => {
  test("ranks RAW above TIFF, PNG, and JPEG", () => {
    const raw = keeperQuality(makeItem({ id: "raw", kind: "raw", extension: "cr2" }));
    const tiff = keeperQuality(makeItem({ id: "tiff", extension: "tiff" }));
    const png = keeperQuality(makeItem({ id: "png", extension: "png" }));
    const jpg = keeperQuality(makeItem({ id: "jpg", extension: "jpg" }));

    // Higher format tier always wins, regardless of pixel count.
    expect(raw[0]).toBeGreaterThan(tiff[0]);
    expect(tiff[0]).toBeGreaterThan(png[0]);
    expect(png[0]).toBeGreaterThan(jpg[0]);
  });

  test("falls back to pixels and then size within one format", () => {
    const big = keeperQuality(makeItem({ id: "big", width: 4000, height: 3000, size: 100 }));
    const small = keeperQuality(makeItem({ id: "small", width: 100, height: 100, size: 900 }));
    expect(big[1]).toBeGreaterThan(small[1]);
    expect(big[2]).toBeLessThan(small[2]);
  });
});

describe("orderGroup", () => {
  test("best quality is the keeper even when it is the newest file", () => {
    const jpgNew = makeItem({ id: "new-jpg", createdAt: 900 });
    const rawOld = makeItem({ id: "old-raw", kind: "raw", extension: "cr2", createdAt: 10 });

    expect(orderGroup([jpgNew, rawOld], "best")[0].id).toBe("old-raw");
  });

  test("oldest and newest keepers are opposites", () => {
    const old = makeItem({ id: "old", createdAt: 10 });
    const recent = makeItem({ id: "recent", createdAt: 900 });

    expect(orderGroup([recent, old], "oldest")[0].id).toBe("old");
    expect(orderGroup([old, recent], "newest")[0].id).toBe("recent");
  });

  test("identical copies order stably by path then name then id", () => {
    const a = makeItem({ id: "a", path: "/b/x.jpg", name: "x.jpg" });
    const b = makeItem({ id: "b", path: "/a/x.jpg", name: "x.jpg" });

    const first = orderGroup([a, b], "best").map((item) => item.id);
    const second = orderGroup([b, a], "best").map((item) => item.id);

    expect(first).toEqual(second);
  });

  test("does not mutate the input array", () => {
    const items = [makeItem({ id: "a", createdAt: 10 }), makeItem({ id: "b", createdAt: 900 })];
    const snapshot = items.map((item) => item.id);

    orderGroup(items, "newest");

    expect(items.map((item) => item.id)).toEqual(snapshot);
  });
});

describe("buildGroupViews", () => {
  const photo = makeItem({ id: "photo", kind: "photo" });
  const video = makeItem({ id: "video", kind: "video", extension: "mov" });

  test("every copy except the keeper counts as reclaimable", () => {
    const views = buildGroupViews([makeGroup([photo, video])], {
      filterKind: "all",
      keeperMode: "best",
      sortBy: "saving",
    });

    expect(views).toHaveLength(1);
    expect(views[0].keeper.id).toBe("photo");
    expect(views[0].copies.map((item) => item.id)).toEqual(["video"]);
    expect(views[0].reclaimable).toBe(video.size);
  });

  test("a kind filter drops groups without that kind", () => {
    const views = buildGroupViews([makeGroup([photo, video])], {
      filterKind: "raw",
      keeperMode: "best",
      sortBy: "saving",
    });

    expect(views).toEqual([]);
  });

  test("sorts by largest saving by default", () => {
    const small = makeGroup([makeItem({ id: "s1" }), makeItem({ id: "s2", size: 10 })]);
    const large = makeGroup([makeItem({ id: "l1" }), makeItem({ id: "l2", size: 9000 })]);

    const views = buildGroupViews([small, large], {
      filterKind: "all",
      keeperMode: "best",
      sortBy: "saving",
    });

    expect(views.map((view) => view.group.id)).toEqual([large.id, small.id]);
  });
});
