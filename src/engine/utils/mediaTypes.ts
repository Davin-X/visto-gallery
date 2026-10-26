/**
 * Centralized media type identifiers - single source of truth for
 * type colors, icons, labels, and display strings across the entire app.
 */

export type MediaKind = "photo" | "video" | "raw";

export interface TypeIdentity {
  /** Short display label (e.g., "Photo", "Video", "RAW") */
  label: string;
  /** Color for dots, badges, accents */
  color: string;
  /** Soft background color for badges */
  softColor: string;
  /** Icon name for inline SVG/icons */
  icon: string;
  /** Whether this type supports dimensions */
  hasDimensions: boolean;
  /** Whether this type supports duration */
  hasDuration: boolean;
}

export const TYPE_IDENTITY: Record<MediaKind, TypeIdentity> = {
  photo: {
    label: "Photo",
    color: "#3b82f6",
    softColor: "rgba(59,130,246,0.12)",
    icon: "photo",
    hasDimensions: true,
    hasDuration: false,
  },
  video: {
    label: "Video",
    color: "#22c55e",
    softColor: "rgba(34,197,94,0.12)",
    icon: "video",
    hasDimensions: true,
    hasDuration: true,
  },
  raw: {
    label: "RAW",
    color: "#f97316",
    softColor: "rgba(249,115,22,0.12)",
    icon: "raw",
    hasDimensions: true,
    hasDuration: false,
  },
};

/** Get type identity for a media kind */
export function getTypeIdentity(kind: MediaKind): TypeIdentity {
  return TYPE_IDENTITY[kind] ?? TYPE_IDENTITY.photo;
}

/** Get CSS class for a kind badge */
export function getKindBadgeClass(kind: MediaKind): string {
  return `kind-badge ${kind}`;
}

/** Get CSS class for a kind dot */
export function getKindDotClass(kind: MediaKind): string {
  return `kind-dot ${kind}`;
}

/** Get SVG icon for a kind (inline SVG string) */
export function getKindIcon(kind: MediaKind, size = 14): string {
  const icons: Record<MediaKind, string> = {
    photo: `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 2v12M10 2v12M2 6h12M2 10h12"/></svg>`,
    video: `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h8v8H4z"/><path d="M4 8h8"/></svg>`,
    raw: `<svg width="${size}" height="${16}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h8v8H4z"/><path d="M4 8h8"/></svg>`,
  };
  return icons[kind] ?? icons.photo;
}
export function formatBytesSimple(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}
