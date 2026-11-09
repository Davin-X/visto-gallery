/**
 * File names for display.
 *
 * `MediaItem.name` is the full file name including its extension
 * ("IMG_0042.HEIC"); `extension` is the lowercase extension on its own.
 */

/** The name to show, with or without its extension per the user's setting. */
export function displayFileName(name: string, extension: string, showExtension: boolean): string {
  if (showExtension || !extension) return name;
  const suffix = `.${extension}`;
  return name.toLowerCase().endsWith(suffix.toLowerCase()) && name.length > suffix.length
    ? name.slice(0, -suffix.length)
    : name;
}

/**
 * Split a name for middle truncation: the head may be cut with an ellipsis,
 * the tail always stays visible. Names in a folder often share a long prefix
 * ("selective-focus-shot-of-…"), so the end is what tells them apart.
 */
export function splitForMiddleTruncation(text: string, tailLength = 10): [string, string] {
  if (text.length <= tailLength * 2) return [text, ""];
  return [text.slice(0, -tailLength), text.slice(-tailLength)];
}
