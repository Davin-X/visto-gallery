import { describe, expect, it } from "vitest";
import { isFolderInLibrary, parentFolder } from "./openWith";

describe("parentFolder", () => {
  it("drops the file name", () => {
    expect(parentFolder("/Users/me/Pictures/IMG_1.jpg")).toBe("/Users/me/Pictures");
  });

  it("ignores a trailing slash", () => {
    expect(parentFolder("/Users/me/Pictures/")).toBe("/Users/me");
  });

  it("keeps the root folder", () => {
    expect(parentFolder("/IMG_1.jpg")).toBe("/");
  });
});

describe("isFolderInLibrary", () => {
  it("matches a source folder", () => {
    expect(isFolderInLibrary("/Users/me/Pictures", ["/Users/me/Pictures"])).toBe(true);
  });

  it("matches a folder inside a source", () => {
    expect(isFolderInLibrary("/Users/me/Pictures/Trip", ["/Users/me/Pictures"])).toBe(true);
  });

  it("ignores a trailing slash on either side", () => {
    expect(isFolderInLibrary("/Users/me/Pictures/", ["/Users/me/Pictures/"])).toBe(true);
  });

  it("does not match a sibling that only shares a prefix", () => {
    expect(isFolderInLibrary("/Users/me/Pictures-old", ["/Users/me/Pictures"])).toBe(false);
  });

  it("is false when nothing is indexed", () => {
    expect(isFolderInLibrary("/Users/me/Pictures", [])).toBe(false);
  });
});
