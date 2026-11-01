import type { DraftTransform } from "../stores/useEditStore";
import { draftTransformStyle } from "../stores/useEditStore";

/**
 * Apply the item's saved edit draft to a preview image. Passing the shared map
 * keeps this synchronous and avoids a localStorage read per tile.
 */
export function draftImageStyle(
  transforms: Map<string, DraftTransform> | undefined,
  itemId: string,
) {
  const transform = draftTransformStyle(transforms?.get(itemId));
  return transform ? { transform } : undefined;
}
