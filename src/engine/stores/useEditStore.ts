import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import type { EditValues, MediaItem } from "../types/media";
import { defaultEdits } from "../commands/tauri";
import { tauri } from "../commands/tauri";

export interface DraftTransform {
  rotation: number;
  flip: boolean;
}

const draftKey = (itemId: string) => `edit:draft:${itemId}`;
const draftOrderKey = "edit:draft:order";

const MAX_DRAFTS = 100;
const MAX_DRAFT_SIZE_BYTES = 5 * 1024; // 5 KB per draft

function getDraftOrder(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(draftOrderKey);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setDraftOrder(order: string[]) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(draftOrderKey, JSON.stringify(order));
  } catch {
    // Ignore storage failures for order tracking.
  }
}

function pruneDrafts() {
  if (typeof localStorage === "undefined") return;
  const order = getDraftOrder();
  if (order.length <= MAX_DRAFTS) return;
  const toRemove = order.slice(0, order.length - MAX_DRAFTS);
  for (const id of toRemove) {
    try {
      localStorage.removeItem(draftKey(id));
    } catch {}
  }
  setDraftOrder(order.slice(order.length - MAX_DRAFTS));
}

// Revision counter used to signal draft changes to subscribers.
let draftRevision = 0;
const draftListeners = new Set<() => void>();

function notifyDraftChanged() {
  draftRevision += 1;
  draftListeners.forEach((listener) => listener());
}

async function persistDraft(
  itemId: string,
  values: EditValues,
  history: EditValues[],
  historyIndex: number,
  crop?: CropState,
) {
  if (typeof localStorage === "undefined") return;
  try {
    const payload = JSON.stringify({
      edits: values,
      crop,
      history,
      historyIndex,
      updatedAt: Date.now(),
    });
    // Enforce per-draft size cap: drop oversized drafts.
    if (new TextEncoder().encode(payload).length > MAX_DRAFT_SIZE_BYTES) {
      return;
    }
    localStorage.setItem(draftKey(itemId), payload);

    // Update LRU order: move itemId to end (most recently used).
    let order = getDraftOrder();
    order = order.filter((id) => id !== itemId);
    order.push(itemId);
    setDraftOrder(order);

    // Prune oldest drafts beyond the cap.
    pruneDrafts();
  } catch {
    // A full or unavailable localStorage should not break editing.
  }
  try {
    await tauri.edit.saveRecipe({
      mediaId: itemId,
      edits: values,
      crop,
      history,
      historyIndex,
    });
  } catch (error) {
    console.error(`Failed to persist draft for ${itemId}:`, error);
  }
  notifyDraftChanged();
}

export function resetDraftRevision(): void {
  draftRevision = 0;
  notifyDraftChanged();
}

export async function clearEditDraft(itemId: string) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(draftKey(itemId));
    // Remove from LRU order.
    const order = getDraftOrder().filter((id) => id !== itemId);
    setDraftOrder(order);
  } catch {}
  try {
    await tauri.edit.deleteRecipe(itemId);
  } catch {}
  // Drop the id from the metadata store synchronously. A following
  // saveDraft() reads this set as its "draft exists" guard, and the async
  // refresh triggered below may not have completed yet — without this it can
  // re-persist a neutral draft right after a discard/revert.
  removeDraftMeta(itemId);
  notifyDraftChanged();
}
function subscribeDraft(listener: () => void) {
  draftListeners.add(listener);
  return () => {
    draftListeners.delete(listener);
  };
}

/** Zustand store for draft metadata used by grid/thumbnail previews.
 *  Kept separate from the per-item edit store so grid tiles can subscribe
 *  without pulling in the full edit state. */
interface DraftMetaState {
  transforms: Map<string, DraftTransform>;
  ids: Set<string>;
  refresh: () => Promise<void>;
}

export const useDraftMetaStore = create<DraftMetaState>((set) => ({
  transforms: new Map<string, DraftTransform>(),
  ids: new Set<string>(),
  refresh: async () => {
    const transforms = new Map<string, DraftTransform>();
    const ids = new Set<string>();

    try {
      const recipes = await tauri.edit.listRecipes();
      for (const recipe of recipes) {
        ids.add(recipe.mediaId);
        const values = recipe.edits as EditValues;
        const rotation = (((Number(values.rotation) || 0) % 360) + 360) % 360;
        const flip = Boolean(values.flip);
        if (rotation !== 0 || flip) {
          transforms.set(recipe.mediaId, { rotation, flip });
        }
      }
    } catch {
      // Ignore errors reading drafts from SQLite.
    }

    // Also include any drafts stored in localStorage fallback
    if (typeof localStorage !== "undefined") {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith("edit:draft:")) {
            const mediaId = key.slice("edit:draft:".length);
            ids.add(mediaId);
            if (!transforms.has(mediaId)) {
              const raw = localStorage.getItem(key);
              if (raw) {
                const parsed = JSON.parse(raw);
                const values = parsed.edits || parsed.values;
                if (values) {
                  const rotation = (((Number(values.rotation) || 0) % 360) + 360) % 360;
                  const flip = Boolean(values.flip);
                  if (rotation !== 0 || flip) {
                    transforms.set(mediaId, { rotation, flip });
                  }
                }
              }
            }
          }
        }
      } catch {
        // Ignore localStorage read errors.
      }
    }

    set({ transforms, ids });
  },
}));

