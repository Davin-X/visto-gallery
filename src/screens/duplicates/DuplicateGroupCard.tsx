import { CachedThumbnail } from "../../design/components/CachedThumbnail";
import {
  CheckIcon,
  ChevronDownIcon,
  ColumnsIcon,
  EyeIcon,
  FolderIcon,
} from "../../design/components/icons";
import { KindBadge } from "../../design/components/KindBadge";
import { MiddleTruncate } from "../../design/components/MiddleTruncate";
import { tauri } from "../../engine/commands/tauri";
import type { GroupView } from "../../engine/duplicates/grouping";
import type { MediaItem, SimilarGroup } from "../../engine/types/media";
import { formatFileDate } from "../../engine/utils/mediaDate";
import { formatBytesSimple } from "../../engine/utils/mediaTypes";
import { parentFolder } from "./paths";

// Enough tiles to fill one row of a wide window; expansion reveals the rest.
export const INLINE_COPIES = 4;

interface GroupItemActions {
  selected: ReadonlySet<string>;
  assetUrl: (path: string) => string;
  onOpenItem?: (id: string) => void;
  toggleItem: (id: string) => void;
  onCompare: (item: { sha: string; copyId: string }) => void;
}

interface DuplicateTileProps extends GroupItemActions {
  view: GroupView;
  item: MediaItem;
}

interface DuplicateGroupCardProps extends GroupItemActions {
  view: GroupView;
  expanded: boolean;
  busy: boolean;
  viewMode: "grid" | "list";
  burst?: SimilarGroup;
  toggleGroupCopies: (view: GroupView) => void;
  toggleGroupExpand: (sha256: string) => void;
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return "";
  return formatFileDate(timestamp);
}

function DuplicateTile({
  view,
  item,
  selected,
  assetUrl,
  onOpenItem,
  toggleItem,
  onCompare,
}: DuplicateTileProps) {
  const isKeeper = item.id === view.keeper.id;
  const isSelected = selected.has(item.id);

  return (
    <figure
      className={`duplicate-tile${isSelected ? " is-selected" : ""}${isKeeper ? " is-keeper" : ""}`}
    >
      <div className="duplicate-tile-frame">
        <button
          type="button"
          className="duplicate-tile-select"
          aria-pressed={isSelected}
          aria-label={`${isSelected ? "Deselect" : "Select"} ${item.name} in ${parentFolder(item.path)}`}
          onClick={() => toggleItem(item.id)}
        >
          {item.kind === "raw" ? (
            <span className="duplicate-tile-raw">
              <KindBadge kind="raw" />
            </span>
          ) : (
            <CachedThumbnail
              itemId={item.id}
              name={item.name}
              size={256}
              fallbackSrc={item.kind === "photo" ? assetUrl(item.path) : undefined}
            />
          )}
        </button>
        <span className={`duplicate-tile-check${isSelected ? " is-on" : ""}`} aria-hidden="true">
          {isSelected ? <CheckIcon size={11} /> : null}
        </span>
        <span className={`duplicate-tile-role${isKeeper ? " is-keeper" : ""}`}>
          {isKeeper ? "Keep" : "Copy"}
        </span>
        {item.kind === "video" && (
          <span className="duplicate-tile-kind">
            <KindBadge kind="video" />
          </span>
        )}
        <span className="duplicate-tile-tools">
          {!isKeeper && view.copies.length > 0 && (
            <button
              type="button"
              className="duplicate-tile-tool"
              title="Compare with keeper"
              aria-label={`Compare ${item.name} with the keeper`}
              onClick={() => onCompare({ sha: view.group.sha256, copyId: item.id })}
            >
              <ColumnsIcon size={13} />
            </button>
          )}
          {onOpenItem && (
            <button
              type="button"
              className="duplicate-tile-tool"
              title="Open in viewer"
              aria-label={`Open ${item.name}`}
              onClick={() => onOpenItem(item.id)}
            >
              <EyeIcon size={13} />
            </button>
          )}
          <button
            type="button"
            className="duplicate-tile-tool"
            title="Show in Finder"
            aria-label={`Show ${item.name} in Finder`}
            onClick={() => void tauri.items.revealInFinder(item.path)}
          >
            <FolderIcon size={13} />
          </button>
        </span>
      </div>
      <figcaption className="duplicate-tile-caption">
        <span className="duplicate-tile-head">
          <span className={`duplicate-tile-flag${isKeeper ? " is-keeper" : ""}`}>
            {isKeeper ? "Keep" : "Copy"}
          </span>
          <span className="duplicate-tile-name" title={item.path}>
            {item.name}
          </span>
        </span>
        <span className="duplicate-tile-meta">
          {formatBytesSimple(item.size)}
          {item.width && item.height ? ` · ${item.width}×${item.height}` : ""}
          {formatDate(item.createdAt || item.modifiedAt)
            ? ` · ${formatDate(item.createdAt || item.modifiedAt)}`
            : ""}
        </span>
        <MiddleTruncate text={parentFolder(item.path)} className="duplicate-tile-path" />
      </figcaption>
    </figure>
  );
}

