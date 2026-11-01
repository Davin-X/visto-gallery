import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { EditValues, MediaItem } from "../types/media";
import { defaultEdits } from "../commands/tauri";
import { tauri } from "../commands/tauri";

export interface DraftTransform {
  rotation: number;
  flip: boolean;
}

const draftKey = (itemId: string) => `edit:draft:${itemId}`;

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
  try {
    await tauri.edit.saveRecipe({
      mediaId: itemId,
      edits: values,
      crop,
      history,
      historyIndex,
    });
  } catch {
    // A failed SQLite write should not break editing.
  }
  notifyDraftChanged();
}

export function resetDraftRevision(): void {
  draftRevision = 0;
  notifyDraftChanged();
}

export async function clearEditDraft(itemId: string) {
  try {
    await tauri.edit.deleteRecipe(itemId);
  } catch {}
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
    try {
      const recipes = await tauri.edit.listRecipes();
      const transforms = new Map<string, DraftTransform>();
      const ids = new Set<string>();
      for (const recipe of recipes) {
        ids.add(recipe.mediaId);
        const values = recipe.edits as EditValues;
        const rotation = (((Number(values.rotation) || 0) % 360) + 360) % 360;
        const flip = Boolean(values.flip);
        if (rotation !== 0 || flip) {
          transforms.set(recipe.mediaId, { rotation, flip });
        }
      }
      set({ transforms, ids });
    } catch {
      // Ignore errors reading drafts.
    }
  },
}));

// Subscribe to draft changes and refresh the meta store.
subscribeDraft(() => {
  void useDraftMetaStore.getState().refresh();
});

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

interface EditState {
  // State
  item: MediaItem | null;
  values: EditValues;
  crop: CropState;
  history: EditValues[];
  historyIndex: number;

  // Actions
  open: (item: MediaItem) => Promise<void>;
  close: () => void;
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
        try {
          const recipe = await tauri.edit.getRecipe(item.id);
          if (recipe && recipe.edits) {
            values = { ...defaultEdits, ...recipe.edits };
            crop = { ...defaultCrop, ...(recipe.crop || {}) };
            history = Array.isArray(recipe.history)
              ? recipe.history
              : [values];
            historyIndex =
              typeof recipe.historyIndex === "number"
                ? recipe.historyIndex
                : history.length - 1;
          }
        } catch {
          // Ignore bad recipe, use defaults.
        }
        set({
          item,
          values,
          crop,
          history,
          historyIndex,
        });
      },

      close: () =>
        set({
          item: null,
          values: defaultEdits,
          crop: defaultCrop,
          history: [defaultEdits],
          historyIndex: 0,
        }),

      saveDraft: async () => {
        const { item, values, history, historyIndex } = get();
        if (item)
          await persistDraft(item.id, values, history, historyIndex, get().crop);
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
        if (item)
          await persistDraft(
            item.id,
            next,
            newHistory,
            newHistory.length - 1,
            get().crop,
          );
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
        if (item)
          await persistDraft(
            item.id,
            next,
            newHistory,
            newHistory.length - 1,
            get().crop,
          );
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
          await persistDraft(
            item.id,
            autoEdits,
            newHistory,
            newHistory.length - 1,
            get().crop,
          );
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
        if (item)
          await persistDraft(
            item.id,
            next,
            newHistory,
            newHistory.length - 1,
            get().crop,
          );
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
        if (item)
          await persistDraft(
            item.id,
            next,
            newHistory,
            newHistory.length - 1,
            get().crop,
          );
      },

      setCrop: async (partial) => {
        const { item, values, history, historyIndex, crop } = get();
        const nextCrop = { ...crop, ...partial };
        set({ crop: nextCrop });
        if (item)
          await persistDraft(item.id, values, history, historyIndex, nextCrop);
      },

      resetCrop: async () => {
        const { item, values, history, historyIndex } = get();
        set({ crop: defaultCrop });
        if (item)
          await persistDraft(item.id, values, history, historyIndex, defaultCrop);
      },

      undo: async () => {
        const { history, historyIndex, item } = get();
        if (historyIndex > 0) {
          const nextIndex = historyIndex - 1;
          set({ values: history[nextIndex], historyIndex: nextIndex });
          if (item)
            await persistDraft(
              item.id,
              history[nextIndex],
              history,
              nextIndex,
              get().crop,
            );
        }
      },

      redo: async () => {
        const { history, historyIndex, item } = get();
        if (historyIndex < history.length - 1) {
          const nextIndex = historyIndex + 1;
          set({ values: history[nextIndex], historyIndex: nextIndex });
          if (item)
            await persistDraft(
              item.id,
              history[nextIndex],
              history,
              nextIndex,
              get().crop,
            );
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
  useEditStore((s) => ({ canUndo: s.canUndo, canRedo: s.canRedo }));
