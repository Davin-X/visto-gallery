import type {
  FinderTagCopyResult,
  FinderTagFailure,
} from "../types/commands";

export interface FinderTagItem {
  id: string;
  path: string;
  tags?: string[];
}

/**
 * Finder tag names are case-insensitive for comparison. Keep the first spelling
 * so a tag already in Finder is not renamed just because the catalog uses a
 * different capitalization.
 */
export function dedupeTagNames(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * Copy VistoGallery tags to Finder for a bounded batch of files.
 *
 * The native command merges with existing Finder tags, so tags added outside
 * the app are never removed. Failures are collected per file instead of
 * rejecting the whole batch.
 */
export async function copyTagsToFinder(
  items: FinderTagItem[],
  merge: (path: string, tags: string[]) => Promise<string[]>,
  concurrency = 4,
): Promise<FinderTagCopyResult> {
  const failed: FinderTagFailure[] = [];
  const tagsByPath: Record<string, string[]> = {};
  let updated = 0;
  let skipped = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      const tags = dedupeTagNames(item.tags ?? []);
      if (tags.length === 0) {
        skipped += 1;
        continue;
      }
      try {
        const merged = await merge(item.path, tags);
        tagsByPath[item.path] = merged;
        updated += 1;
      } catch (error) {
        failed.push({
          path: item.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return { updated, skipped, failed, tagsByPath };
}
