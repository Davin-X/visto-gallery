import { useEffect } from "react";
import type { MediaItem } from "../../engine/types/media";

/**
 * Prefetch the immediate photo neighbors of `selectedIndex` after a brief settle,
 * cancelling in-flight image loads when the user keeps arrowing through the filmstrip.
 * RAW display previews are not speculatively requested because backend ImageIO renders
 * cannot be cancelled once dispatched.
 */
export function useViewerPrefetch(
  items: MediaItem[],
  selectedIndex: number,
  assetUrl: (path: string) => string,
) {
  useEffect(() => {
    if (selectedIndex < 0) return;
    const neighbors = [items[selectedIndex + 1], items[selectedIndex - 1]].filter(
      (item): item is MediaItem => Boolean(item) && item.kind === "photo",
    );
    if (neighbors.length === 0) return;

    let cancelled = false;
    const pendingImages: HTMLImageElement[] = [];
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      for (const item of neighbors) {
        const img = new Image();
        img.decoding = "async";
        img.src = `${assetUrl(item.path)}?v=${item.id}-${item.modifiedAt}-${item.size}`;
        pendingImages.push(img);
      }
    }, 60);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      for (const img of pendingImages) {
        if (!img.complete) img.src = "";
      }
    };
  }, [items, selectedIndex, assetUrl]);
}
