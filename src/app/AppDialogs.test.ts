import { describe, expect, it } from "vitest";
import { describeTrashTargets } from "./AppDialogs";

describe("describeTrashTargets", () => {
  it("names a single item", () => {
    expect(describeTrashTargets(1, ["beach.jpg"])).toBe("“beach.jpg”");
  });

  it("lists up to three names", () => {
    expect(describeTrashTargets(3, ["a.jpg", "b.jpg", "c.mov"])).toBe(
      "“a.jpg”, “b.jpg” and “c.mov”",
    );
  });

  it("names two and counts the rest beyond three", () => {
    expect(describeTrashTargets(12, ["a.jpg", "b.jpg", "c.jpg"])).toBe(
      "“a.jpg”, “b.jpg” and 10 more",
    );
  });

  it("falls back to the count when names are unknown", () => {
    expect(describeTrashTargets(1, [""])).toBe("1 item");
    expect(describeTrashTargets(40, ["a.jpg", ""])).toBe("40 items");
  });
});
