import type { StoreApi } from "zustand";
import { tauri } from "../../commands/tauri";
import type { LibraryFilter, MediaItem } from "../../types/media";
import type { LibraryFilterDTO, LibraryItemsPage } from "../../types/commands";
import { debugLog } from "../useSettingsStore";
import { currentLibraryFilter, hiddenPageFilter } from "./filters";
import type { LibraryState } from "./types";

// Load generations are per-app (not per-store-instance).
let libraryLoadGeneration = 0;
// Request tickets for paged loads. A filter reload resets `loadingNextPage`,
// so a continuation request that was already in flight when that happened
// could finish later and clear the flag a newer request had just set — which
// lets the same cursor be fetched twice. A response may only touch shared
// paging state while it is still the newest request of its kind.
let nextPageRequestId = 0;
let nextHiddenRequestId = 0;

const HIDDEN_PAGE_SIZE = 250;

// Normalize a paged command's return value: older callers returned a bare
// array, newer ones return { items, hasMore, nextCursor, totalCount? }.
function normalizePageResult(result: LibraryItemsPage | MediaItem[] | unknown): LibraryItemsPage {
  if (Array.isArray(result)) {
    return {
      items: result as MediaItem[],
      hasMore: false,
      totalCount: (result as MediaItem[]).length,
    };
  }
  return result as LibraryItemsPage;
}

type PagingActions = Pick<
  LibraryState,
  | "loadItemsPage"
  | "loadCatalogMetadata"
  | "loadLibrary"
  | "loadHiddenItems"
  | "loadMoreHiddenItems"
  | "loadNextPage"
>;

