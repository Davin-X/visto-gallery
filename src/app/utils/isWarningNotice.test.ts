/// <reference types="vitest/globals" />
import { isWarningNotice } from "./isWarningNotice";

describe("isWarningNotice", () => {
  test("matches known warning phrases (case-insensitive)", () => {
    expect(isWarningNotice("Failed to load thumbnail")).toBe(true);
    expect(isWarningNotice("Could not read directory")).toBe(true);
    expect(isWarningNotice("Cannot access that path")).toBe(true);
    expect(isWarningNotice("Not a folder")).toBe(true);
    expect(isWarningNotice("No media files found")).toBe(true);
    expect(isWarningNotice("No supported media in selection")).toBe(true);
  });

  test("does not match unrelated messages", () => {
    expect(isWarningNotice("Saved successfully")).toBe(false);
    expect(isWarningNotice("Scan complete")).toBe(false);
    expect(isWarningNotice("")).toBe(false);
  });
});
