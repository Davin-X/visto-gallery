import type { ContextMenuItem } from "../../design/components/ContextMenu";
import { tauri } from "../commands/tauri";
import type { MediaItem } from "../types/media";

/**
 * What the surface can do with the item in its menu. Every handler is
 * optional, so the menu only offers actions the surface actually performs: a
 * grid tile adds "Open", the viewer is already open; a video adds "Play in
 * background", a photo adds "Edit".
 */
export interface ItemMenuActions {
  onOpen?: (id: string) => void;
  onPlayBackground?: (id: string) => void;
  onEdit?: (item: MediaItem) => void;
  onCopyTagsToFinder?: (ids: string[]) => void | Promise<void>;
  onOpenAlbumPicker?: (ids: string[]) => void;
  onCreateAlbum?: (ids: string[]) => void;
  /** Current album, when the surface is scoped to one. */
  activeAlbum?: string | null;
  onRequestRemoveFromAlbum?: (albumId: string, ids: string[]) => void;
  onToggleFavorite?: (id: string) => void | Promise<void>;
  onSetRating?: (ids: string[], rating: number) => void | Promise<void>;
  onSetColorLabel?: (ids: string[], colorLabel: string | null) => void | Promise<void>;
  onToggleHidden?: (id: string) => void | Promise<void>;
  onRequestDelete?: (ids: string[]) => void;
}

const COLOR_LABELS = [
  { label: "Red", value: "red" },
  { label: "Yellow", value: "yellow" },
  { label: "Green", value: "green" },
  { label: "Blue", value: "blue" },
  { label: "Purple", value: "purple" },
];

/**
 * The item menu shown on right-click, built once so the library grid, the
 * Hidden grid and the photo viewer offer the same actions in the same order.
 */
export function buildItemContextMenu(item: MediaItem, actions: ItemMenuActions): ContextMenuItem[] {
  const ids = [item.id];
  const menu: ContextMenuItem[] = [];

  if (actions.onOpen) {
    menu.push({ label: "Open", onClick: () => actions.onOpen?.(item.id) });
  }
  if (item.kind === "video" && actions.onPlayBackground) {
    menu.push({
      label: "Play in background",
      onClick: () => actions.onPlayBackground?.(item.id),
    });
  }
  if (item.kind === "photo" && actions.onEdit) {
    menu.push({ label: "Edit", onClick: () => actions.onEdit?.(item) });
  }

  menu.push(
    { label: "Open in default app", onClick: () => tauri.items.openFile(item.path) },
    { label: "Show in Finder", onClick: () => tauri.items.revealInFinder(item.path) },
    {
      label: "Copy tags to Finder",
      disabled: !(item.tags || []).length,
      onClick: () => actions.onCopyTagsToFinder?.(ids),
    },
  );

  const albumActions =
    actions.onOpenAlbumPicker ||
    actions.onCreateAlbum ||
    (actions.activeAlbum && actions.onRequestRemoveFromAlbum);
  if (albumActions) {
    menu.push({ divider: true });
    if (actions.onOpenAlbumPicker) {
      menu.push({
        label: "Add to Album…",
        onClick: () => actions.onOpenAlbumPicker?.(ids),
      });
    }
    if (actions.activeAlbum && actions.onRequestRemoveFromAlbum) {
      menu.push({
        label: "Remove from this Album",
        danger: true,
        onClick: () => actions.onRequestRemoveFromAlbum?.(actions.activeAlbum!, ids),
      });
    }
    if (actions.onCreateAlbum) {
      menu.push({ label: "New Album…", onClick: () => actions.onCreateAlbum?.(ids) });
    }
  }

  menu.push({ divider: true });

  if (actions.onToggleFavorite) {
    menu.push({ label: "Favorite", onClick: () => actions.onToggleFavorite?.(item.id) });
  }
  if (actions.onSetRating) {
    const rating = item.rating ?? 0;
    menu.push({
      label: rating ? `Rating ${"★".repeat(rating)}` : "Rating",
      icon: rating ? (
        <span className="ctx-star">★</span>
      ) : (
        <span className="ctx-star ctx-star-empty">☆</span>
      ),
      submenu: [
        {
          label: <span className="ctx-star ctx-star-empty">Unrate</span>,
          onClick: () => actions.onSetRating?.(ids, 0),
        },
        ...[1, 2, 3, 4, 5].map((stars) => ({
          label: <span className="ctx-star">{"★".repeat(stars)}</span>,
          onClick: () => actions.onSetRating?.(ids, stars),
        })),
      ],
    });
  }
  if (actions.onSetColorLabel) {
    menu.push({
      label: "Color Label",
      icon: item.colorLabel ? <span className={`ctx-dot ctx-dot-${item.colorLabel}`} /> : null,
      submenu: [
        {
          label: "None",
          icon: <span className="ctx-dot ctx-dot-none" />,
          onClick: () => actions.onSetColorLabel?.(ids, null),
        },
        ...COLOR_LABELS.map((color) => ({
          label: color.label,
          icon: <span className={`ctx-dot ctx-dot-${color.value}`} />,
          onClick: () => actions.onSetColorLabel?.(ids, color.value),
        })),
      ],
    });
  }
  if (actions.onToggleHidden) {
    menu.push({
      label: item.hidden ? "Unhide" : "Hide",
      onClick: () => actions.onToggleHidden?.(item.id),
    });
  }
  if (actions.onRequestDelete) {
    // The destructive action sits apart from the toggles above it.
    menu.push({ divider: true });
    menu.push({
      label: "Move to Trash…",
      danger: true,
      onClick: () => actions.onRequestDelete?.(ids),
    });
  }

  return menu;
}
