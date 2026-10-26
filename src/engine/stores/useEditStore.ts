import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { useMemo, useSyncExternalStore } from "react";
import type { EditValues, MediaItem } from "../types/media";
import { defaultEdits } from "../commands/tauri";

export interface DraftTransform {
  rotation: number;
  flip: boolean;
}

const draftKey = (itemId: string) => `edit:draft:${itemId}`;

// Previews subscribe to a small revision counter instead of reading every
// draft on every render. The counter only changes when a draft is written or
// removed, so a flip in Edit updates the grid, viewer, and slideshow together.
let draftRevision = 0;
const draftListeners = new Set<() => void>();

function notifyDraftChanged() {
  draftRevision += 1;
  draftListeners.forEach((listener) => listener());
}

function persistDraft(itemId: string, values: EditValues, history: EditValues[], historyIndex: number, crop?: CropState) {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(draftKey(itemId), JSON.stringify({ values, history, historyIndex, ...(crop ? { crop } : {}) }));
    } catch {
      // A full or unavailable localStorage should not break editing.
    }
  }
  notifyDraftChanged();
}

export function resetDraftRevision(): void {
  draftRevision = 0;
  notifyDraftChanged();
}

export function clearEditDraft(itemId: string) {
  if (typeof localStorage !== "undefined") {
    try { localStorage.removeItem(draftKey(itemId)); } catch {}
  }
  notifyDraftChanged();
}

function subscribeDraft(listener: () => void) {
  draftListeners.add(listener);
  return () => { draftListeners.delete(listener); };
}

/** Read the current rotation/flip for every item that has an edit draft. */
export function useDraftTransforms(): Map<string, DraftTransform> {
  const revision = useSyncExternalStore(subscribeDraft, () => draftRevision, () => draftRevision);
  return useMemo(() => {
    const transforms = new Map<string, DraftTransform>();
    if (typeof localStorage === "undefined") return transforms;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith("edit:draft:")) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || "");
        const values = parsed?.values;
        if (!values) continue;
        const rotation = ((Number(values.rotation) || 0) % 360 + 360) % 360;
        const flip = Boolean(values.flip);
        if (rotation !== 0 || flip) {
          transforms.set(key.slice("edit:draft:".length), { rotation, flip });
        }
      } catch {
        // Ignore drafts that cannot be parsed.
      }
    }
    return transforms;
  }, [revision]);
}

