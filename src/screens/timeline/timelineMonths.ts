import { useCallback, useEffect, useState } from "react";
import { tauri } from "../../engine/commands/tauri";
import type { LibraryFilterDTO, MediaItem, TimelineMonth } from "../../engine/types/commands";
import { itemMonthKey } from "../../engine/utils/mediaDate";

/**
 * The Timeline's months for the current library filter, with counts from the
 * catalog rather than from whichever pages happen to be loaded.
 *
 * `null` while loading or when the backend has no answer (browser preview);
 * callers fall back to grouping the loaded items.
 */
export function useTimelineMonths(
  enabled: boolean,
  filter: LibraryFilterDTO,
  refreshKey: string,
): TimelineMonth[] | null {
  const [months, setMonths] = useState<{ view: string; rows: TimelineMonth[] } | null>(null);
  useEffect(() => {
    if (!enabled) {
      setMonths(null);
      return;
    }
    let cancelled = false;
    // Paging and sort never change which months exist.
    const rest: LibraryFilterDTO = {
      ...filter,
      limit: undefined,
      cursor: undefined,
      sortBy: undefined,
      sortOrder: undefined,
    };
    tauri.library
      .getTimelineMonths(rest)
      .then((result) => {
        if (!cancelled)
          setMonths(Array.isArray(result) ? { view: refreshKey, rows: result } : null);
      })
      .catch(() => {
        if (!cancelled) setMonths(null);
      });
    return () => {
      cancelled = true;
    };
    // `refreshKey` carries the filter identity; `filter` is a fresh object
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshKey]);
  return enabled && months?.view === refreshKey ? months.rows : null;
}

/** Months built from loaded items, for when the catalog cannot answer. */
export function monthsFromItems(items: MediaItem[]): TimelineMonth[] {
  const byKey = new Map<string, TimelineMonth>();
  for (const item of items) {
    const key = itemMonthKey(item);
    const month = byKey.get(key) ?? { key, count: 0, coverIds: [] };
    month.count += 1;
    if (month.coverIds.length < 4) month.coverIds.push(item.id);
    byKey.set(key, month);
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

export function monthYear(key: string): string {
  return key.slice(0, 4);
}

/** Explicit collapse choices; anything not listed follows the default. */
export interface CollapseOverrides {
  months: Record<string, boolean>;
  years: Record<string, boolean>;
}

const STORAGE_KEY = "vistogallery.timeline.collapsed.v2";

function readOverrides(): CollapseOverrides {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (parsed && typeof parsed === "object") {
      const value = parsed as Partial<CollapseOverrides>;
      return { months: { ...(value.months ?? {}) }, years: { ...(value.years ?? {}) } };
    }
  } catch {
    // Storage may be unavailable; the defaults still work.
  }
  return { months: {}, years: {} };
}

function writeOverrides(overrides: CollapseOverrides): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Not remembering a collapse is harmless.
  }
}

/** Explicit month and year choices override the folded default. */
export function isMonthCollapsed(overrides: CollapseOverrides, key: string): boolean {
  return overrides.months[key] ?? overrides.years[monthYear(key)] ?? true;
}

/** Collapse state remembered across launches, per viewer. */
export function useTimelineCollapse() {
  const [overrides, setOverrides] = useState<CollapseOverrides>(readOverrides);
  const update = useCallback((next: (current: CollapseOverrides) => CollapseOverrides) => {
    setOverrides((current) => {
      const value = next(current);
      writeOverrides(value);
      return value;
    });
  }, []);

  const setMonth = useCallback(
    (key: string, collapsed: boolean) =>
      update((current) => ({ ...current, months: { ...current.months, [key]: collapsed } })),
    [update],
  );

  /** Fold or unfold every month of a year, dropping per-month choices there. */
  const setYear = useCallback(
    (year: string, collapsed: boolean) =>
      update((current) => ({
        months: Object.fromEntries(
          Object.entries(current.months).filter(([key]) => monthYear(key) !== year),
        ),
        years: { ...current.years, [year]: collapsed },
      })),
    [update],
  );

  /** Option-click: every year and month at once. */
  const setAll = useCallback(
    (years: string[], collapsed: boolean) =>
      update(() => ({
        months: {},
        years: Object.fromEntries(years.map((year) => [year, collapsed])),
      })),
    [update],
  );

  return { overrides, setMonth, setYear, setAll };
}

export function groupYears<T extends { key: string; count: number; collapsed: boolean }>(
  months: T[],
) {
  const years = new Map<string, { year: string; count: number; collapsed: boolean; months: T[] }>();
  for (const month of months) {
    const year = monthYear(month.key);
    const group = years.get(year) ?? { year, count: 0, collapsed: true, months: [] };
    group.count += month.count;
    group.collapsed &&= month.collapsed;
    group.months.push(month);
    years.set(year, group);
  }
  return years;
}
