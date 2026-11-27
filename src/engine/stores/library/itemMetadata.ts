import type { StateCreator } from "zustand";
import { tauri } from "../../commands/tauri";
import type { MediaItem } from "../../types/media";
import { scopedPages } from "../../../screens/timeline/monthCache";
import { debugLog } from "../useSettingsStore";
import type { LibraryState } from "./types";

export function mutationTargets(state: LibraryState, ids: string[]) {
  const wanted = new Set(ids);
  const targets = new Map<string, MediaItem>();
  const collect = (items: MediaItem[]) => {
    for (const item of items) {
      if (wanted.has(item.id)) targets.set(item.id, item);
    }
  };
  collect(state.items);
  collect(state.hiddenItems);
  const pages = scopedPages(state, false) ?? scopedPages(state, true);
  for (const page of pages?.values() ?? []) collect(page.items);
  return targets;
}

type Actions = Pick<
  LibraryState,
  | "toggleFavorite"
  | "setFavoriteForIds"
  | "setRating"
  | "setRatingForIds"
  | "setColorLabel"
  | "setColorLabelForIds"
  | "updateItemTags"
>;

export const createItemMetadataActions: StateCreator<
  LibraryState,
  [["zustand/devtools", never]],
  [],
  Actions
> = (set, get) => {
  const update = (patches: Map<string, Partial<MediaItem>>) => {
    if (!patches.size) return;
    const apply = (item: MediaItem) => {
      const patch = patches.get(item.id);
      return patch ? { ...item, ...patch } : item;
    };
    set((state) => ({
      items: state.items.map(apply),
      hiddenItems: state.hiddenItems.map(apply),
      timelineCache: state.timelineCache && {
        ...state.timelineCache,
        pages: new Map(
          [...state.timelineCache.pages].map(([month, page]) => [
            month,
            { ...page, items: page.items.map(apply) },
          ]),
        ),
      },
    }));
    get().refreshDerived();
  };

  const save = async (
    ids: string[],
    patch: Partial<MediaItem>,
    persist: (id: string) => Promise<unknown>,
  ) => {
    const targets = [...mutationTargets(get(), ids).keys()];
    const results = await Promise.allSettled(targets.map(persist));
    const saved = new Map<string, Partial<MediaItem>>();
    results.forEach((result, index) => {
      if (result.status === "fulfilled") saved.set(targets[index], patch);
      else debugLog("Could not save item metadata:", result.reason);
    });
    update(saved);
    return results.find((result) => result.status === "rejected");
  };

  return {
    toggleFavorite: async (id) => {
      const item = mutationTargets(get(), [id]).get(id);
      if (item) await get().setFavoriteForIds([id], !item.favorite);
    },
    setFavoriteForIds: async (ids, favorite) => {
      const failure = await save(ids, { favorite }, (id) =>
        tauri.items.toggleFavorite(id, favorite),
      );
      if (failure) throw failure.reason;
    },
    setRating: (id, rating) => get().setRatingForIds([id], rating),
    setRatingForIds: async (ids, rating) => {
      await save(ids, { rating }, (id) => tauri.items.setRating(id, rating));
    },
    setColorLabel: (id, label) => get().setColorLabelForIds([id], label),
    setColorLabelForIds: async (ids, label) => {
      await save(ids, { colorLabel: label || null }, (id) => tauri.items.setColorLabel(id, label));
    },
    updateItemTags: async (id, tags) => {
      await tauri.items.updateTags(id, tags);
      update(new Map([[id, { tags }]]));
    },
  };
};
