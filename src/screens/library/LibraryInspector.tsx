import type { ComponentProps } from "react";
import { CachedThumbnail } from "../../design/components/CachedThumbnail";
import {
  CheckIcon,
  DetailsIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  HeartIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
} from "../../design/components/icons";
import { KindBadge } from "../../design/components/KindBadge";
import { tauri } from "../../engine/commands/tauri";
import type { DraftTransform } from "../../engine/stores/useEditStore";
import type { MediaItem } from "../../engine/types/media";
import { draftImageStyle } from "../../engine/utils/draftImage";
import { formatCapturedDateTime, formatFileDateTime } from "../../engine/utils/mediaDate";
import { formatBytesSimple } from "../../engine/utils/mediaTypes";
import type { LibraryScreenProps } from "./types";

/** The folder holding `path` ("/a/b/c.jpg" → "/a/b"). */
function parentFolder(path: string) {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
}

/** Just the folder's own name, for a compact Location value. */
function folderName(path: string) {
  const folder = parentFolder(path);
  return folder.slice(folder.lastIndexOf("/") + 1) || folder;
}

type InspectorActions = Pick<
  LibraryScreenProps,
  | "onOpenViewer"
  | "onSetRatingForIds"
  | "onSetColorLabelForIds"
  | "onToggleFavorite"
  | "onToggleHidden"
  | "onToggleInspector"
  | "onToggleSelect"
  | "onUpdateTags"
>;

interface LibraryInspectorProps {
  item: MediaItem | undefined;
  isSelected: boolean;
  selectedCount: number;
  masked: boolean;
  previewHandlers?: ComponentProps<"button">;
  assetUrl: LibraryScreenProps["assetUrl"];
  draftTransforms: Map<string, DraftTransform>;
  veiled: boolean;
  canPlayBackground: boolean;
  playingId: string | null;
  isPlaying: boolean;
  toggleBackground: (item: MediaItem) => void;
  copyItemPath: (path: string, itemId: string) => void;
  copiedPathFor: string | null;
  actions: InspectorActions;
}

