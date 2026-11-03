/// <reference types="vitest/globals" />
import { describe, expect, test, vi } from "vitest";
import { copyTagsToFinder, dedupeTagNames } from "./finderTags";

describe("Finder tag merge", () => {
  test("deduplicates case-insensitively while keeping the first spelling", () => {
    expect(
      dedupeTagNames(["Travel", "travel", "  Family ", "", "FAMILY"]),
    ).toEqual(["Travel", "Family"]);
  });

  test("merges app tags for every file and reports per-file failures", async () => {
    const merge = vi.fn(async (path: string, tags: string[]) => {
      if (path === "/bad.jpg") throw new Error("Operation not permitted");
      return [...tags, "Existing Finder Tag"];
    });

    const result = await copyTagsToFinder(
      [
        { id: "1", path: "/a.jpg", tags: ["Travel", "travel"] },
        { id: "2", path: "/bad.jpg", tags: ["Family"] },
        { id: "3", path: "/empty.jpg", tags: [] },
      ],
      merge,
    );

    expect(merge).toHaveBeenCalledTimes(2);
    expect(merge).toHaveBeenCalledWith("/a.jpg", ["Travel"]);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual([
      { path: "/bad.jpg", error: "Operation not permitted" },
    ]);
    expect(result.tagsByPath["/a.jpg"]).toEqual([
      "Travel",
      "Existing Finder Tag",
    ]);
  });

  test("bounds concurrent Finder writes", async () => {
    let active = 0;
    let maxActive = 0;
    const merge = vi.fn(async (_path: string, tags: string[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return tags;
    });

    await copyTagsToFinder(
      Array.from({ length: 6 }, (_, index) => ({
        id: String(index),
        path: `/photo-${index}.jpg`,
        tags: [`Tag ${index}`],
      })),
      merge,
      2,
    );

    expect(merge).toHaveBeenCalledTimes(6);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
