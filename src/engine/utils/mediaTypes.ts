/**
 * Centralized media type identifiers — single source of truth for the kind
 * labels and badge/dot class helpers across the app. Badge and dot colors
 * live in CSS (`.kind-badge.*` / `.kind-dot.*`) so they follow the theme.
 */

export type MediaKind = "photo" | "video" | "raw";

export interface TypeIdentity {
  /** Short display label (e.g., "Photo", "Video", "RAW") */
  label: string;
}

// Containers WKWebView can decode on macOS. Everything else (Matroska, AVI,
// WMV, MPEG-TS, ...) would render as a black frame, so the app must not hand
// those files to a <video> element: WebKit asks for the whole file and can
// freeze the UI on multi-gigabyte media.
const IN_APP_VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "ogv"]);

/** Lowercase extension of a path or file name, ignoring query strings. */
export function fileExtension(value?: string): string {
  if (!value) return "";
  const clean = value.split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot + 1).toLowerCase();
}

/** Whether a video container can play inside the app's <video> element. */
export function canPlayVideoInApp(path?: string, name?: string): boolean {
  const ext = fileExtension(path) || fileExtension(name);
  return !ext || IN_APP_VIDEO_EXTENSIONS.has(ext);
}

/** Why a video failed to play in the app. */
export type VideoFailureKind = "format" | "unavailable";

/**
 * Classify a <video> load failure from `HTMLMediaElement.error.code`:
 * 1 aborted, 2 network, 3 decode, 4 src not supported.
 *
 * Only an unsupported container or a decode error (3) is a format problem.
 * MEDIA_ERR_SRC_NOT_SUPPORTED (4) is also what a missing file, a disconnected
 * drive or a permission error looks like, so it must not be reported as a
 * format problem. Callers should ignore MEDIA_ERR_ABORTED (1), which is a
 * navigation race rather than a failure.
 */
export function classifyVideoFailure(
  code: number | undefined,
  path?: string,
  name?: string,
): VideoFailureKind {
  if (!canPlayVideoInApp(path, name)) return "format";
  return code === 3 ? "format" : "unavailable";
}

export const TYPE_IDENTITY: Record<MediaKind, TypeIdentity> = {
  photo: { label: "Photo" },
  video: { label: "Video" },
  raw: { label: "RAW" },
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
