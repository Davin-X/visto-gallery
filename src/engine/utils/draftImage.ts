import type { DraftTransform } from "../stores/useEditStore";
import { draftTransformStyle } from "../stores/useEditStore";

export function draftImageStyle(
  transforms: Map<string, DraftTransform> | undefined,
  itemId: string,
) {
  const transform = draftTransformStyle(transforms?.get(itemId));
  return transform ? { transform } : undefined;
}
