import type { MediaItem } from "../../engine/types/media";

/** Returns the viewer resolution badge label, tooltip, and tone for a previewed photo. */
export function getPreviewBadge(
  kind: MediaItem["kind"],
  shown: { full: boolean; lowRes: boolean; fullFailed?: boolean } | null,
  wantsFull: boolean,
): { label: string; title: string; tone: "preview" | "loading" | "full" } {
  const isRaw = kind === "raw";
  if (!shown || shown.lowRes) {
    return {
      label: isRaw ? "RAW preview" : "Preview",
      title:
        "Showing a lower-resolution preview while the full image loads, or because it could not be decoded",
      tone: "preview",
    };
  }
  if (!shown.full) {
    if (wantsFull && !shown.fullFailed) {
      return {
        label: isRaw ? "Rendering full RAW…" : "Loading full render…",
        title: "Rendering the full-resolution image",
        tone: "loading",
      };
    }
    return {
      label: isRaw ? "RAW preview" : "Preview",
      title: shown.fullFailed
        ? "Could not render the full-resolution image; showing the screen-size preview"
        : "Showing a screen-size preview. Zoom to 150%+, switch to Actual, or press 1 for the full render",
      tone: "preview",
    };
  }
  return {
    label: "Full render",
    title: isRaw
      ? "Showing the full-resolution decoded RAW render"
      : "Showing the full-resolution render",
    tone: "full",
  };
}
