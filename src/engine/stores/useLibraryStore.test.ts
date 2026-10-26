/// <reference types="vitest/globals" />
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn(() => ({ listen: vi.fn() })) }));

vi.mock("../commands/tauri", () => ({
  tauri: {
    items: { toggleFavorite: vi.fn().mockResolvedValue(undefined) },
    albums: {
      create: vi.fn().mockResolvedValue({ id: "album-1", name: "Trip", itemCount: 0 }),
      delete: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      addItems: vi.fn().mockResolvedValue(undefined),
    },
    library: { getItems: vi.fn().mockResolvedValue([]) },
  },
  formatBytes: (n: number) => `${n} B`,
}));

import { useLibraryStore } from "../../engine/stores/useLibraryStore";
import type { MediaItem } from "../../engine/types/media";

function makeItem(id: string, name: string, favorite = false, kind: "photo" | "video" = "photo"): MediaItem {
  const now = Date.now();
  return {
    id,
    path: `/tmp/${name}`,
    name,
    extension: name.split(".").pop() || "",
    kind,
    size: 100,
    modifiedAt: now,
    favorite,
    hidden: false,
    tags: [],
    albumIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(() => {
  useLibraryStore.setState(useLibraryStore.getInitialState());
});

test("setFilter narrows visible items", () => {
  const a = makeItem("a", "photo.jpg");
  const b = makeItem("b", "clip.mp4", false, "video");
  useLibraryStore.setState({ items: [a, b] });
  useLibraryStore.getState().refreshDerived();
  expect(useLibraryStore.getState().visibleItems.map((i) => i.id)).toEqual(["a", "b"]);

  useLibraryStore.getState().setFilter("Videos");
  expect(useLibraryStore.getState().visibleItems.map((i) => i.id)).toEqual(["b"]);
});

test("setQuery narrows visible items", () => {
  const a = makeItem("a", "sunset.jpg");
  const b = makeItem("b", "mountain.jpg");
  useLibraryStore.setState({ items: [a, b] });
  useLibraryStore.getState().refreshDerived();

  useLibraryStore.getState().setQuery("sunset");
  expect(useLibraryStore.getState().visibleItems.map((i) => i.id)).toEqual(["a"]);
});

test("toggleFavorite updates item and derived state", async () => {
  const a = makeItem("a", "photo.jpg", false);
  useLibraryStore.setState({ items: [a] });
  useLibraryStore.getState().refreshDerived();

  await useLibraryStore.getState().toggleFavorite("a");
  expect(useLibraryStore.getState().items[0].favorite).toBe(true);
});
test("createAlbum adds album and links selected items", async () => {
  const a = makeItem("a", "photo.jpg");
  useLibraryStore.setState({ items: [a], selectedIds: ["a"] });
  useLibraryStore.getState().refreshDerived();

  await useLibraryStore.getState().createAlbum("Trip");
  const state = useLibraryStore.getState();
  expect(state.albums).toHaveLength(1);
  expect(state.albums[0].id).toBe("album-1");
  expect(state.items[0].albumIds).toContain("album-1");
  expect(state.activeAlbum).toBe("album-1");
});

test("deleteAlbum removes album but keeps items", async () => {
  const a = makeItem("a", "photo.jpg");
  a.albumIds = ["album-1"];
  useLibraryStore.setState({
    items: [a],
    albums: [{ id: "album-1", name: "Trip", itemCount: 1 } as any],
    activeAlbum: "album-1",
  });
  useLibraryStore.getState().refreshDerived();

  await useLibraryStore.getState().deleteAlbum("album-1");
  const state = useLibraryStore.getState();
  expect(state.albums).toHaveLength(0);
  expect(state.items[0].albumIds).not.toContain("album-1");
  expect(state.activeAlbum).toBeNull();
});

test("renameAlbum updates album name", async () => {
  useLibraryStore.setState({
    albums: [{ id: "album-1", name: "Trip", itemCount: 0 } as any],
  });
  await useLibraryStore.getState().renameAlbum("album-1", "Vacation");
  expect(useLibraryStore.getState().albums[0].name).toBe("Vacation");
});