export const createPagingActions = (
  set: StoreApi<LibraryState>["setState"],
  get: StoreApi<LibraryState>["getState"],
): PagingActions => ({
  // Data Loading
  // Load only library items (paged). Called frequently when filters change.
  // Catalog metadata (albums, smart albums, tags, folders) is NOT refreshed
  // here — call loadCatalogMetadata() for that.
  loadItemsPage: async (filter?: LibraryFilter) => {
    const generation = ++libraryLoadGeneration;
    set({
      refreshingLibrary: true,
      page: 0,
      hasMore: false,
      nextCursor: null,
      loadingNextPage: false,
    });
    try {
      const state = get();
      const viewFilter = { ...currentLibraryFilter(state), ...(filter || {}) };
      const normalizedColorLabel = viewFilter.colorLabel ?? undefined;
      viewFilter.colorLabel = normalizedColorLabel;
      const viewKey = JSON.stringify(viewFilter);
      const dto: LibraryFilterDTO = {
        ...viewFilter,
        colorLabel: normalizedColorLabel,
        limit: state.pageSize,
        cursor: undefined,
      };

      const isTauri =
        typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
      if (!isTauri) {
        if (import.meta.env.DEV)
          // eslint-disable-next-line no-console
          console.warn("Tauri IPC is not available in browser preview mode.");
        set({ refreshingLibrary: false, loadedViewKey: viewKey });
        get().refreshDerived();
        return;
      }

      const pageResult = await tauri.library.getItems(dto);
      if (generation !== libraryLoadGeneration) return;
      const page = normalizePageResult(pageResult);

      set({
        items: page.items,
        refreshingLibrary: false,
        page: 0,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor ?? null,
        totalCount: page.totalCount ?? 0,
        loadedViewKey: viewKey,
      });
      get().refreshDerived();
    } catch (e) {
      if (generation !== libraryLoadGeneration) return;
      debugLog("loadItemsPage failed:", e);
      set({ refreshingLibrary: false, loadedViewKey: null });
      get().showErrorNotice(e, "Failed to load library");
    }
  },

  // Load catalog metadata (albums, smart albums, tags, folders). Called
  // infrequently when sources or albums change — not on every filter
  // change.
  loadCatalogMetadata: async () => {
    const generation = ++libraryLoadGeneration;
    // Each list loads on its own: one failing command (say, a Smart Album
    // the backend cannot evaluate) must not blank albums, tags and
    // folders that loaded fine. Lists that fail keep their last value.
    const [albumOverviews, smartAlbums, tags, folders] = await Promise.allSettled([
      tauri.albums.getOverviews(),
      tauri.smartAlbums.get(),
      tauri.albums.getTags(),
      tauri.library.getFolders(),
    ]);
    if (generation !== libraryLoadGeneration) return;
    const update: Partial<LibraryState> = {};
    if (albumOverviews.status === "fulfilled") {
      update.albumOverviews = albumOverviews.value;
      update.albums = albumOverviews.value.map((album) => ({
        id: album.id,
        name: album.name,
        colorIndex: album.colorIndex,
        itemCount: album.itemCount,
        itemSize: album.itemSize,
        itemIds: [],
        createdAt: album.createdAt,
        updatedAt: album.updatedAt,
      }));
    }
    if (smartAlbums.status === "fulfilled") update.smartAlbums = smartAlbums.value;
    if (tags.status === "fulfilled") update.tags = tags.value;
    if (folders.status === "fulfilled") update.folders = folders.value;
    set(update);
    get().refreshDerived();

    const failures = [
      ["albums", albumOverviews],
      ["Smart Albums", smartAlbums],
      ["tags", tags],
      ["sources", folders],
    ].filter(([, result]) => (result as PromiseSettledResult<unknown>).status === "rejected");
    if (failures.length > 0) {
      const first = failures[0][1] as PromiseRejectedResult;
      debugLog("loadCatalogMetadata failed:", failures);
      get().showErrorNotice(
        first.reason,
        `Could not load ${failures.map(([label]) => label).join(", ")}`,
      );
    }
  },

  // Load both items (paged) and catalog metadata. Used on first load or
  // when both need refreshing. For filter-only changes, prefer
  // loadItemsPage().
  loadLibrary: async (filter?: LibraryFilter) => {
    await get().loadItemsPage(filter);
    await get().loadCatalogMetadata();
    await get().loadHiddenItems();
    get().refreshDerived();
  },

  // Load hidden items separately since the main items query always
  // filters hidden = false. These power the Hidden screen. First page
  // here, continuation pages via loadMoreHiddenItems.
  loadHiddenItems: async () => {
    const generation = libraryLoadGeneration;
    const requestId = ++nextHiddenRequestId;
    const isCurrent = () =>
      generation === libraryLoadGeneration && requestId === nextHiddenRequestId;
    const releaseIfOwner = () => {
      if (requestId === nextHiddenRequestId) set({ hiddenLoading: false });
    };
    const isTauri =
      typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
    if (!isTauri) {
      set({ hiddenItems: [], hiddenCount: 0, hiddenCursor: null, hiddenHasMore: false });
      return;
    }
    try {
      set({ hiddenLoading: true });
      const pageResult = await tauri.library.getHiddenItems({
        limit: HIDDEN_PAGE_SIZE,
        ...hiddenPageFilter(get()),
      });
      if (!isCurrent()) {
        releaseIfOwner();
        return;
      }
      const page = normalizePageResult(pageResult);
      set({
        hiddenItems: page.items,
        hiddenCount: page.totalCount ?? page.items.length,
        hiddenCursor: page.nextCursor ?? null,
        hiddenHasMore: page.hasMore,
        hiddenLoading: false,
      });
    } catch (e) {
      if (!isCurrent()) {
        releaseIfOwner();
        return;
      }
      debugLog("loadHiddenItems failed:", e);
      set({
        hiddenItems: [],
        hiddenCount: 0,
        hiddenCursor: null,
        hiddenHasMore: false,
        hiddenLoading: false,
      });
    }
  },

  loadMoreHiddenItems: async () => {
    const state = get();
    if (state.hiddenLoading || !state.hiddenHasMore) return;
    const cursor = state.hiddenCursor;
    if (!cursor) return;
    const generation = libraryLoadGeneration;
    const requestId = ++nextHiddenRequestId;
    set({ hiddenLoading: true });
    try {
      const pageResult = await tauri.library.getHiddenItems({
        limit: HIDDEN_PAGE_SIZE,
        cursor,
        ...hiddenPageFilter(get()),
      });
      if (generation !== libraryLoadGeneration || requestId !== nextHiddenRequestId) {
        // A newer hidden request owns the list and the loading flag.
        if (requestId === nextHiddenRequestId) set({ hiddenLoading: false });
        return;
      }
      const page = normalizePageResult(pageResult);
      set((current) => {
        const known = new Set(current.hiddenItems.map((item) => item.id));
        const additions = page.items.filter((item) => !known.has(item.id));
        return {
          hiddenItems: [...current.hiddenItems, ...additions],
          hiddenCursor: page.nextCursor ?? null,
          hiddenHasMore: page.hasMore,
          hiddenCount: page.totalCount ?? current.hiddenCount,
          hiddenLoading: false,
        };
      });
    } catch (error) {
      if (requestId === nextHiddenRequestId) set({ hiddenLoading: false });
      if (generation !== libraryLoadGeneration || requestId !== nextHiddenRequestId) return;
      get().showErrorNotice(error, "Failed to load more hidden items");
    }
  },

  loadNextPage: async () => {
    const state = get();
    // M3: the guard on `loadingNextPage` and `generation` used to be
    // missing for the synchronous re-entry path, so a slow continuation
    // request could start a duplicate fetch of the same cursor.
    if (state.busy || state.loadingNextPage || !state.hasMore || !state.nextCursor) return;
    const cursor = state.nextCursor;
    const generation = libraryLoadGeneration;
    const requestId = ++nextPageRequestId;
    // Fetch continuation pages quietly. Marking the whole library busy here
    // would disable controls and show a misleading cancellable scan toast
    // every time the user reaches the bottom of the grid.
    set({ loadingNextPage: true });
    try {
      const pageResult = await tauri.library.getItems({
        ...currentLibraryFilter(get()),
        limit: state.pageSize,
        cursor,
      });
      if (generation !== libraryLoadGeneration || requestId !== nextPageRequestId) {
        // A filter/sort reload superseded this continuation request. Do
        // not leave the quiet paging guard stuck on if the old request
        // happens to finish after the replacement load, and do not clear
        // it when a newer page request now owns it.
        if (requestId === nextPageRequestId) set({ loadingNextPage: false });
        return;
      }
      const page = normalizePageResult(pageResult);
      set((current) => {
        const known = new Set(current.items.map((item) => item.id));
        const additions = page.items.filter((item) => !known.has(item.id));
        return {
          items: [...current.items, ...additions],
          page: current.page + 1,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor ?? null,
          totalCount: page.totalCount ?? current.totalCount,
          loadingNextPage: false,
        };
      });
      get().refreshDerived();
    } catch (error) {
      if (requestId === nextPageRequestId) set({ loadingNextPage: false });
      if (generation !== libraryLoadGeneration || requestId !== nextPageRequestId) return;
      get().showErrorNotice(error, "Failed to load more items");
    }
  },
});
