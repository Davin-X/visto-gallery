import { loadTimelinePage } from "../../../screens/timeline/loadTimelinePage";
import { itemMonthKey } from "../../utils/mediaDate";
import { cachedItem, scopedPages, timelineKey } from "../../../screens/timeline/monthCache";
import type { StateCreator } from "zustand";
import { tauri } from "../../commands/tauri";
import type { MediaItem } from "../../types/media";
import { debugLog } from "../useSettingsStore";
import { currentLibraryFilter, hiddenPageFilter } from "./filters";
import type { LibraryState } from "./types";

function findKnownItem(state: LibraryState, id: string): MediaItem | null {
  const direct =
    state.items.find((item) => item.id === id) ||
    state.hiddenItems.find((item) => item.id === id) ||
    state.mapItems.find((item) => item.id === id) ||
    cachedItem(
      state,
      state.screen === "Hidden" || (state.screen === "Viewer" && state.viewerScope === "hidden"),
      id,
    );
  if (direct) return direct;
  for (const group of state.duplicates) {
    const match = group.items.find((item) => item.id === id);
    if (match) return match;
  }
  for (const group of state.burstGroups) {
    const match = group.items.find((item) => item.id === id);
    if (match) return match;
  }
  return null;
}

export function resolveInspectedItem(state: LibraryState, viewerItems: MediaItem[]) {
  if (state.inspectedId) {
    return (
      viewerItems.find((item) => item.id === state.inspectedId) ||
      findKnownItem(state, state.inspectedId) ||
      null
    );
  }
  return viewerItems[0] || null;
}

function computeInspectionDerived(state: LibraryState) {
  const viewerSelected = resolveInspectedItem(state, state.viewerItems);
  return {
    viewerSelected,
    currentIndex: Math.max(
      0,
      state.playableItems.findIndex((item) => item.id === state.inspectedId),
    ),
    viewerIndex: viewerSelected
      ? state.viewerItems.findIndex((item) => item.id === viewerSelected.id)
      : -1,
  };
}

// in-flight guard for "select everything matching" — the IPC can return tens
// of thousands of ids; avoid re-triggering while one is still running.
let selectAllMatchingInFlight = false;

type SelectionActions = Pick<
  LibraryState,
  | "inspectItem"
  | "toggleSelection"
  | "addToSelection"
  | "navigatePhoto"
  | "navigateViewerPhoto"
  | "selectRange"
  | "clearSelection"
  | "toggleSelectAll"
  | "selectAll"
  | "setSelectedIds"
>;

export const createSelectionActions: StateCreator<
  LibraryState,
  [["zustand/devtools", never]],
  [],
  SelectionActions