const renderStackThumb = (item: MediaItem) =>
  item.kind === "raw" ? (
    <span className="duplicate-stack-raw">
      <KindBadge kind="raw" />
    </span>
  ) : (
    <CachedThumbnail itemId={item.id} name="" size={128} />
  );

export function DuplicateGroupCard({
  view,
  expanded,
  busy,
  viewMode,
  burst,
  selected,
  toggleGroupCopies,
  toggleGroupExpand,
  assetUrl,
  onOpenItem,
  toggleItem,
  onCompare,
}: DuplicateGroupCardProps) {
  const { group } = view;
  const visible = expanded ? view.ordered : view.ordered.slice(0, INLINE_COPIES);
  const hiddenCount = view.ordered.length - visible.length;
  const copyIds = view.copies.map((item) => item.id);
  const allCopiesSelected = copyIds.length > 0 && copyIds.every((id) => selected.has(id));
  const groupFullySelected = view.ordered.every((item) => selected.has(item.id));

  return (
    <section className="duplicate-group">
      <header className="duplicate-group-head">
        <button
          type="button"
          className="duplicate-group-summary"
          aria-expanded={expanded}
          onClick={() => toggleGroupExpand(group.sha256)}
        >
          <span className="duplicate-stack" aria-hidden="true">
            {/* The keeper sits on top; the copies behind it are the same
                image dimmed, so the fan shows real thumbnails and still
                reads as depth rather than noise. */}
            {view.copies.slice(0, 2).map((item, index) => (
              <span
                key={item.id}
                className={`duplicate-stack-sheet is-back ${
                  index === 0 ? "is-back-near" : "is-back-far"
                }`}
              >
                {renderStackThumb(item)}
              </span>
            ))}
            <span className="duplicate-stack-sheet is-front">{renderStackThumb(view.keeper)}</span>
            <span className="duplicate-stack-count">{view.ordered.length}</span>
          </span>
          <span className="duplicate-group-copy">
            {burst ? (
              <>
                <span className="duplicate-group-title">
                  {view.ordered.length} photos ·{" "}
                  {burst.timeSpanMs != null
                    ? `${(burst.timeSpanMs / 1000).toFixed(1)}s burst`
                    : "burst"}
                  <span className="duplicate-group-burst-badge">
                    {Math.round(burst.confidence * 100)}% match
                  </span>
                </span>
                <span className="duplicate-group-sub">
                  {burst.reason} · <b>{formatBytesSimple(view.reclaimable)}</b> reclaimable
                </span>
              </>
            ) : (
              <>
                <span
                  className="duplicate-group-title"
                  title={
                    group.sha256 ? `Content fingerprint (SHA-256): ${group.sha256}` : undefined
                  }
                >
                  {view.ordered.length} identical copies
                </span>
                <span className="duplicate-group-sub">
                  {formatBytesSimple(group.size)} each ·{" "}
                  <b>{formatBytesSimple(view.reclaimable)}</b> reclaimable
                </span>
              </>
            )}
          </span>
          <span className={`duplicate-group-chevron${expanded ? " is-open" : ""}`}>
            <ChevronDownIcon size={14} />
          </span>
        </button>
        <div className="duplicate-group-actions">
          {groupFullySelected && <span className="duplicate-group-note">Every copy selected</span>}
          <button
            type="button"
            className="quiet-button"
            disabled={busy}
            onClick={() => toggleGroupCopies(view)}
          >
            {allCopiesSelected ? "Deselect copies" : "Select copies"}
          </button>
          {view.ordered.length > INLINE_COPIES && (
            <button
              type="button"
              className="quiet-button"
              disabled={busy}
              onClick={() => toggleGroupExpand(group.sha256)}
            >
              {expanded ? "Show fewer" : `Show all ${view.ordered.length}`}
            </button>
          )}
        </div>
      </header>
      <div className={`duplicate-tiles${viewMode === "list" ? " is-list" : ""}`}>
        {visible.map((item) => (
          <DuplicateTile
            key={item.id}
            view={view}
            item={item}
            selected={selected}
            assetUrl={assetUrl}
            onOpenItem={onOpenItem}
            toggleItem={toggleItem}
            onCompare={onCompare}
          />
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            className="duplicate-tile-more"
            onClick={() => toggleGroupExpand(group.sha256)}
          >
            +{hiddenCount}
            <small>more</small>
          </button>
        )}
      </div>
    </section>
  );
}
