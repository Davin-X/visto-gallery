/// <reference types="vitest/globals" />
import { displayFileName, splitForMiddleTruncation } from "./fileName";

test("extension is hidden or shown, never doubled", () => {
  expect(displayFileName("IMG_0042.HEIC", "heic", false)).toBe("IMG_0042");
  expect(displayFileName("IMG_0042.HEIC", "heic", true)).toBe("IMG_0042.HEIC");
  expect(displayFileName("archive.tar.gz", "gz", false)).toBe("archive.tar");
  expect(displayFileName(".jpg", "jpg", false)).toBe(".jpg");
  expect(displayFileName("noext", "", false)).toBe("noext");
});

test("long names keep their distinguishing end", () => {
  expect(splitForMiddleTruncation("short-name")).toEqual(["short-name", ""]);
  const [head, tail] = splitForMiddleTruncation("selective-focus-shot-of-red-berries-0042");
  expect(tail).toBe("rries-0042");
  expect(head + tail).toBe("selective-focus-shot-of-red-berries-0042");
});
