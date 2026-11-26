import { useCallback, useEffect, useState } from "react";
import { CpuIcon } from "../icons";
import { formatBytes, tauri } from "../../../engine/commands/tauri";
import { errorCode } from "../../../engine/types/errors";
import type { CacheKind, ErrorCode, StorageUsage } from "../../../engine/types/commands";
import { clearThumbnailMemoryCache } from "../CachedThumbnail";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function files(count: number): string {
  return `${count.toLocaleString()} file${count === 1 ? "" : "s"}`;
}

/**
 * What VistoGallery stores beside your media, with the two caches the user can
 * clear. Clearing never touches media files, the catalog, or edit originals.
 */
export function StorageSection(props: { showNotice: (text: string, code?: ErrorCode) => void }) {
  const { showNotice } = props;
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [clearing, setClearing] = useState<CacheKind | null>(null);

  const refresh = useCallback(async () => {
    setFailed(false);
    try {
      setUsage(await tauri.storage.usage());
    } catch {
      setUsage(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clear = useCallback(
    async (kind: CacheKind) => {
      setClearing(kind);
      try {
        const result = await tauri.storage.clear(kind);
        if (kind === "thumbnails") clearThumbnailMemoryCache();
        const kept =
          result.keptFiles > 0
            ? `${files(result.keptFiles)} still in use ${result.keptFiles === 1 ? "was" : "were"} kept.`
            : "";
        const freed = result.freedBytes > 0 ? `Freed ${formatBytes(result.freedBytes)}.` : "";
        showNotice([freed, kept].filter(Boolean).join(" ") || "Nothing to clear.");
      } catch (error) {
        showNotice(`Could not clear the cache: ${describe(error)}`, errorCode(error) ?? "io");
      } finally {
        setClearing(null);
        void refresh();
      }
    },
    [refresh, showNotice],
  );

  const row = (
    label: string,
    desc: string,
    value: string,
    action?: { kind: CacheKind; label: string; disabled: boolean },
  ) => (
    <div className="settings-row">
      <div className="settings-row-label">
        <b>{label}</b>
        <span className="settings-row-desc">{desc}</span>
      </div>
      <div className="settings-row-control settings-storage-control">
        <span className="settings-slider-value">{value}</span>
        {action && (
          <button
            className="quiet-button"
            type="button"
            onClick={() => void clear(action.kind)}
            disabled={action.disabled || clearing !== null}
          >
            {clearing === action.kind ? "Clearing…" : action.label}
          </button>
        )}
      </div>
    </div>
  );

  const show = (format: (value: StorageUsage) => string) =>
    usage ? format(usage) : failed ? "Unavailable" : "Loading…";

  return (
    <section className="settings-section" aria-label="Storage">
      <h2 className="settings-section-title">
        <CpuIcon size={14} /> Storage
      </h2>
      <p className="settings-section-desc">
        Space VistoGallery uses on this Mac, outside your library folders. Clearing a cache only
        means thumbnails and converted videos are made again when needed.
      </p>
      {failed && (
        <p role="status">
          Storage usage unavailable.{" "}
          <button className="quiet-button" type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </p>
      )}
      {row(
        "Thumbnails",
        "Cached previews for the grid, viewer and editor",
        show((u) => `${formatBytes(u.thumbnailBytes)} · ${files(u.thumbnailFiles)}`),
        { kind: "thumbnails", label: "Clear", disabled: !usage?.thumbnailFiles },
      )}
      {row(
        "Converted videos",
        "MKV and HEVC copies made so they play in the app",
        show((u) => `${formatBytes(u.playbackBytes)} · ${files(u.playbackFiles)}`),
        { kind: "playback", label: "Clear", disabled: !usage?.playbackFiles },
      )}
      {row(
        "Catalog",
        "Albums, tags, ratings, edits and settings",
        show((u) => formatBytes(u.catalogBytes)),
      )}
      {row(
        "Edit originals",
        "Original files saved before in-place edits, so edits can be reverted",
        show((u) => `${formatBytes(u.editOriginalBytes)} · ${files(u.editOriginalFiles)}`),
      )}
    </section>
  );
}
