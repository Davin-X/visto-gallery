import { describe, expect, it } from "vitest";
import type { PhotoLocation } from "../../engine/types/commands";
import { dateRange } from "./dates";

const at = (capturedAt: number | null, modifiedAt = 0): PhotoLocation => ({
  id: String(capturedAt),
  name: "a.jpg",
  latitude: 0,
  longitude: 0,
  capturedAt,
  modifiedAt,
});
const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

describe("dateRange", () => {
  it("spans oldest to newest capture date in any order", () => {
    const range = dateRange([at(day("2025-06-18")), at(day("2024-03-04")), at(day("2024-10-01"))]);
    expect(range).toMatch(/2024.*–.*2025/);
  });

  it("ignores file dates when any photo has a capture date", () => {
    expect(dateRange([at(day("2024-03-04")), at(null, day("2026-01-01"))])).not.toContain("2026");
  });

  it("falls back to file dates and collapses a single day", () => {
    expect(dateRange([at(null, day("2026-01-01")), at(null, day("2026-01-01"))])).not.toContain(
      "–",
    );
    expect(dateRange([])).toBe("");
  });
});
