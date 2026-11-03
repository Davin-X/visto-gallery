/// <reference types="vitest/globals" />
import { describe, expect, test } from "vitest";
import {
  getAdjacentVideo,
  planBackgroundVideo,
} from "./backgroundVideo";
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

describe("background video lifecycle planning", () => {
  const video = item("video", "video");
  const otherVideo = item("other-video", "video");
  const photo = item("photo", "photo");
  const otherPhoto = item("other-photo", "photo");

  test("closing the viewer clears the background player", () => {
    expect(
      planBackgroundVideo({
        isOpen: false,
        screen: "Library",
        selected: null,
        previous: video,
        current: video,
      }),
    ).toEqual({ background: null, previous: null, close: false });
  });

  test("a selected video owns playback with no background copy", () => {
    expect(
      planBackgroundVideo({
        isOpen: true,
        screen: "Viewer",
        selected: video,
        previous: photo,
        current: video,
      }),
    ).toEqual({ background: null, previous: video, close: false });
  });

  test("moving the viewer from a video to a photo keeps the video playing", () => {
    expect(
      planBackgroundVideo({
        isOpen: true,
        screen: "Viewer",
        selected: photo,
        previous: video,
        current: null,
      }),
    ).toEqual({ background: video, previous: photo, close: false });
  });

  test("navigating between photos keeps the existing background video", () => {
    expect(
      planBackgroundVideo({
        isOpen: true,
        screen: "Viewer",
        selected: otherPhoto,
        previous: photo,
        current: video,
      }),
    ).toEqual({ background: video, previous: otherPhoto, close: false });
  });

  test("adopting a second video replaces the first one", () => {
    expect(
      planBackgroundVideo({
        isOpen: true,
        screen: "Viewer",
        selected: otherVideo,
        previous: video,
        current: video,
      }),
    ).toEqual({ background: null, previous: otherVideo, close: false });
  });

  test("leaving the viewer freezes the last video selection", () => {
    expect(
      planBackgroundVideo({
        isOpen: true,
        screen: "Library",
        selected: photo,
        previous: video,
        current: null,
      }),
    ).toEqual({ background: video, previous: video, close: false });
  });

  test("a tab switch keeps an already-background video playing", () => {
    expect(
      planBackgroundVideo({
        isOpen: true,
        screen: "Albums",
        selected: otherPhoto,
        previous: photo,
        current: video,
      }),
    ).toEqual({ background: video, previous: photo, close: false });
  });

  test("a photo with nothing playing closes the viewer on tab switch", () => {
    expect(
      planBackgroundVideo({
        isOpen: true,
        screen: "Library",
        selected: photo,
        previous: photo,
        current: null,
      }),
    ).toEqual({ background: null, previous: photo, close: true });
  });
});