/** List draft-backed items without reading and parsing every stored draft. */
export function useDraftIds(): Set<string> {
  const revision = useSyncExternalStore(subscribeDraft, () => draftRevision, () => draftRevision);
  return useMemo(() => {
    const ids = new Set<string>();
    if (typeof localStorage === "undefined") return ids;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("edit:draft:")) ids.add(key.slice("edit:draft:".length));
    }
    return ids;
  }, [revision]);
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
  open: (item: MediaItem) => void;
  close: () => void;
  saveDraft: () => void;
  setValue: <K extends keyof EditValues>(key: K, value: EditValues[K]) => void;
  setValues: (values: Partial<EditValues>) => void;
  reset: () => void;
  clearDraft: () => void;
  auto: () => void;
  rotate: (degrees: number) => void;
  flip: () => void;
  setCrop: (crop: Partial<CropState>) => void;
  resetCrop: () => void;
  undo: () => void;
  redo: () => void;
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

      open: (item) => {
        const draftRaw = (typeof localStorage !== "undefined") ? localStorage.getItem(`edit:draft:${item.id}`) : null;
        let values = defaultEdits;
        let crop = defaultCrop;
        let history = [defaultEdits];
        let historyIndex = 0;
        if (draftRaw) {
          try {
            const parsed = JSON.parse(draftRaw);
            if (parsed && parsed.values) {
              values = { ...defaultEdits, ...parsed.values };
              crop = { ...defaultCrop, ...(parsed.crop || {}) };
              history = Array.isArray(parsed.history) ? parsed.history : [values];
              historyIndex = typeof parsed.historyIndex === "number" ? parsed.historyIndex : history.length - 1;
            }
          } catch {
            // ignore bad draft
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

      close: () => set({ item: null, values: defaultEdits, crop: defaultCrop, history: [defaultEdits], historyIndex: 0 }),

      saveDraft: () => {
        const { item, values, history, historyIndex } = get();
        if (item) persistDraft(item.id, values, history, historyIndex, get().crop);
      },

      setValue: (key, value) => {
        const { values, history, historyIndex, item } = get();
        const next = { ...values, [key]: value };
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(next);
        if (newHistory.length > 50) newHistory.shift();
        set({ values: next, history: newHistory, historyIndex: newHistory.length - 1 });
        if (item) persistDraft(item.id, next, newHistory, newHistory.length - 1, get().crop);
      },

      setValues: (partial) => {
        const { values, history, historyIndex, item } = get();
        const next = { ...values, ...partial };
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(next);
        if (newHistory.length > 50) newHistory.shift();
        set({ values: next, history: newHistory, historyIndex: newHistory.length - 1 });
        if (item) persistDraft(item.id, next, newHistory, newHistory.length - 1, get().crop);
      },

      reset: () => {
        const { history, historyIndex, item } = get();
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(defaultEdits);
        set({ values: defaultEdits, crop: defaultCrop, history: newHistory, historyIndex: newHistory.length - 1 });
        if (item) clearEditDraft(item.id);
      },

      clearDraft: () => {
        const { item } = get();
        if (item) clearEditDraft(item.id);
        set({ values: defaultEdits, crop: defaultCrop, history: [defaultEdits], historyIndex: 0 });
      },

      auto: () => {
        const { history, historyIndex, item } = get();
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(autoEdits);
        set({ values: autoEdits, history: newHistory, historyIndex: newHistory.length - 1 });
        if (item) persistDraft(item.id, autoEdits, newHistory, newHistory.length - 1, get().crop);
      },

      rotate: (degrees) => {
        const { values, history, historyIndex, item } = get();
        const next = { ...values, rotation: (values.rotation + degrees + 360) % 360 };
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(next);
        set({ values: next, history: newHistory, historyIndex: newHistory.length - 1 });
        if (item) persistDraft(item.id, next, newHistory, newHistory.length - 1, get().crop);
      },

      flip: () => {
        const { values, history, historyIndex, item } = get();
        const next = { ...values, flip: !values.flip };
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(next);
        set({ values: next, history: newHistory, historyIndex: newHistory.length - 1 });
        if (item) persistDraft(item.id, next, newHistory, newHistory.length - 1, get().crop);
      },

      setCrop: (partial) => {
        const { item, values, history, historyIndex, crop } = get();
        const nextCrop = { ...crop, ...partial };
        set({ crop: nextCrop });
        if (item) persistDraft(item.id, values, history, historyIndex, nextCrop);
      },

      resetCrop: () => {
        const { item, values, history, historyIndex } = get();
        set({ crop: defaultCrop });
        if (item) persistDraft(item.id, values, history, historyIndex, defaultCrop);
      },

      undo: () => {
        const { history, historyIndex, item } = get();
        if (historyIndex > 0) {
          const nextIndex = historyIndex - 1;
          set({ values: history[nextIndex], historyIndex: nextIndex });
          if (item) persistDraft(item.id, history[nextIndex], history, nextIndex, get().crop);
        }
      },

      redo: () => {
        const { history, historyIndex, item } = get();
        if (historyIndex < history.length - 1) {
          const nextIndex = historyIndex + 1;
          set({ values: history[nextIndex], historyIndex: nextIndex });
          if (item) persistDraft(item.id, history[nextIndex], history, nextIndex, get().crop);
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
    { name: "edit-store" }
  )
);

export const useEditItem = () => useEditStore((s) => s.item);
export const useEditValues = () => useEditStore((s) => s.values);
export const useEditCrop = () => useEditStore((s) => s.crop);
export const useEditHistory = () => useEditStore((s) => ({ canUndo: s.canUndo, canRedo: s.canRedo }));
