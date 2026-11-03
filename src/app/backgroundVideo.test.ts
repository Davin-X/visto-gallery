/// <reference types="vitest/globals" />
import { describe, expect, test } from "vitest";
import { getAdjacentVideo } from "./backgroundVideo";
import type { MediaItem } from "../engine/types/media";

const item = (id: string, kind: MediaItem["kind"]): MediaItem => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  extension: kind === "video" ? "mp4" : "jpg",
  kind,
  size: 1,
  modifiedAt: 1,
  favorite: false,
  hidden: false,
  tags: [],
  albumIds: [],
  createdAt: 1,
  updatedAt: 1,
});

describe("video queue navigation", () => {
  const queue = [
    item("video-a", "video"),
    item("video-b", "video"),
    item("video-c", "video"),
  ];

  test("advances from the active video even if the viewer selection is a photo", () => {
    expect(getAdjacentVideo(queue, "video-b", 1)).toBe(queue[2]);
  });

  test("wraps in both directions", () => {
    expect(getAdjacentVideo(queue, "video-c", 1)).toBe(queue[0]);
    expect(getAdjacentVideo(queue, "video-a", -1)).toBe(queue[2]);
  });

  test("uses a deterministic end of queue when current video is missing", () => {
    expect(getAdjacentVideo(queue, "not-in-queue", 1)).toBe(queue[0]);
    expect(getAdjacentVideo(queue, "not-in-queue", -1)).toBe(queue[2]);
  });

  test("returns null for an empty queue", () => {
    expect(getAdjacentVideo([], null, 1)).toBeNull();
  });
});
