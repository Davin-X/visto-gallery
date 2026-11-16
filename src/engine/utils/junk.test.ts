import { describe, expect, it } from "vitest";
import {
  allItems,
  allSelected,
  lastUsedLabel,
  percent,
  pruneSelection,
  recentlyUsed,
  regenerableIds,
  reportOf,
  selectedBytes,
  someSelected,
  totalBytes,
  type CategoryScan,
} from "./junk";
import type { JunkCategoryReport, JunkItem } from "../types/commands";

function item(overrides: Partial<JunkItem> & { id: string }): JunkItem {
  return {
    category: "xcode",
    label: overrides.id,
    detail: "",
    path: `/tmp/${overrides.id}`,
    bytes: 0,
    sharedBytes: 0,
    fileCount: 1,
    lastUsedAt: null,
    tier: "regenerable",
    ...overrides,
  };
}

function report(items: JunkItem[]): JunkCategoryReport {
  return {
    category: items[0]?.category ?? "xcode",
    status: "complete",
    statusMessage: null,
    items,
    skips: [],
    totalBytes: totalBytes(items),
    scannedAt: 0,
  };
}

describe("junk helpers", () => {
  it("collects items in screen order, keeping the previous report while rescanning", () => {
    const xcode = item({ id: "derived", category: "xcode", bytes: 30 });
    const npm = item({ id: "npm", category: "packages", bytes: 20 });
    const installer = item({ id: "dmg", category: "downloads", bytes: 10 });
    const scans: Record<string, CategoryScan> = {
      downloads: { state: "done", report: report([installer]) },
      packages: { state: "scanning", previous: report([npm]) },
      xcode: { state: "done", report: report([xcode]) },
      projects: { state: "failed", message: "nope" },
    };
    expect(allItems(scans).map((entry) => entry.id)).toEqual(["derived", "npm", "dmg"]);
    expect(reportOf({ state: "idle" })).toBeUndefined();
  });

  it("sums by tier and picks only regenerable ids", () => {
    const items = [
      item({ id: "a", bytes: 100 }),
      item({ id: "b", bytes: 200, tier: "rebuildable" }),
      item({ id: "c", bytes: 300 }),
    ];
    expect(totalBytes(items)).toBe(600);
    expect(totalBytes(items, "regenerable")).toBe(400);
    expect(regenerableIds(items)).toEqual(["a", "c"]);
  });

  it("counts only selected bytes and ignores unknown ids", () => {
    const items = [item({ id: "a", bytes: 100 }), item({ id: "b", bytes: 200 })];
    expect(selectedBytes(items, new Set(["a", "missing"]))).toBe(100);
  });

  it("tracks whole and partial group selection", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    expect(allSelected(items, new Set(["a", "b"]))).toBe(true);
    expect(allSelected(items, new Set(["a"]))).toBe(false);
    expect(someSelected(items, new Set(["a"]))).toBe(true);
    expect(allSelected([], new Set())).toBe(false);
  });

  it("forgets selected ids that vanished after a rescan", () => {
    expect([...pruneSelection(new Set(["a", "gone"]), [item({ id: "a" })])]).toEqual(["a"]);
  });

  it("labels last use coarsely and flags the last week", () => {
    const now = Date.UTC(2026, 10, 16);
    const day = 24 * 60 * 60 * 1000;
    expect(lastUsedLabel(null, now)).toBe("last use unknown");
    expect(lastUsedLabel(now, now)).toBe("used today");
    expect(lastUsedLabel(now - day, now)).toBe("used yesterday");
    expect(lastUsedLabel(now - 5 * day, now)).toBe("used 5 days ago");
    expect(lastUsedLabel(now - 65 * day, now)).toBe("used 2 months ago");
    expect(lastUsedLabel(now - 800 * day, now)).toBe("used 2 years ago");
    expect(recentlyUsed(item({ id: "a", lastUsedAt: now - 2 * day }), now)).toBe(true);
    expect(recentlyUsed(item({ id: "b", lastUsedAt: now - 9 * day }), now)).toBe(false);
  });

  it("never produces a broken percentage", () => {
    expect(percent(1, 0)).toBe("0%");
    expect(percent(-5, 10)).toBe("0%");
    expect(percent(5, 10)).toBe("50.00%");
    expect(percent(50, 10)).toBe("100.00%");
  });
});