> = (set, get, store) => {
  // Select everything that matches the current filter, without paging in the
  // visible window. Previously this selected only whichever items were already
  // rendered, so a big search result gave you 250 instead of everything.
  function selectAllMatching() {
    if (selectAllMatchingInFlight) return;
    selectAllMatchingInFlight = true;
    const state = store.getState();
    tauri.library
      .getMatchingIds(currentLibraryFilter(state))
      .then((ids) => {
        store.setState({ selectedIds: ids });
        store.getState().showNotice(`Selected all ${ids.length.toLocaleString()} matching items.`);
      })
      .catch((error) => {
        debugLog("Select all failed:", error);
        store.getState().showErrorNotice(error, "Could not select all matching items");
      })
      .finally(() => {
        selectAllMatchingInFlight = false;
      });
  }

  return {
    // Inspection & selection are independent. Inspecting an item never
    // touches the selection set; selection ops never move inspection.
    // Single-click inspects, checkbox/"+" toggles selection membership,
    // double-click inspects + opens the viewer on that item.
    inspectItem: (id) => {
      const state = get();
      if (id === state.inspectedId) return;
      if (id !== null && !findKnownItem(state, id)) return;
      const next = { ...state, inspectedId: id };
      set({ inspectedId: id, ...computeInspectionDerived(next) });
    },

    toggleSelection: (id) => {
      const { selectedIds } = get();
      const next = selectedIds.includes(id)
        ? selectedIds.filter((s) => s !== id)
        : [...selectedIds, id];
      set({ selectedIds: next });
    },

    addToSelection: (id: string) => {
      const { selectedIds } = get();
      // Purely additive - toggling would silently drop the item the
      // inspector is currently showing.
      if (selectedIds.includes(id)) return;
      set({ selectedIds: [...selectedIds, id] });
    },

    // Arrow-key / slideshow / viewer navigation moves inspection only;
    // it never rewrites the user's multi-selection.
    navigatePhoto: (delta) => {
      const { playableItems, inspectedId: currentId } = get();
      if (playableItems.length === 0) return;
      const currentIndex = playableItems.findIndex((i) => i.id === currentId);
      const nextIndex = (currentIndex + delta + playableItems.length) % playableItems.length;
      const state = get();
      const inspectedId = playableItems[nextIndex].id;
      set({
        inspectedId,
        ...computeInspectionDerived({ ...state, inspectedId }),
      });
    },

    navigateViewerPhoto: async (delta) => {
      let state = get();
      const currentId = state.viewerSelected?.id;
      if (!currentId || delta === 0) return false;

      let photos = state.viewerItems.filter((item) => item.kind !== "video");
      let currentIndex = photos.findIndex((item) => item.id === currentId);
      if (currentIndex < 0) return false;

      const hidden = state.viewerScope === "hidden";
      const month = itemMonthKey(photos[currentIndex]);
      const view = timelineKey(state, hidden);
      let page = scopedPages(state, hidden)?.get(month);
      while (
        delta > 0 &&
        page?.nextCursor &&
        (!photos[currentIndex + delta] || itemMonthKey(photos[currentIndex + delta]) !== month)
      ) {
        const cursor = page.nextCursor;
        try {
          await loadTimelinePage(
            store,
            hidden ? hiddenPageFilter(state) : currentLibraryFilter(state),
            view,
            month,
            cursor,
            () => get().viewerScope === state.viewerScope,
          );
        } catch (error) {
          debugLog("Could not load the next Timeline page:", error);
          return false;
        }
        state = get();
        if (state.inspectedId !== currentId || timelineKey(state, hidden) !== view) return false;
        photos = state.viewerItems.filter((item) => item.kind !== "video");
        currentIndex = photos.findIndex((item) => item.id === currentId);
        if (currentIndex < 0) return false;
        page = scopedPages(state, hidden)?.get(month);
        if (!page || page.nextCursor === cursor) return false;
      }

      if (
        delta > 0 &&
        !scopedPages(state, false)?.size &&
        state.viewerScope === "library" &&
        currentIndex + delta >= photos.length
      ) {
        while (state.hasMore) {
          const previousItemCount = state.items.length;
          await state.loadNextPage();
          state = get();
          if (state.items.length === previousItemCount && state.hasMore) return false;

          photos = state.viewerItems.filter((item) => item.kind !== "video");
          currentIndex = photos.findIndex((item) => item.id === currentId);
          if (currentIndex < 0) return false;
          if (currentIndex + delta < photos.length) break;
        }
      }

      const nextIndex = (currentIndex + delta + photos.length) % photos.length;
      const inspectedId = photos[nextIndex].id;
      state = get();
      set({
        inspectedId,
        ...computeInspectionDerived({ ...state, inspectedId }),
      });
      return true;
    },

    selectRange: (startId, endId) => {
      const { visibleItems } = get();
      const start = visibleItems.findIndex((i) => i.id === startId);
      const end = visibleItems.findIndex((i) => i.id === endId);
      if (start === -1 || end === -1) return;

      const [from, to] = start < end ? [start, end] : [end, start];
      const rangeIds = visibleItems.slice(from, to + 1).map((i) => i.id);
      set({ selectedIds: rangeIds });
    },

    // Clearing the selection leaves inspection untouched, so the Inspector
    // keeps showing the inspected item even with an empty selection set.
    clearSelection: () => set({ selectedIds: [] }),

    toggleSelectAll: () => {
      const state = get();
      // "Everything matching" scales with the whole query result; the visible
      // set is not a fair proxy. When more pages exist on the server, fetch
      // every matching id instead of only the loaded window.
      const universe = state.hasMore ? state.totalCount : state.visibleItems.length;
      if (universe > 0 && state.selectedIds.length >= universe) {
        set({ selectedIds: [] });
        return;
      }
      if (state.hasMore) {
        selectAllMatching();
        return;
      }
      set({ selectedIds: state.visibleItems.map((item) => item.id) });
    },

    selectAll: () => {
      const state = get();
      if (state.hasMore) {
        selectAllMatching();
        return;
      }
      set({ selectedIds: state.visibleItems.map((item) => item.id) });
    },

    // The Hidden gallery owns its own item list, so it needs a way to replace
    // the shared selection without going through `visibleItems`.
    setSelectedIds: (ids) => {
      set({ selectedIds: [...new Set(ids)] });
    },
  };
};
