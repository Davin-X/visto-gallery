/// <reference types="vitest/globals" />
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ listen: vi.fn() })),
}));

import type { MediaItem } from "../../types/media";
import { useLibraryStore } from "../useLibraryStore";

function makeItem(id: string): MediaItem {
  const now = 1_700_000_000_000;
  return {
    id,
    path: `/tmp/${id}.jpg`,
    name: `${id}.jpg`,
    extension: "jpg",
    kind: "photo",
    size: 100,
    modifiedAt: now,
    favorite: false,
    hidden: false,
    isAnimated: false,
    tags: [],
    albumIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

test("map scope browses the photos the map handed over, even ones the library has not loaded", () => {
  useLibraryStore.setState({ items: [makeItem("loaded")] });
  const store = useLibraryStore.getState();
  store.setMapItems([makeItem("paris"), makeItem("rome")]);
  store.setViewerScope("map");
  store.inspectItem("rome");

  const state = useLibraryStore.getState();
  expect(state.viewerItems.map((i) => i.id)).toEqual(["paris", "rome"]);
  expect(state.viewerSelected?.id).toBe("rome");
});
