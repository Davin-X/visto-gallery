import { useEffect, useState } from "react";
import { tauri } from "../engine/commands/tauri";
import type { MediaItem } from "../engine/types/media";

const EMPTY: MediaItem[] = [];

/**
 * The photos that have a saved edit draft, newest draft first, fetched by id
 * from the catalog. Reading them from the library's loaded pages instead (as
 * this list once did) showed only drafts among the items the grid happened to
 * have loaded, so the count changed with whatever view was open last.
 */
export function useDraftItems(draftIds: Set<string>): MediaItem[] {
  const [items, setItems] = useState<MediaItem[]>(EMPTY);
  // Key the lookup on the ids themselves, not the Set's identity, so a caller
  // that builds a new Set each render does not refetch (or loop) needlessly.
  const idKey = [...draftIds].join("\n");
  useEffect(() => {
    let cancelled = false;
    const ids = idKey ? idKey.split("\n") : [];
    if (ids.length === 0) {
      setItems(EMPTY);
      return;
    }
    tauri.library
      .getItemsByIds(ids)
      .then((found) => {
        if (cancelled) return;
        setItems(found.filter((item) => item.kind === "photo" && !item.hidden));
      })
      .catch(() => {
        if (!cancelled) setItems(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [idKey]);
  return items;
}
