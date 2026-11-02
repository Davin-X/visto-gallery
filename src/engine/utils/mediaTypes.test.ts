/// <reference types="vitest/globals" />
import {
  getTypeIdentity,
  getKindBadgeClass,
  getKindDotClass,
  canPlayVideoInApp,
  fileExtension,
} from "./mediaTypes";

test("media types", () => {
  expect(getTypeIdentity("photo").label).toBe("Photo");
  expect(getKindBadgeClass("video")).toBe("kind-badge video");
  expect(getKindDotClass("raw")).toBe("kind-dot raw");
});

test("extension parsing ignores query strings", () => {
  expect(fileExtension("/lib/clip.MKV")).toBe("mkv");
  expect(fileExtension("asset://localhost/clip.mp4?x=1")).toBe("mp4");
  expect(fileExtension("no-extension")).toBe("");
  expect(fileExtension(undefined)).toBe("");
});

test("only WebKit-decodable video containers play in-app", () => {
  expect(canPlayVideoInApp("/lib/a.mp4")).toBe(true);
  expect(canPlayVideoInApp("/lib/a.MOV")).toBe(true);
  expect(canPlayVideoInApp("/lib/a.webm")).toBe(true);
  expect(canPlayVideoInApp("/lib/a.mkv")).toBe(false);
  expect(canPlayVideoInApp("/lib/a.avi")).toBe(false);
  expect(canPlayVideoInApp("/lib/a.m2ts")).toBe(false);
  // Items without an extension stay optimistic: the <video> error handler
  // still catches failures at playback time.
  expect(canPlayVideoInApp("")).toBe(true);
});
