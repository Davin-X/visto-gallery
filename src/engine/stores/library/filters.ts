import type { Filter } from "../../types/media";
import type { LibraryFilterDTO } from "../../types/commands";
import type { LibraryState } from "./types";

/** Map the hidden view's UI filter onto the backend page query, so filtering
 * happens in SQL rather than over whatever subset happened to be loaded. */
export function hiddenPageFilter(state: {
  hiddenFilter: Filter;
  hiddenQuery: string;
  sortBy: LibraryState["sortBy"];
  sortOrder: LibraryState["sortOrder"];
}): {
  kind?: "photo" | "video" | "raw";
  animated?: boolean;
  favorite?: boolean;
  hidden?: true;
  query?: string;
  sortBy: LibraryState["sortBy"];
  sortOrder: LibraryState["sortOrder"];
} {
  const filter = state.hiddenFilter;
  const base = {
    hidden: true as const,
    query: state.hiddenQuery.trim() || undefined,
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
  };
  if (filter === "Photos") return { ...base, kind: "photo" };
  if (filter === "Videos") return { ...base, kind: "video" };
  if (filter === "RAW") return { ...base, kind: "raw" };
  if (filter === "Animations") return { ...base, animated: true };
  if (filter === "Favorites") return { ...base, favorite: true };
  return base;
}

export function currentLibraryFilter(state: LibraryState): LibraryFilterDTO {
  const kind =
    state.filter === "Photos"
      ? "photo"
      : state.filter === "Videos"
        ? "video"
        : state.filter === "RAW"
          ? "raw"
          : undefined;
  return {
    kind,
    // "Animations" is a property of the item, not a kind: GIFs stay photos so
    // the Photos count, viewer and edit flows keep working unchanged.
    animated: state.filter === "Animations" ? true : state.filter === "Photos" ? false : undefined,
    favorite: state.filter === "Favorites" ? true : undefined,
    albumId: state.activeAlbum ?? undefined,
    query: state.query.trim() || undefined,
    sourcePath: state.activeSource ?? undefined,
    dateFrom: state.dateFrom ?? undefined,
    dateTo: state.dateTo ?? undefined,
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    rating: state.minRating ?? undefined,
    colorLabel: state.colorLabelFilter ?? undefined,
    camera: state.cameraFilter ?? undefined,
    lens: state.lensFilter ?? undefined,
    tags: state.tagsFilter.length > 0 ? state.tagsFilter : undefined,
    hidden: false,
  };
}

/**
 * Stable signature of the filter/sort state that produces `items`.
 *
 * LibraryScreen keys its scroll memory with this value and the store records
 * it on every successful page load. Keeping both sides on the same helper
 * means a tab switch can never restore an offset against a different query.
 */
export function libraryViewKey(state: LibraryState): string {
  return JSON.stringify(currentLibraryFilter(state));
}
