/// <reference types="vitest/globals" />
import { vi } from "vitest";

// ---- In-memory SQLite backend for edit recipes ----
const recipes = vi.hoisted(() => new Map<string, any>());
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args: any) => {
    switch (cmd) {
      case "save_edit_recipe": {
        const { mediaId, edits, crop, history, historyIndex } = args;
        const now = Date.now();
        const row = {
          mediaId,
          edits,
          crop,
          history,
          historyIndex,
          createdAt: now,
          updatedAt: now,
        };
        recipes.set(mediaId, row);
        return row;
      }
      case "get_edit_recipe": {
        return recipes.get(args.mediaId) ?? null;
      }
      case "list_edit_recipes": {
        return [...recipes.values()];
      }
      case "delete_edit_recipe": {
        return recipes.delete(args.mediaId);
      }
      default:
        return undefined;
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ listen: vi.fn() })),
}));

import { tauri } from "../../engine/commands/tauri";
import {
  useEditStore,
  useDraftMetaStore,
  resetDraftRevision,
  clearEditDraft,
  hasEditChanges,
} from "../../engine/stores/useEditStore";
import type { EditValues } from "../../engine/types/media";

const baseEdits: EditValues = {
  exposure: 0,
  contrast: 0,
  warmth: 0,
  shadows: 0,
  highlights: 0,
  saturation: 0,
  rotation: 0,
  flip: false,
};
const baseCrop = {
  enabled: false,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  aspectRatio: "free" as const,
};

const item: any = {
  id: "item-1",
  path: "/tmp/item-1.jpg",
  name: "item-1.jpg",
  extension: "jpg",
  kind: "photo",
  size: 1024,
  modifiedAt: 1,
  capturedAt: 1,
  favorite: false,
  hidden: false,
  tags: [],
  albumIds: [],
  createdAt: 1,
  updatedAt: 1,
};

function resetStore() {
  recipes.clear();
  invoke.mockClear();
  localStorage.clear();
  resetDraftRevision();
  useEditStore.setState({
    item: null,
    values: { ...baseEdits },
    crop: { ...baseCrop },
    history: [{ ...baseEdits }],
    historyIndex: 0,
  });
}

beforeEach(resetStore);

test("setValue persists the draft to SQLite via saveRecipe", async () => {
  useEditStore.setState({ item });
  await useEditStore.getState().setValue("exposure", 20);

  expect(invoke).toHaveBeenCalledWith("save_edit_recipe", {
    mediaId: "item-1",
    edits: { ...baseEdits, exposure: 20 },
    history: expect.any(Array),
    historyIndex: expect.any(Number),
    crop: expect.anything(),
  });
  expect(useEditStore.getState().values.exposure).toBe(20);
});

test("saveDraft writes current values to SQLite", async () => {
  useEditStore.setState({
    item,
    values: { ...baseEdits, contrast: 30 },
    history: [{ ...baseEdits }, { ...baseEdits, contrast: 30 }],
    historyIndex: 1,
  });
  await useEditStore.getState().saveDraft();

  const saved = await tauri.edit.getRecipe("item-1");
  expect(saved).not.toBeNull();
  expect(saved!.edits.contrast).toBe(30);
});

test("open loads a previously saved recipe into state", async () => {
  await tauri.edit.saveRecipe({
    mediaId: "item-1",
    edits: { ...baseEdits, rotation: 90, flip: true },
    history: [{ ...baseEdits }, { ...baseEdits, rotation: 90, flip: true }],
    historyIndex: 1,
  });

  await useEditStore.getState().open(item);

  const state = useEditStore.getState();
  expect(state.item?.id).toBe("item-1");
  expect(state.values.rotation).toBe(90);
  expect(state.values.flip).toBe(true);
  expect(state.historyIndex).toBe(1);
});

test("open falls back to defaults when no recipe exists", async () => {
  await useEditStore.getState().open(item);
  expect(useEditStore.getState().values).toEqual(baseEdits);
});

