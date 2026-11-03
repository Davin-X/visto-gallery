import { useSettingsStore } from "../../engine/stores";
import { useSlideshowStore } from "../../engine/stores";
import type { MediaItem } from "../../engine/types/media";

/**
 * Apply the item's saved edit draft to a preview image. Passing the shared map
 * keeps this synchronous and avoids a localStorage read per tile.
 */
export function startConfiguredSlideshow(items: MediaItem[], startId?: string | null) {
  const preferences = useSettingsStore.getState();
  const slideshow = useSlideshowStore.getState();
  slideshow.setInterval(preferences.slideshowInterval);
  slideshow.setShuffle(preferences.slideshowShuffle);
  slideshow.setLoop(preferences.slideshowLoop);
  slideshow.open(items, startId);
}
