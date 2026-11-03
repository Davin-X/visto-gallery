/// <reference types="vitest/globals" />
import { describe, expect, test } from "vitest";
import { endOfLocalDay, startOfLocalDay, toDateInputValue } from "./dateRange";

describe("capture date range", () => {
  test("covers the whole selected local day inclusively", () => {
    const start = startOfLocalDay("2024-03-15")!;
    const end = endOfLocalDay("2024-03-15")!;
    const startDate = new Date(start);
    const endDate = new Date(end);

    expect(startDate.getFullYear()).toBe(2024);
    expect(startDate.getMonth()).toBe(2);
    expect(startDate.getDate()).toBe(15);
    expect(startDate.getHours()).toBe(0);
    expect(endDate.getDate()).toBe(15);
    expect(endDate.getHours()).toBe(23);
    expect(endDate.getMinutes()).toBe(59);
    expect(endDate.getSeconds()).toBe(59);
    expect(endDate.getMilliseconds()).toBe(999);
    expect(start).toBeLessThan(end);
  });

  test("invalid or empty values clear the bound", () => {
    expect(startOfLocalDay("")).toBeNull();
    expect(endOfLocalDay("not-a-date")).toBeNull();
    expect(startOfLocalDay("2024-13-40")).toBeNull();
  });

  test("round-trips a timestamp for the date input", () => {
    const timestamp = new Date(2025, 0, 9, 18, 30).getTime();
    expect(toDateInputValue(timestamp)).toBe("2025-01-09");
    expect(toDateInputValue(null)).toBe("");
  });
});
