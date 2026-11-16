import type {
  JunkCategory,
  JunkCategoryReport,
  JunkItem,
  JunkTier,
  SkipReason,
} from "../types/commands";

/** The order the Cleanup screen presents categories in. */
export const JUNK_CATEGORY_ORDER: readonly JunkCategory[] = [
  "xcode",
  "packages",
  "projects",
  "downloads",
];

export const JUNK_CATEGORY_COPY: Record<
  JunkCategory,
  { title: string; short: string; blurb: string }
> = {
  xcode: {
    title: "Xcode",
    short: "Xcode",
    blurb: "Build products, previews and device symbols Xcode regenerates.",
  },
  packages: {
    title: "Developer caches",
    short: "Caches",
    blurb: "Package managers and build tools fetch these again on demand.",
  },
  projects: {
    title: "Project build folders",
    short: "Projects",
    blurb: "node_modules, target, .venv and friends next to their project manifest.",
  },
  downloads: {
    title: "Old installers",
    short: "Installers",
    blurb: "Disk images, packages and Xcode installers in Downloads older than 30 days.",
  },
};

export const JUNK_TIER_COPY: Record<JunkTier, { label: string; hint: string }> = {
  regenerable: {
    label: "Regenerates",
    hint: "The tool recreates this on its own",
  },
  rebuildable: {
    label: "Needs rebuild",
    hint: "You will re-run an install or download to get this back",
  },
};

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  appRunning: "In use",
  recentActivity: "Active",
  unreadable: "No access",
  gitTracked: "Git",
  sensitive: "Protected",
  neverClean: "Never clean",
};

/** Per-category scan state while the parallel scans come back. */
export type CategoryScan =
  | { state: "idle" }
  | { state: "scanning"; previous?: JunkCategoryReport }
  | { state: "done"; report: JunkCategoryReport }
  | { state: "failed"; message: string };

export function reportOf(scan: CategoryScan | undefined): JunkCategoryReport | undefined {
  if (!scan) return undefined;
  if (scan.state === "done") return scan.report;
  if (scan.state === "scanning") return scan.previous;
  return undefined;
}

/** Every item currently known, in category order. */
export function allItems(scans: Partial<Record<JunkCategory, CategoryScan>>): JunkItem[] {
  return JUNK_CATEGORY_ORDER.flatMap((category) => reportOf(scans[category])?.items ?? []);
}

/** Bytes represented by the selected ids (unknown ids count as zero). */
export function selectedBytes(items: JunkItem[], selected: ReadonlySet<string>): number {
  return items.reduce((sum, item) => (selected.has(item.id) ? sum + item.bytes : sum), 0);
}

/** Ids the one-click "Select regenerable" picks: never anything that needs a rebuild. */
export function regenerableIds(items: JunkItem[]): string[] {
  return items.filter((item) => item.tier === "regenerable").map((item) => item.id);
}

export function totalBytes(items: JunkItem[], tier?: JunkTier): number {
  return items.reduce(
    (sum, item) => (tier === undefined || item.tier === tier ? sum + item.bytes : sum),
    0,
  );
}

export function allSelected(items: JunkItem[], selected: ReadonlySet<string>): boolean {
  return items.length > 0 && items.every((item) => selected.has(item.id));
}

export function someSelected(items: JunkItem[], selected: ReadonlySet<string>): boolean {
  return items.some((item) => selected.has(item.id));
}

/** Drop selected ids that are no longer in the list (after a rescan). */
export function pruneSelection(selected: ReadonlySet<string>, items: JunkItem[]): Set<string> {
  const known = new Set(items.map((item) => item.id));
  return new Set([...selected].filter((id) => known.has(id)));
}

const DAY = 24 * 60 * 60 * 1000;

/** True when the item was used in the last week: worth a second look before removing. */
export function recentlyUsed(item: JunkItem, now = Date.now()): boolean {
  return item.lastUsedAt !== null && now - item.lastUsedAt < 7 * DAY;
}

/** "today", "3 days ago", "2 months ago" — coarse on purpose. */
export function lastUsedLabel(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "last use unknown";
  const days = Math.max(0, Math.floor((now - timestamp) / DAY));
  if (days === 0) return "used today";
  if (days === 1) return "used yesterday";
  if (days < 30) return `used ${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `used ${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `used ${years} year${years === 1 ? "" : "s"} ago`;
}

/** "Today, 14:05", "Yesterday", "12 Nov" for the history list. */
export function runDateLabel(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Today, ${time}`;
  const yesterday = new Date(now - DAY);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Share of `part` in `whole` as a CSS percentage, clamped and never NaN. */
export function percent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0 || part <= 0) return "0%";
  return `${Math.min(100, (part / whole) * 100).toFixed(2)}%`;
}