// Subscribe to draft changes and refresh the meta store.
subscribeDraft(() => {
  void useDraftMetaStore.getState().refresh();
});

/** Remove a draft id from the metadata store without waiting for a refresh. */
function removeDraftMeta(itemId: string) {
  const { ids, transforms } = useDraftMetaStore.getState();
  if (!ids.has(itemId) && !transforms.has(itemId)) return;
  const nextIds = new Set(ids);
  nextIds.delete(itemId);
  const nextTransforms = new Map(transforms);
  nextTransforms.delete(itemId);
  useDraftMetaStore.setState({ ids: nextIds, transforms: nextTransforms });
}

// Refresh on module load so drafts and transforms are available immediately on startup.
if (typeof window !== "undefined") {
  void useDraftMetaStore.getState().refresh();
}

export function refreshDraftMeta(): Promise<void> {
  return useDraftMetaStore.getState().refresh();
}

/** Hook: rotation/flip for items with edit drafts. */
export function useDraftTransforms(): Map<string, DraftTransform> {
  return useDraftMetaStore((s) => s.transforms);
}

/** Hook: item IDs that have edit drafts. */
export function useDraftIds(): Set<string> {
  return useDraftMetaStore((s) => s.ids);
}

export function draftTransformStyle(transform?: DraftTransform) {
  if (!transform || (!transform.rotation && !transform.flip)) return undefined;
  return `rotate(${transform.rotation}deg) scaleX(${transform.flip ? -1 : 1})`;
}

export function hasEditChanges(values: EditValues, crop?: CropState): boolean {
  if (crop?.enabled) return true;
  return Object.entries(defaultEdits).some(
    ([key, defaultValue]) => values[key as keyof EditValues] !== defaultValue,
  );
}

interface EditState {
  // State
  item: MediaItem | null;
  values: EditValues;
  crop: CropState;
  history: EditValues[];
  historyIndex: number;

  // Actions
  open: (item: MediaItem) => Promise<void>;
  close: () => Promise<void>;
  saveDraft: () => Promise<void>;
  setValue: <K extends keyof EditValues>(key: K, value: EditValues[K]) => Promise<void>;
  setValues: (values: Partial<EditValues>) => Promise<void>;
  reset: () => Promise<void>;
  clearDraft: () => Promise<void>;
  auto: () => Promise<void>;
  rotate: (degrees: number) => Promise<void>;
  flip: () => Promise<void>;
  setCrop: (crop: Partial<CropState>) => Promise<void>;
  resetCrop: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
}

interface CropState {
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  aspectRatio: number | "free";
}

const defaultCrop: CropState = {
  enabled: false,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  aspectRatio: "free",
};

const autoEdits: EditValues = {
  exposure: 15,
  contrast: 12,
  warmth: 10,
  shadows: 10,
  highlights: -10,
  saturation: 10,
  rotation: 0,
  flip: false,
};

