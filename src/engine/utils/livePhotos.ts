import type { MediaItem } from "../types/media";

function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(0, idx) : "";
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Map a Live Photo's still (HEIC/HEIF) to its paired motion clip (MOV with the
 * same stem in the same folder). Matching is by folder + filename stem, the
 * same heuristic Apple uses for Live Photos.
 */
export function livePhotoMotionMap(items: readonly MediaItem[]): Map<string, MediaItem> {
  const motionByKey = new Map<string, MediaItem>();
  for (const candidate of items) {
    if (candidate.kind !== "video") continue;
    if (candidate.extension.toLowerCase() !== "mov") continue;
    const key = `${parentDir(candidate.path)}\u0000${stem(candidate.name)}`;
    if (!motionByKey.has(key)) motionByKey.set(key, candidate);
  }
  const result = new Map<string, MediaItem>();
  for (const item of items) {
    if (item.kind !== "photo") continue;
    if (item.extension.toLowerCase() !== "heic" && item.extension.toLowerCase() !== "heif")
      continue;
    const key = `${parentDir(item.path)}\u0000${stem(item.name)}`;
    const motion = motionByKey.get(key);
    if (motion) result.set(item.id, motion);
  }
  return result;
}

export function isLivePhoto(item: MediaItem, items: readonly MediaItem[]): boolean {
  return livePhotoMotionMap(items).has(item.id);
}
