import { beforeEach, describe, expect, it, vi } from "vitest";

const library = vi.hoisted(() => {
  const state = {
    activeAlbum: null as string | null,
    setActiveAlbum: (id: string | null) => {
      state.activeAlbum = id;
    },
  };
  return state;
});

vi.mock("../engine/stores", () => ({
  useLibraryStore: { getState: () => library },
}));

import { HISTORY_LIMIT, useNavigationStore } from "./useNavigationStore";

const nav = () => useNavigationStore.getState();
const at = () => ({ screen: nav().screen, album: library.activeAlbum });

/** Open an album the way the app does: set it, then show Library. */
const openAlbum = (id: string) => {
  library.setActiveAlbum(id);
  nav().setScreen("Library");
};

describe("navigation history", () => {
  beforeEach(() => {
    library.activeAlbum = null;
    useNavigationStore.setState({ screen: "Library", album: null, history: [], forward: [] });
  });

  it("goes Back from an opened album to the Albums overview", () => {
    nav().setScreen("Albums");
    openAlbum("trip");
    expect(at()).toEqual({ screen: "Library", album: "trip" });

    nav().goBack();
    expect(at()).toEqual({ screen: "Albums", album: null });
    nav().goBack();
    expect(at()).toEqual({ screen: "Library", album: null });
    expect(nav().history).toEqual([]);
  });

  it("returns Forward into the album it left", () => {
    nav().setScreen("Albums");
    openAlbum("trip");
    nav().goBack();

    nav().goForward();
    expect(at()).toEqual({ screen: "Library", album: "trip" });
  });

  it("skips the viewer and player as steps of their own", () => {
    nav().setScreen("Viewer");
    nav().setScreen("Edit");

    nav().goBack();
    expect(at()).toEqual({ screen: "Library", album: null });
  });

  it("does not record launch, repeats, or a new forward trail after Back", () => {
    nav().replaceScreen("Albums");
    expect(nav().history).toEqual([]);

    nav().setScreen("Albums");
    expect(nav().history).toEqual([]);

    nav().setScreen("Batch");
    nav().goBack();
    nav().setScreen("Duplicates");
    expect(nav().forward).toEqual([]);
  });

  it(`keeps the last ${HISTORY_LIMIT} steps`, () => {
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) {
      nav().setScreen(index % 2 ? "Albums" : "Batch");
    }
    expect(nav().history).toHaveLength(HISTORY_LIMIT);
  });
});