export const useEditStore = create<EditState>()(
  devtools(
    (set, get) => ({
      item: null,
      values: defaultEdits,
      crop: defaultCrop,
      history: [defaultEdits],
      historyIndex: 0,

      open: async (item) => {
        // Refresh draft meta store so grid thumbnails show draft transforms
        await useDraftMetaStore.getState().refresh();
        let values = defaultEdits;
        let crop = defaultCrop;
        let history = [defaultEdits];
        let historyIndex = 0;
        let loadedFromSqlite = false;

        // Load from SQLite first.
        try {
          const recipe = await tauri.edit.getRecipe(item.id);
          if (recipe && recipe.edits) {
            values = { ...defaultEdits, ...recipe.edits };
            crop = { ...defaultCrop, ...(recipe.crop || {}) };
            history = Array.isArray(recipe.history) ? recipe.history : [values];
            historyIndex =
              typeof recipe.historyIndex === "number" ? recipe.historyIndex : history.length - 1;
            loadedFromSqlite = true;
          }
        } catch (error) {
          console.error(`Failed to load draft from SQLite for ${item.id}:`, error);
        }

        // Fall back to localStorage draft if SQLite has nothing.
        if (!loadedFromSqlite) {
          const raw = localStorage.getItem(draftKey(item.id));
          if (raw) {
            try {
              const persisted = JSON.parse(raw);
              if (persisted.edits) values = { ...defaultEdits, ...persisted.edits };
              if (persisted.crop) crop = { ...defaultCrop, ...persisted.crop };
              if (Array.isArray(persisted.history)) {
                history = persisted.history;
                historyIndex =
                  typeof persisted.historyIndex === "number"
                    ? persisted.historyIndex
                    : history.length - 1;
              }
            } catch {
              // Ignore malformed localStorage draft, use defaults.
            }
          }
        }

        set({
          item,
          values,
          crop,
          history,
          historyIndex,
        });
      },

      close: async () => {
        const { item, values, history, historyIndex, crop } = get();
        if (
          item &&
          (hasEditChanges(values, crop) || useDraftMetaStore.getState().ids.has(item.id))
        ) {
          await persistDraft(item.id, values, history, historyIndex, crop);
        }
        set({
          item: null,
          values: defaultEdits,
          crop: defaultCrop,
          history: [defaultEdits],
          historyIndex: 0,
        });
      },

      saveDraft: async () => {
        const { item, values, history, historyIndex, crop } = get();
        if (
          item &&
          (hasEditChanges(values, crop) || useDraftMetaStore.getState().ids.has(item.id))
        ) {
          await persistDraft(item.id, values, history, historyIndex, crop);
        }
      },

      setValue: async (key, value) => {
        const { values, history, historyIndex, item } = get();
        const next = { ...values, [key]: value };
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(next);
        if (newHistory.length > 50) newHistory.shift();
        set({
          values: next,
          history: newHistory,
          historyIndex: newHistory.length - 1,
        });
        if (item) await persistDraft(item.id, next, newHistory, newHistory.length - 1, get().crop);
      },

      setValues: async (partial) => {
        const { values, history, historyIndex, item } = get();
        const next = { ...values, ...partial };
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(next);
        if (newHistory.length > 50) newHistory.shift();
        set({
          values: next,
          history: newHistory,
          historyIndex: newHistory.length - 1,
        });
        if (item) await persistDraft(item.id, next, newHistory, newHistory.length - 1, get().crop);
      },

      reset: async () => {
        const { history, historyIndex, item } = get();
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(defaultEdits);
        set({
          values: defaultEdits,
          crop: defaultCrop,
          history: newHistory,
          historyIndex: newHistory.length - 1,
        });
        if (item) await clearEditDraft(item.id);
      },

      clearDraft: async () => {
        const { item } = get();
        if (item) await clearEditDraft(item.id);
        set({
          values: defaultEdits,
          crop: defaultCrop,
          history: [defaultEdits],
          historyIndex: 0,
        });
      },

      auto: async () => {
        const { history, historyIndex, item } = get();
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(autoEdits);
        set({
          values: autoEdits,
          history: newHistory,
          historyIndex: newHistory.length - 1,
        });
        if (item)
          await persistDraft(item.id, autoEdits, newHistory, newHistory.length - 1, get().crop);
      },

      rotate: async (degrees) => {
        const { values, history, historyIndex, item } = get();
        const next = {
          ...values,
          rotation: (values.rotation + degrees + 360) % 360,
        };
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(next);
        set({
          values: next,
          history: newHistory,
          historyIndex: newHistory.length - 1,
        });
        if (item) await persistDraft(item.id, next, newHistory, newHistory.length - 1, get().crop);
      },

      flip: async () => {
        const { values, history, historyIndex, item } = get();
        const next = { ...values, flip: !values.flip };
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(next);
        set({
          values: next,
          history: newHistory,
          historyIndex: newHistory.length - 1,
        });
        if (item) await persistDraft(item.id, next, newHistory, newHistory.length - 1, get().crop);
      },

      setCrop: async (partial) => {
        const { item, values, history, historyIndex, crop } = get();
        const nextCrop = { ...crop, ...partial };
        set({ crop: nextCrop });
        if (item) await persistDraft(item.id, values, history, historyIndex, nextCrop);
      },

      resetCrop: async () => {
        const { item, values, history, historyIndex } = get();
        set({ crop: defaultCrop });
        if (item) await persistDraft(item.id, values, history, historyIndex, defaultCrop);
      },

      undo: async () => {
        const { history, historyIndex, item } = get();
        if (historyIndex > 0) {
          const nextIndex = historyIndex - 1;
          set({ values: history[nextIndex], historyIndex: nextIndex });
          if (item) await persistDraft(item.id, history[nextIndex], history, nextIndex, get().crop);
        }
      },

      redo: async () => {
        const { history, historyIndex, item } = get();
        if (historyIndex < history.length - 1) {
          const nextIndex = historyIndex + 1;
          set({ values: history[nextIndex], historyIndex: nextIndex });
          if (item) await persistDraft(item.id, history[nextIndex], history, nextIndex, get().crop);
        }
      },

      get canUndo() {
        return get().historyIndex > 0;
      },

      get canRedo() {
        const { history, historyIndex } = get();
        return historyIndex < history.length - 1;
      },
    }),
    { name: "edit-store" },
  ),
);

export const useEditItem = () => useEditStore((s) => s.item);
export const useEditValues = () => useEditStore((s) => s.values);
export const useEditCrop = () => useEditStore((s) => s.crop);
export const useEditHistory = () =>
  useEditStore(useShallow((s) => ({ canUndo: s.canUndo, canRedo: s.canRedo })));