test("clearDraft deletes the recipe from SQLite", async () => {
  await tauri.edit.saveRecipe({
    mediaId: "item-1",
    edits: { ...baseEdits, exposure: 10 },
    history: [{ ...baseEdits }, { ...baseEdits, exposure: 10 }],
    historyIndex: 1,
  });
  expect(await tauri.edit.getRecipe("item-1")).not.toBeNull();

  await clearEditDraft("item-1");
  expect(await tauri.edit.getRecipe("item-1")).toBeNull();
});

test("listRecipes returns all saved recipes for draft meta store", async () => {
  await tauri.edit.saveRecipe({
    mediaId: "item-1",
    edits: { ...baseEdits, rotation: 45 },
    history: [{ ...baseEdits }, { ...baseEdits, rotation: 45 }],
    historyIndex: 1,
  });
  await tauri.edit.saveRecipe({
    mediaId: "item-2",
    edits: { ...baseEdits, rotation: 0, flip: true },
    history: [{ ...baseEdits }, { ...baseEdits, rotation: 0, flip: true }],
    historyIndex: 1,
  });

  await useDraftMetaStore.getState().refresh();

  const meta = useDraftMetaStore.getState();
  expect(meta.ids.has("item-1")).toBe(true);
  expect(meta.ids.has("item-2")).toBe(true);
  expect(meta.transforms.get("item-1")).toEqual({ rotation: 45, flip: false });
  expect(meta.transforms.get("item-2")).toEqual({ rotation: 0, flip: true });
});

test("draft survives close and reopen", async () => {
  useEditStore.setState({ item });
  await useEditStore.getState().setValue("warmth", 15);

  await useEditStore.getState().close();
  expect(useEditStore.getState().item).toBeNull();

  await useEditStore.getState().open(item);
  expect(useEditStore.getState().values.warmth).toBe(15);
});

test("rotate persists and undo restores the prior draft", async () => {
  useEditStore.setState({ item });
  await useEditStore.getState().rotate(90);
  expect(useEditStore.getState().values.rotation).toBe(90);

  const saved = await tauri.edit.getRecipe("item-1");
  expect(saved!.edits.rotation).toBe(90);

  await useEditStore.getState().undo();
  expect(useEditStore.getState().values.rotation).toBe(0);
  const savedAgain = await tauri.edit.getRecipe("item-1");
  expect(savedAgain!.edits.rotation).toBe(0);
});

test("open prioritizes SQLite over stale localStorage draft", async () => {
  // Stale localStorage draft
  localStorage.setItem(
    "edit:draft:item-1",
    JSON.stringify({ edits: { ...baseEdits, exposure: -50 } }),
  );

  // Newer SQLite recipe
  await tauri.edit.saveRecipe({
    mediaId: "item-1",
    edits: { ...baseEdits, exposure: 35 },
    history: [{ ...baseEdits }, { ...baseEdits, exposure: 35 }],
    historyIndex: 1,
  });

  await useEditStore.getState().open(item);

  // SQLite value must win over localStorage
  expect(useEditStore.getState().values.exposure).toBe(35);
});

test("open falls back to localStorage draft when SQLite has nothing", async () => {
  localStorage.setItem(
    "edit:draft:item-1",
    JSON.stringify({ edits: { ...baseEdits, warmth: 25 } }),
  );

  await useEditStore.getState().open(item);

  // Falls back to localStorage
  expect(useEditStore.getState().values.warmth).toBe(25);
});

test("saveDraft does not persist if there are no changes and no existing draft", async () => {
  useEditStore.setState({ item, values: { ...baseEdits }, crop: { ...baseCrop } });
  await useEditStore.getState().saveDraft();

  expect(invoke).not.toHaveBeenCalledWith("save_edit_recipe", expect.anything());
  expect(await tauri.edit.getRecipe("item-1")).toBeNull();
});

test("hasEditChanges accurately detects modifications", () => {
  expect(hasEditChanges(baseEdits, baseCrop)).toBe(false);
  expect(hasEditChanges({ ...baseEdits, exposure: 1 }, baseCrop)).toBe(true);
  expect(hasEditChanges(baseEdits, { ...baseCrop, enabled: true })).toBe(true);
});
