import { formatBytesSimple } from "../utils/mediaTypes";
import type { MediaItem } from "../types/media";
import { formatCapturedDate, formatFileDate } from "../utils/mediaDate";

export interface CompareRow {
  label: string;
  keeper: string;
  copy: string;
  /** True when the two files disagree on this field. */
  differs: boolean;
}

const DASH = "—";

function text(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === "") return DASH;
  return String(value);
}

function parentFolder(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
}

function capturedDate(ms?: number | null): string {
  return ms ? formatCapturedDate(ms) : DASH;
}

function fileDate(ms?: number): string {
  return ms ? formatFileDate(ms) : DASH;
}

function dimensions(item: MediaItem): string {
  if (!item.width || !item.height) return DASH;
  return `${item.width} × ${item.height}`;
}

function location(item: MediaItem): string {
  // The backend serialises a missing Option<f64> as `null`, not `undefined`,
  // so a truthiness/undefined check would throw on every GPS-less photo.
  const { latitude, longitude } = item;
  if (typeof latitude !== "number" || typeof longitude !== "number") return DASH;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return DASH;
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

/**
 * The fields that decide whether two "identical" copies really are
 * interchangeable. Hashes match by definition inside a group, so a differing
 * hash row would mean the group itself is stale — worth surfacing anyway.
 */
export function compareRows(keeper: MediaItem, copy: MediaItem): CompareRow[] {
  const rows: Omit<CompareRow, "differs">[] = [
    { label: "File", keeper: keeper.name, copy: copy.name },
    { label: "Folder", keeper: parentFolder(keeper.path), copy: parentFolder(copy.path) },
    { label: "Size", keeper: formatBytesSimple(keeper.size), copy: formatBytesSimple(copy.size) },
    { label: "Dimensions", keeper: dimensions(keeper), copy: dimensions(copy) },
    {
      label: "Format",
      keeper: text(keeper.extension?.toUpperCase()),
      copy: text(copy.extension?.toUpperCase()),
    },
    { label: "Kind", keeper: text(keeper.kind), copy: text(copy.kind) },
    {
      label: "Captured",
      keeper: capturedDate(keeper.capturedAt),
      copy: capturedDate(copy.capturedAt),
    },
    { label: "Modified", keeper: fileDate(keeper.modifiedAt), copy: fileDate(copy.modifiedAt) },
    { label: "Camera", keeper: text(keeper.camera), copy: text(copy.camera) },
    { label: "Lens", keeper: text(keeper.lens), copy: text(copy.lens) },
    { label: "Exposure", keeper: text(keeper.exposure), copy: text(copy.exposure) },
    { label: "ISO", keeper: text(keeper.iso), copy: text(copy.iso) },
    { label: "Location", keeper: location(keeper), copy: location(copy) },
    { label: "Rating", keeper: text(keeper.rating), copy: text(copy.rating) },
    {
      label: "Hash",
      keeper: text(keeper.sha256?.slice(0, 16)),
      copy: text(copy.sha256?.slice(0, 16)),
    },
  ];
  return rows.map((row) => ({ ...row, differs: row.keeper !== row.copy }));
}

/** How many rows disagree, used for the "N differences" summary. */
export function differenceCount(rows: CompareRow[]): number {
  return rows.filter((row) => row.differs).length;
}
