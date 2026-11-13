import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeMediaItem } from "../test/fixtures";
import { useDraftItems } from "./useDraftItems";

const mocks = vi.hoisted(() => ({ getItemsByIds: vi.fn() }));

vi.mock("../engine/commands/tauri", () => ({
  tauri: { library: { getItemsByIds: mocks.getItemsByIds } },
}));

describe("useDraftItems", () => {
  beforeEach(() => {
    mocks.getItemsByIds.mockReset();
  });

  it("lists every drafted photo from the catalog, not just loaded pages", async () => {
    mocks.getItemsByIds.mockResolvedValue([
      makeMediaItem({ id: "a", kind: "photo" }),
      makeMediaItem({ id: "b", kind: "photo" }),
    ]);
    const ids = new Set(["a", "b"]);
    const { result } = renderHook(() => useDraftItems(ids));

    await waitFor(() => expect(result.current.map((item) => item.id)).toEqual(["a", "b"]));
    expect(mocks.getItemsByIds).toHaveBeenCalledWith(["a", "b"]);
  });

  it("leaves out hidden items and non-photos", async () => {
    mocks.getItemsByIds.mockResolvedValue([
      makeMediaItem({ id: "shown", kind: "photo" }),
      makeMediaItem({ id: "hidden", kind: "photo", hidden: true }),
      makeMediaItem({ id: "clip", kind: "video" }),
    ]);
    const ids = new Set(["shown", "hidden", "clip"]);
    const { result } = renderHook(() => useDraftItems(ids));

    await waitFor(() => expect(result.current.map((item) => item.id)).toEqual(["shown"]));
  });

  it("does not query the catalog when there are no drafts", () => {
    const { result } = renderHook(() => useDraftItems(new Set()));

    expect(result.current).toEqual([]);
    expect(mocks.getItemsByIds).not.toHaveBeenCalled();
  });

  it("shows an empty list when the lookup fails", async () => {
    mocks.getItemsByIds.mockRejectedValue(new Error("catalog unavailable"));
    const { result } = renderHook(() => useDraftItems(new Set(["a"])));

    await waitFor(() => expect(mocks.getItemsByIds).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });
});
