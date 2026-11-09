import type { DuplicateGroup, MediaItem } from "../types/media";

/**
 * Pure duplicate-group logic: which copy is the keeper, how the copies are
 * ordered, and how the groups are filtered and sorted for display. Kept out of
 * the screen so it can be tested without rendering.
 */

/** How the keeper (the copy left alone) is chosen. */
export type KeeperMode = "best" | "oldest" | "newest";

export type DuplicatesKindFilter = "all" | "photo" | "video" | "raw";

export type DuplicatesSort = "saving" | "copies" | "newest" | "name";

export interface GroupView {
  group: DuplicateGroup;
  /** Keeper first, then every other copy. */
  ordered: MediaItem[];
  keeper: MediaItem;
  copies: MediaItem[];
  reclaimable: number;
  newest: number;
}

export interface GroupViewOptions {
  filterKind: DuplicatesKindFilter;
  keeperMode: KeeperMode;
  sortBy: DuplicatesSort;
}

/** Newest-first ordering is expressed as a negative "oldest" timestamp. */
export function copyOrderValue(item: MediaItem): number {
  return item.createdAt || item.modifiedAt || 0;
}

/** Prefer the least-lossy, highest-detail source before considering age. */
export function keeperQuality(item: MediaItem): [number, number, number] {
  const extension = item.extension.toLowerCase();
  const format =
    item.kind === "raw"
      ? 5
      : extension === "tif" || extension === "tiff"
        ? 4
        : extension === "png"
          ? 3
          : extension === "jpg" || extension === "jpeg" || extension === "heic"
            ? 2
            : 1;
  const pixels = Math.max(0, item.width ?? 0) * Math.max(0, item.height ?? 0);
  return [format, pixels, item.size];
}

/**
 * The backend stores hash groups in query order, so the first item is not
 * necessarily the original file. Order every group explicitly: the keeper
 * first (best quality, oldest or newest), then the rest by path so the list is
 * stable between scans.
 */
export function orderGroup(items: MediaItem[], keeperMode: KeeperMode): MediaItem[] {
  const direction = keeperMode === "oldest" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (keeperMode === "best") {
      const left = keeperQuality(a);
      const right = keeperQuality(b);
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return right[index] - left[index];
      }
    }
    const byAge = (copyOrderValue(a) - copyOrderValue(b)) * direction;
    if (byAge !== 0) return byAge;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

/** Build the displayed groups: filter by kind, pick a keeper, then sort. */
export function buildGroupViews(
  groups: DuplicateGroup[],
  { filterKind, keeperMode, sortBy }: GroupViewOptions,
): GroupView[] {
  const views: GroupView[] = [];
  groups.forEach((group) => {
    if (filterKind !== "all" && !group.items.some((item) => item.kind === filterKind)) return;
    const ordered = orderGroup(group.items, keeperMode);
    const copies = ordered.slice(1);
    views.push({
      group,
      ordered,
      keeper: ordered[0],
      copies,
      reclaimable: copies.reduce((sum, item) => sum + item.size, 0),
      newest: group.items.reduce((latest, item) => Math.max(latest, copyOrderValue(item)), 0),
    });
  });
  views.sort((a, b) => {
    if (sortBy === "copies")
      return b.ordered.length - a.ordered.length || b.reclaimable - a.reclaimable;
    if (sortBy === "newest") return b.newest - a.newest;
    if (sortBy === "name") return a.keeper.name.localeCompare(b.keeper.name);
    return b.reclaimable - a.reclaimable;
  });
  return views;
}
