import { afterEach, expect, test, vi } from "vitest";
import { timelineKey } from "../../../screens/timeline/monthCache";
import { tauri } from "../../commands/tauri";
import type { MediaItem } from "../../types/media";
import { useLibraryStore } from "../useLibraryStore";

const store = useLibraryStore;
const initialState = store.getInitialState();
const january = Date.UTC(2024, 0, 2);
const photo = (id: string): MediaItem => ({
  id,
  kind: "photo",
  capturedAt: january,
  tags: [],
  hidden: false,
  path: `/test/${id}.jpg`,
  name: `${id}.jpg`,
  extension: "jpg",
  size: 1,
  modifiedAt: january,
  createdAt: january,
  updatedAt: january,
  favorite: false,
  isAnimated: false,
  albumIds: [],
});

function setup(cursor: string | null) {
  const first = photo("older");
  store.setState({ layout: "timeline", screen: "Viewer", inspectedId: first.id });
  const view = timelineKey(store.getState(), false);
  store.setState({
    timelineCache: { view, pages: new Map([["2024-01", { items: [first], nextCursor: cursor }]]) },
  });
  store.getState().refreshDerived();
  return first;
}

afterEach(() => {
  store.setState(initialState, true);
  vi.restoreAllMocks();
});

test("Viewer loads another page of a partially loaded month before advancing", async () => {
  setup("next");
  const nextPhoto = photo("next-photo");
  const query = vi.spyOn(tauri.library, "getItems").mockResolvedValue({
    items: [nextPhoto],
    hasMore: false,
    totalCount: 2,
  });

  expect(await store.getState().navigateViewerPhoto(1)).toBe(true);
  expect(query).toHaveBeenCalledWith(expect.objectContaining({ month: "2024-01", cursor: "next" }));
  expect(store.getState().viewerSelected?.id).toBe(nextPhoto.id);
});

test("a tag edit updates the Timeline photo that the Viewer is inspecting", async () => {
  const first = setup(null);
  vi.spyOn(tauri.items, "updateTags").mockResolvedValue(undefined);
  await store.getState().updateItemTags(first.id, ["one"]);
  expect(store.getState().viewerSelected?.tags).toEqual(["one"]);
  await store.getState().updateItemTags(first.id, ["one", "two"]);
  expect(store.getState().viewerSelected?.tags).toEqual(["one", "two"]);
});
