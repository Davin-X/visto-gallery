import { expect, it } from "vitest";
import type { MediaItem } from "../../engine/types/media";
import { useLibraryStore } from "../../engine/stores/useLibraryStore";
import { groupLoaded, scopedPages, timelineKey } from "./monthCache";

it("replaces the overlapping partial month and retains the backend's order", () => {
  const item = (id: string) => ({ id, capturedAt: Date.UTC(2026, 0, 1) }) as MediaItem;
  const items = [item("a"), item("b")];
  const pages = new Map([["2026-01", { items, nextCursor: null }]]);
  expect(groupLoaded(items.slice(0, 1), pages).get("2026-01")).toEqual(items);
});

it("only reuses pages for the same catalog count, filter and scope", () => {
  const state = { ...useLibraryStore.getState(), layout: "timeline" as const };
  const pages = new Map();
  const loaded = { ...state, timelineCache: { view: timelineKey(state, false), pages } };
  expect(scopedPages(loaded, false)).toBe(pages);
  expect(scopedPages(loaded, true)).toBeUndefined();
  expect(scopedPages({ ...loaded, query: "other" }, false)).toBeUndefined();
  expect(scopedPages({ ...loaded, totalCount: state.totalCount + 1 }, false)).toBeUndefined();
});