export function LibraryInspector({
  item: sel,
  isSelected,
  selectedCount,
  masked,
  previewHandlers,
  assetUrl,
  draftTransforms,
  veiled,
  canPlayBackground,
  playingId,
  isPlaying,
  toggleBackground,
  copyItemPath,
  copiedPathFor,
  actions: props,
}: LibraryInspectorProps) {
  // Inspection is independent of selection, including when several items are selected.
  const name = masked ? "Hidden item" : (sel?.name ?? "");
  return (
    <aside className="photo-inspector">
      {sel ? (
        <>
          <div className="inspector-top">
            <div>
              <small>
                {selectedCount > 1 && isSelected ? "SELECTED · INSPECTING" : "INSPECTING"}
              </small>
              <h2 title={name}>{name}</h2>
              {selectedCount > 1 && (
                <span className="inspector-selection-note">
                  {selectedCount.toLocaleString()} selected · details for this one
                </span>
              )}
            </div>
            <button
              type="button"
              className="inspector-close-btn"
              onClick={props.onToggleInspector}
              title="Close Inspector (⌥⌘I)"
            >
              ×
            </button>
          </div>
          <span className="inspector-image-wrapper">
            <button
              className={`inspector-image${masked ? " hidden-obscured" : ""}`}
              type="button"
              aria-label={
                masked
                  ? "Hold to reveal preview; double-click to open"
                  : `Open ${sel.name} in viewer`
              }
              onClick={veiled ? undefined : () => props.onOpenViewer(sel.id)}
              onDoubleClick={veiled ? () => props.onOpenViewer(sel.id) : undefined}
              title={
                masked
                  ? "Hold to reveal preview · double-click to open"
                  : veiled
                    ? "Double-click to open in viewer"
                    : "Open in viewer"
              }
              {...previewHandlers}
            >
              {sel.kind === "photo" ? (
                (() => {
                  const ext = (sel.extension || "").toLowerCase();
                  const isAnimatedPhoto =
                    !!sel.isAnimated || ext === "gif" || ext === "webp" || ext === "apng";
                  return isAnimatedPhoto ? (
                    <span className="inspector-video-preview">
                      <img
                        src={assetUrl(sel.path)}
                        alt={name}
                        draggable={false}
                        style={draftImageStyle(draftTransforms, sel.id)}
                      />
                    </span>
                  ) : (
                    // A cached 512px preview, not the original: a 40 MB
                    // photo does not need a full decode for this frame,
                    // and a missing or offline file shows "Preview
                    // unavailable" instead of a broken image.
                    <CachedThumbnail
                      itemId={sel.id}
                      name={name}
                      size={512}
                      eager
                      showStatus
                      fallbackSrc={assetUrl(sel.path)}
                      style={draftImageStyle(draftTransforms, sel.id)}
                    />
                  );
                })()
              ) : sel.kind === "video" ? (
                <span className="inspector-video-preview">
                  <video
                    src={assetUrl(sel.path)}
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    aria-label={`${name} preview`}
                  />
                </span>
              ) : (
                <CachedThumbnail
                  itemId={sel.id}

                  name={name}

                  size={512}

                  style={draftImageStyle(draftTransforms, sel.id)}
                />
              )}
              <span>{veiled ? "Double-click to view" : "Open in viewer"}</span>
              <span className="inspector-type-badge">
                {sel.kind === "video"
                  ? "Video"
                  : sel.kind === "raw"
                    ? "RAW"
                    : sel.isAnimated ||
                        ["gif", "webp", "apng"].includes((sel.extension || "").toLowerCase())
                      ? "Animation"
                      : "Photo"}
              </span>
            </button>
            {sel.kind === "video" && canPlayBackground && (
              <button
                type="button"
                className="inspector-video-play"
                aria-label={
                  playingId === sel.id && isPlaying ? `Pause ${name}` : `Play ${name} in background`
                }
                aria-pressed={playingId === sel.id && isPlaying}
                title={playingId === sel.id && isPlaying ? "Pause" : "Play in background"}
                onClick={() => toggleBackground(sel)}
              >
                {playingId === sel.id && isPlaying ? (
                  <PauseIcon size={20} />
                ) : (
                  <PlayIcon size={20} />
                )}
              </button>
            )}
          </span>
          <div className="inspector-actions">
            {sel.kind === "video" ? (
              <button
                className="inspector-action primary"
                onClick={() => toggleBackground(sel)}
                title={
                  playingId === sel.id && isPlaying
                    ? "Pause — the top bar controls the session"
                    : "Play in background — keep browsing; the top bar shows playback"
                }
                aria-pressed={playingId === sel.id && isPlaying}
              >
                {playingId === sel.id && isPlaying ? (
                  <PauseIcon size={14} />
                ) : (
                  <PlayIcon size={14} />
                )}
                <span>{playingId === sel.id && isPlaying ? "Pause" : "Play"}</span>
              </button>
            ) : (
              <button
                className="inspector-action primary"
                onClick={() => props.onOpenViewer(sel.id)}
                title="View item"
              >
                <PlayIcon size={14} />
                <span>View</span>
              </button>
            )}
            <button
              className={`inspector-action ${sel.favorite ? "favorite active" : ""}`}
              onClick={() => props.onToggleFavorite(sel.id)}
              title={sel.favorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={!!sel.favorite}
            >
              {/* The label stays "Favorite"; the filled heart and
          pressed state show it is on. "Unfavorite" was too
          long for the button and spilled out of it. */}
              <HeartIcon size={14} filled={!!sel.favorite} />
              <span>Favorite</span>
            </button>
            <button
              className="inspector-action"
              onClick={() => props.onToggleHidden(sel.id)}
              title={sel.hidden ? "Unhide" : "Hide"}
            >
              {sel.hidden ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
              <span>{sel.hidden ? "Show" : "Hide"}</span>
            </button>
            <button
              className={`inspector-action ${isSelected ? "active" : ""}`}
              onClick={() => props.onToggleSelect(sel.id)}
              title={isSelected ? "Remove from selection" : "Add to selection"}
              aria-pressed={isSelected}
            >
              {isSelected ? <CheckIcon size={14} /> : <PlusIcon size={14} />}
              <span>Select</span>
            </button>
          </div>
          {!masked && (
            <div className="inspector-section">
              <div className="inspector-section-head">
                <b>Rating &amp; Label</b>
              </div>
              <div className="inspector-star-row" role="group" aria-label="Rating">
                {[1, 2, 3, 4, 5].map((value) => {
                  const active = (sel.rating ?? 0) >= value;
                  const clears = sel.rating === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      className={`inspector-star${active ? " filled" : ""}`}
                      aria-label={
                        clears ? "Clear rating" : `${value} star${value === 1 ? "" : "s"}`
                      }
                      aria-pressed={clears}
                      title={
                        clears ? "Clear rating" : `Rate ${value} star${value === 1 ? "" : "s"}`
                      }
                      onClick={() => props.onSetRatingForIds([sel.id], clears ? 0 : value)}
                    >
                      ★
                    </button>
                  );
                })}
              </div>
              <div className="inspector-color-row" role="group" aria-label="Color label">
                {["red", "yellow", "green", "blue", "purple"].map((color) => {
                  const active = sel.colorLabel === color;
                  const label = color[0].toUpperCase() + color.slice(1);
                  return (
                    <button
                      key={color}
                      type="button"
                      className={`inspector-color${active ? " active" : ""}`}
                      aria-label={active ? `Clear ${color} label` : `${label} label`}
                      aria-pressed={active}
                      title={active ? `Clear ${color} label` : `${label} label`}
                      onClick={() => props.onSetColorLabelForIds([sel.id], active ? null : color)}
                    >
                      <span className={`ctx-dot ctx-dot-${color}`} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="inspector-section">
            <div className="inspector-section-head">
              <b>File Info</b>
            </div>
            <div className="info-card">
              {masked ? (
                <div className="inspector-hidden-note">
                  Hold the preview to reveal file details.
                </div>
              ) : (
                <>
                  {/* The name is already the inspector heading; repeating
              it here was redundant. */}
                  <div className="info-row">
                    <span className="info-label">Kind</span>
                    <span className="info-value">
                      <KindBadge kind={sel.kind} />
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">Format</span>
                    <span className="info-value">{sel.extension.toUpperCase()}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">Dimensions</span>
                    <span className="info-value">
                      {sel.width && sel.height ? `${sel.width} × ${sel.height}` : "—"}
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">Size</span>
                    <span className="info-value">{formatBytesSimple(sel.size)}</span>
                  </div>
                  {sel.camera && (
                    <div className="info-row">
                      <span className="info-label">Camera</span>
                      <span className="info-value" title={sel.camera}>
                        {sel.camera}
                      </span>
                    </div>
                  )}
                  {sel.lens && (
                    <div className="info-row">
                      <span className="info-label">Lens</span>
                      <span className="info-value" title={sel.lens}>
                        {sel.lens}
                      </span>
                    </div>
                  )}
                  {sel.exposure && (
                    <div className="info-row">
                      <span className="info-label">Exposure</span>
                      <span className="info-value">{sel.exposure}</span>
                    </div>
                  )}
                  {sel.iso != null && (
                    <div className="info-row">
                      <span className="info-label">ISO</span>
                      <span className="info-value">{sel.iso}</span>
                    </div>
                  )}
                  {typeof sel.latitude === "number" &&
                    typeof sel.longitude === "number" &&
                    Number.isFinite(sel.latitude) &&
                    Number.isFinite(sel.longitude) && (
                      <div className="info-row">
                        <span className="info-label">GPS</span>
                        <button
                          type="button"
                          className="info-value info-link"
                          title="Open in Maps"
                          onClick={() =>
                            void tauri.app.openExternal(
                              `https://maps.apple.com/?ll=${sel.latitude},${sel.longitude}`,
                            )
                          }
                        >
                          {sel.latitude.toFixed(4)}, {sel.longitude.toFixed(4)}
                        </button>
                      </div>
                    )}
                  {sel.title && (
                    <div className="info-row">
                      <span className="info-label">Title</span>
                      <span className="info-value" title={sel.title}>
                        {sel.title}
                      </span>
                    </div>
                  )}
                  {sel.capturedAt && (
                    <div className="info-row">
                      <span className="info-label">Captured</span>
                      <span className="info-value">{formatCapturedDateTime(sel.capturedAt)}</span>
                    </div>
                  )}
                  <div className="info-row">
                    <span className="info-label">Location</span>
                    <button
                      type="button"
                      className="info-value info-link"
                      title={`${parentFolder(sel.path)} — Show in Finder`}
                      onClick={() => void tauri.items.revealInFinder(sel.path)}
                    >
                      {folderName(sel.path)}
                    </button>
                  </div>
                  <div className="info-row">
                    <span className="info-label">Modified</span>
                    <span className="info-value">{formatFileDateTime(sel.modifiedAt)}</span>
                  </div>
                  {sel.hidden && (
                    <div className="info-row">
                      <span className="info-label">Hidden</span>
                      <span className="info-value">
                        {sel.hiddenReason === "manual"
                          ? "Hidden manually"
                          : sel.hiddenReason
                            ? `Hidden (${sel.hiddenReason})`
                            : "No reason recorded"}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          {!masked && (
            <div className="inspector-section">
              <div className="inspector-section-head">
                <b>File</b>
              </div>
              <div className="inspector-file-actions">
                <button
                  type="button"
                  className="inspector-action"
                  onClick={() => void tauri.items.revealInFinder(sel.path)}
                  title="Show this file in Finder"
                >
                  <FolderIcon size={14} />
                  <span>Show in Finder</span>
                </button>
                <button
                  type="button"
                  className="inspector-action"
                  onClick={() => void tauri.items.openFile(sel.path)}
                  title="Open in the default app"
                >
                  <PlayIcon size={14} />
                  <span>Open in default app</span>
                </button>
                <button
                  type="button"
                  className="inspector-action"
                  onClick={() => copyItemPath(sel.path, sel.id)}
                  title="Copy the full file path"
                >
                  <DetailsIcon size={14} />
                  <span>{copiedPathFor === sel.id ? "Path copied" : "Copy path"}</span>
                </button>
              </div>
            </div>
          )}
          {!masked && (
            <div className="inspector-tags">
              <div className="inspector-section-head">
                <b>App Tags</b>
              </div>
              <div className="tags-list">
                {sel.tags?.map((tag: string) => (
                  <span className="app-tag" key={tag}>
                    {tag}
                    <button
                      type="button"
                      aria-label={`Remove tag ${tag}`}
                      title={`Remove tag “${tag}”`}
                      onClick={() =>
                        props.onUpdateTags(
                          sel.id,
                          (sel.tags || []).filter((t: string) => t !== tag),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <input
                className="tag-input"
                aria-label="Add tag"
                placeholder="Add tag and press Enter…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.currentTarget.value.trim()) {
                    const newTag = e.currentTarget.value.trim();
                    const currentTags = sel.tags || [];
                    // "Beach" and "beach" are the same tag.
                    const known = currentTags.some(
                      (tag) => tag.toLowerCase() === newTag.toLowerCase(),
                    );
                    if (!known) {
                      props.onUpdateTags(sel.id, [...currentTags, newTag]);
                    }
                    e.currentTarget.value = "";
                  }
                }}
              />
            </div>
          )}
        </>
      ) : (
        <div className="inspector-empty-state">
          <div className="inspector-top">
            <div>
              <small>INSPECTOR</small>
              <h2>Nothing selected</h2>
            </div>
            <button
              type="button"
              className="inspector-close-btn"
              onClick={props.onToggleInspector}
              title="Close Inspector"
            >
              ×
            </button>
          </div>
          <div className="inspector-empty-placeholder">
            <span className="inspector-empty-icon">
              <DetailsIcon size={26} />
            </span>
            <p>
              Click a photo or video to see its details here. To pick several for an action, use the
              checkbox on each one.
            </p>
          </div>
        </div>
      )}
    </aside>
  );
}
