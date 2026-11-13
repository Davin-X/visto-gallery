import { describe, expect, it, vi } from "vitest";
import type { ContextMenuItem } from "../../design/components/ContextMenu";
import { makeMediaItem } from "../../test/fixtures";
import { buildItemContextMenu } from "./itemContextMenu";

vi.mock("../commands/tauri", () => ({ tauri: { items: {} } }));

const find = (menu: ContextMenuItem[], label: string) =>
  menu.find((entry) => entry.label === label);

describe("buildItemContextMenu", () => {
  const a = makeMediaItem({ id: "a", favorite: false });
  const b = makeMediaItem({ id: "b", favorite: true });
  const c = makeMediaItem({ id: "c", favorite: false });

  it("acts on the whole selection when the clicked item is in it", () => {
    const onSetFavorite = vi.fn();
    const onSetHidden = vi.fn();
    const onRequestDelete = vi.fn();
    const menu = buildItemContextMenu(a, {
      selection: [a, b],
      onSetFavorite,
      onSetHidden,
      onRequestDelete,
    });

    expect(menu[0]).toMatchObject({ label: "2 items selected", heading: true });
    find(menu, "Unfavorite")?.onClick?.();
    expect(onSetFavorite).toHaveBeenCalledWith(["a", "b"], false);
    find(menu, "Hide")?.onClick?.();
    expect(onSetHidden).toHaveBeenCalledWith(["a", "b"], true);
    find(menu, "Move to Trash…")?.onClick?.();
    expect(onRequestDelete).toHaveBeenCalledWith(["a", "b"]);
  });

  it("acts on the clicked item alone when it is outside the selection", () => {
    const onSetFavorite = vi.fn();
    const menu = buildItemContextMenu(c, { selection: [a, b], onSetFavorite });

    expect(find(menu, "2 items selected")).toBeUndefined();
    find(menu, "Favorite")?.onClick?.();
    expect(onSetFavorite).toHaveBeenCalledWith(["c"], true);
  });

  it("names the favorite state for a single item", () => {
    const onToggleFavorite = vi.fn();
    expect(find(buildItemContextMenu(b, { onToggleFavorite }), "Unfavorite")).toBeTruthy();
    expect(find(buildItemContextMenu(a, { onToggleFavorite }), "Favorite")).toBeTruthy();
  });
});
