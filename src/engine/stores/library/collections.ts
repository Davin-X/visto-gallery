import type { DuplicateGroup } from "../../types/media";
import type { SmartAlbum } from "../../types/commands";

/** Mirror the server's `ORDER BY name COLLATE NOCASE` so a newly created or
 *  renamed album lands where a reload would put it. */
export function sortSmartAlbums(albums: SmartAlbum[]): SmartAlbum[] {
  return [...albums].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

export function mergeDuplicateGroups(
  previous: DuplicateGroup[],
  current: DuplicateGroup[],
): DuplicateGroup[] {
  // Merge by sha256, preferring groups from current (which has newer hashes)
  // but keeping any previous groups that aren't in current.
  const byHash = new Map<string, DuplicateGroup>();
  for (const g of current) {
    byHash.set(g.sha256, g);
  }
  for (const g of previous) {
    if (!byHash.has(g.sha256)) {
      byHash.set(g.sha256, g);
    }
  }
  // Sort: largest groups first, then by size
  return [...byHash.values()].sort((a, b) => b.items.length - a.items.length || b.size - a.size);
}
