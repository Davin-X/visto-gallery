/**
 * Date formatting for media items.
 *
 * Two kinds of timestamp live on an item, and they must be shown differently:
 *
 * - `capturedAt` comes from EXIF, which records the camera's wall-clock time
 *   with no time zone. The backend stores that wall-clock time as if it were
 *   UTC, so it is formatted in UTC to show exactly what the camera recorded.
 * - `modifiedAt` is a real instant from the file system, shown in local time.
 *
 * Dates use a month name ("11 Jul 2026" or "Jul 11, 2026", by locale) so they
 * are never ambiguous the way "7/11/2026" is.
 */

interface DatedItem {
  capturedAt?: number | null;
  modifiedAt: number;
}

const DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const DAY_TIME: Intl.DateTimeFormatOptions = { ...DAY, hour: "numeric", minute: "2-digit" };
const MONTH: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" };

function format(ms: number, options: Intl.DateTimeFormatOptions, wallClock: boolean): string {
  return new Intl.DateTimeFormat(
    undefined,
    wallClock ? { ...options, timeZone: "UTC" } : options,
  ).format(ms);
}

/** The date an item is sorted and grouped by, and whether it is wall-clock time. */
export function itemTimestamp(item: DatedItem): { ms: number; wallClock: boolean } {
  return item.capturedAt != null
    ? { ms: item.capturedAt, wallClock: true }
    : { ms: item.modifiedAt, wallClock: false };
}

/** "11 Jul 2026": the capture date, or the modification date as a fallback. */
export function formatItemDate(item: DatedItem): string {
  const { ms, wallClock } = itemTimestamp(item);
  return format(ms, DAY, wallClock);
}

/** Capture date and time exactly as the camera recorded it. */
export function formatCapturedDateTime(capturedAt: number): string {
  return format(capturedAt, DAY_TIME, true);
}

/** Capture date only, as the camera recorded it. */
export function formatCapturedDate(capturedAt: number): string {
  return format(capturedAt, DAY, true);
}

/** A file-system instant (modified, created), in local time. */
export function formatFileDateTime(ms: number): string {
  return format(ms, DAY_TIME, false);
}

/** A file-system instant as a date only, in local time. */
export function formatFileDate(ms: number): string {
  return format(ms, DAY, false);
}

/** Stable year-month key and "July 2026" label for timeline grouping. */
export function itemMonth(item: DatedItem): { key: string; label: string } {
  const { ms, wallClock } = itemTimestamp(item);
  const date = new Date(ms);
  const year = wallClock ? date.getUTCFullYear() : date.getFullYear();
  const month = wallClock ? date.getUTCMonth() : date.getMonth();
  return { key: `${year}-${month}`, label: format(ms, MONTH, wallClock) };
}
