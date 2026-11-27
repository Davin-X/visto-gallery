import type { LibraryState } from "../../engine/stores/library/types";
import { libraryViewKey } from "../../engine/stores/library/filters";
import type { MediaItem } from "../../engine/types/media";
import { itemMonthKey } from "../../engine/utils/mediaDate";

export interface MonthPage {
  items: MediaItem[];
  nextCursor: string | null;
}
export interface MonthCache {
  view: string;
  pages: Map<string, MonthPage>;
}

export function timelineKey(state: LibraryState, hidden: boolean) {
  return hidden
    ? JSON.stringify(["hidden", state.hiddenFilter, state.hiddenQuery, state.hiddenCount])
    : libraryViewKey(state) + "|" + state.totalCount;
}

export function scopedPages(state: LibraryState, hidden: boolean) {
  const cache = state.timelineCache;
  return state.layout === "timeline" && cache?.view === timelineKey(state, hidden)
    ? cache.pages
    : undefined;
}

export function groupLoaded(items: MediaItem[], pages?: Map<string, MonthPage>) {
  const groups = new Map<string, MediaItem[]>();
  for (const item of items) {
    const key = itemMonthKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const [key, page] of pages ?? []) {
    // The month query uses the same order as the library. Both lists start
    // at the beginning of the month and can overlap the first library page.
    const base = groups.get(key);
    if (!base || page.items.length >= base.length) groups.set(key, page.items);
  }
  return groups;
}

export function timelineViewerItems(state: LibraryState, base: MediaItem[]) {
  if (state.viewerScope === "map") return base;
  const pages = scopedPages(state, state.viewerScope === "hidden");
  if (!pages?.size) return base;
  const groups = groupLoaded(base, pages);
  return [...groups.keys()]
    .sort()
    .reverse()
    .flatMap((key) => groups.get(key)!);
}

export function cachedItem(state: LibraryState, hidden: boolean, id?: string | null) {
  for (const page of scopedPages(state, hidden)?.values() ?? []) {
    const match = page.items.find((item) => item.id === id);
    if (match) return match;
  }
}
