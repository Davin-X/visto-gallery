import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "../engine/hooks/useKeyboard";
import {
  CheckIcon,
  ChevronDownIcon,
  ColumnsIcon,
  DuplicatesIcon,
  EyeIcon,
  FolderIcon,
  GridIcon,
  TrashIcon,
} from "../design/components/icons";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { KindBadge } from "../design/components/KindBadge";
import { tauri } from "../engine/commands/tauri";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import type { DuplicateGroup, MediaItem } from "../engine/types/media";
import { buildGroupViews, type GroupView, type KeeperMode } from "../engine/duplicates/grouping";
import { CompareOverlay } from "../design/components/CompareOverlay";
import { formatFileDate } from "../engine/utils/mediaDate";

interface DuplicatesScreenProps {
  groups: DuplicateGroup[];
  items: MediaItem[];
  onScan: () => void | Promise<void>;
  /** Whether a scan has run. Before that, an empty list means "not checked",
   *  not "no duplicates". Defaults to true for callers that only show results. */
  scanned?: boolean;
  onClear: () => void;
  busy: boolean;
  progress?: {
    phase?: string;
    processed?: number;
    total?: number;
    currentFile?: string;
    bytesProcessed?: number;
    bytesTotal?: number;
  } | null;
  assetUrl: (path: string) => string;
  onRequestDeleteItems: (ids: string[]) => void;
  onHideIds: (ids: string[]) => void | Promise<void>;
  /** Open a copy in the viewer so it can be inspected before removal. */
  onOpenItem?: (id: string) => void;
}

const GROUP_PAGE = 40;
// Enough tiles to fill one row of a wide window; expansion reveals the rest.
const INLINE_COPIES = 4;

type ViewMode = "grid" | "list";
type KindFilter = "all" | "photo" | "video" | "raw";
type SortBy = "saving" | "copies" | "newest" | "name";

const KIND_LABELS: Record<KindFilter, string> = {
  all: "All",
  photo: "Photos",
  video: "Videos",
  raw: "RAW",
};

const EMPTY_TITLES: Record<KindFilter, string> = {
  all: "No duplicates found",
  photo: "No photo duplicates",
  video: "No video duplicates",
  raw: "No RAW duplicates",
};

const SORT_LABELS: Record<SortBy, string> = {
  saving: "Largest saving",
  copies: "Most copies",
  newest: "Newest",
  name: "Name",
};

/** True when a key event originates from an editable field (input, textarea,
 *  select, contenteditable) — the duplicates shortcuts must not hijack typing. */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT"
  );
}

function parentFolder(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return "";
  return formatFileDate(timestamp);
}

function DuplicatesScreen(props: DuplicatesScreenProps) {
  const {
    groups: groupsProp,
    progress: progressProp,
    busy,
    onScan,
    scanned = true,
    onClear,
    onRequestDeleteItems,
    onHideIds,
    assetUrl,
    onOpenItem,
  } = props;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [renderLimit, setRenderLimit] = useState(GROUP_PAGE);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [keeperMode, setKeeperMode] = useState<KeeperMode>("best");
  const [filterKind, setFilterKind] = useState<KindFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("saving");
  // Which copy is open in the side-by-side inspector, addressed by group so a
  // rescan that reorders groups can't point the overlay at the wrong pair.
  const [compare, setCompare] = useState<{ sha: string; copyId: string } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupsProp ?? [], [groupsProp]);
  const progress = progressProp ?? null;

  const kindCounts = useMemo(() => {
    const counts: Record<KindFilter, number> = { all: groups.length, photo: 0, video: 0, raw: 0 };
    groups.forEach((group) => {
      const kinds = new Set(group.items.map((item) => item.kind));
      if (kinds.has("photo")) counts.photo += 1;
      if (kinds.has("video")) counts.video += 1;
      if (kinds.has("raw")) counts.raw += 1;
    });
    return counts;
  }, [groups]);

  // Describes what the scan did find so a filtered-empty view still points
  // somewhere instead of dead-ending on "no results". Phrased without a verb
  // so a single group and many groups both read correctly.
  const otherKinds = useMemo(() => {
    const parts: string[] = [];
    (["photo", "video", "raw"] as const).forEach((kind) => {
      const count = kindCounts[kind];
      if (kind === filterKind || count === 0) return;
      const noun = kind === "raw" ? "RAW" : kind;
      parts.push(`${count.toLocaleString()} ${noun} ${count === 1 ? "group" : "groups"}`);
    });
    return parts;
  }, [filterKind, kindCounts]);

  const otherKindsLabel = useMemo(() => {
    if (otherKinds.length <= 1) return otherKinds[0] ?? "";
    return `${otherKinds.slice(0, -1).join(", ")} and ${otherKinds[otherKinds.length - 1]}`;
  }, [otherKinds]);

  const groupViews = useMemo<GroupView[]>(
    () => buildGroupViews(groups, { filterKind, keeperMode, sortBy }),
    [groups, filterKind, keeperMode, sortBy],
  );

  const totalCopies = useMemo(
    () => groupViews.reduce((sum, view) => sum + view.copies.length, 0),
    [groupViews],
  );
  const compareView = useMemo(
    () => (compare ? groupViews.find((view) => view.group.sha256 === compare.sha) : undefined),
    [compare, groupViews],
  );
  const copyIdSet = useMemo(() => {
    const ids = new Set<string>();
    groupViews.forEach((view) => view.copies.forEach((item) => ids.add(item.id)));
    return ids;
  }, [groupViews]);

  const selectedCopyCount = useMemo(
    () => [...selected].filter((id) => copyIdSet.has(id)).length,
    [selected, copyIdSet],
  );

  const selectedBytes = useMemo(() => {
    let total = 0;
    groupViews.forEach((view) => {
      view.ordered.forEach((item) => {
        if (selected.has(item.id) && copyIdSet.has(item.id)) total += item.size;
      });
    });
    return total;
  }, [groupViews, selected, copyIdSet]);

  const libraryTotals = useMemo(() => {
    let copies = 0;
    let bytes = 0;
    groups.forEach((group) => {
      copies += Math.max(0, group.items.length - 1);
      bytes += group.items.slice(1).reduce((sum, item) => sum + item.size, 0);
    });
    return { copies, bytes };
  }, [groups]);

  useEffect(() => {
    setRenderLimit(GROUP_PAGE);
    // Optional call: instant scrolling is not implemented everywhere.
    pageRef.current?.scrollTo?.({ top: 0 });
  }, [filterKind, sortBy, keeperMode]);

  // Copies disappear from `groups` when they are trashed or hidden. Prune the
  // selection with them, otherwise the action bar counts ids that no longer
  // exist and "every copy selected" can be true for a group of one.
  useEffect(() => {
    const live = new Set<string>();
    groups.forEach((group) => group.items.forEach((item) => live.add(item.id)));
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (live.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [groups]);

  const toggleItem = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectNone = useCallback(() => setSelected(new Set()), []);

  const selectAllCopies = useCallback(() => {
    const ids = new Set<string>();
    groupViews.forEach((view) => view.copies.forEach((item) => ids.add(item.id)));
    setSelected(ids);
  }, [groupViews]);

  const toggleGroupCopies = useCallback((view: GroupView) => {
    const copyIds = view.copies.map((item) => item.id);
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = copyIds.length > 0 && copyIds.every((id) => prev.has(id));
      copyIds.forEach((id) => {
        if (allSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  }, []);

  const toggleGroupExpand = useCallback((sha256: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sha256)) next.delete(sha256);
      else next.add(sha256);
      return next;
    });
  }, []);

  const expandableGroups = useMemo(
    () => groupViews.filter((view) => view.ordered.length > INLINE_COPIES),
    [groupViews],
  );
  const allExpanded =
    expandableGroups.length > 0 &&
    expandableGroups.every((view) => expandedGroups.has(view.group.sha256));

  const toggleAllGroups = useCallback(() => {
    setExpandedGroups(
      allExpanded ? new Set() : new Set(expandableGroups.map((v) => v.group.sha256)),
    );
  }, [allExpanded, expandableGroups]);

  // Changing the criteria changes which copies count as removable, so the
  // previous selection would no longer mean what the user chose.
  const changeFilter = useCallback((kind: KindFilter) => {
    setFilterKind(kind);
    setSelected(new Set());
  }, []);

  const changeKeeperMode = useCallback((mode: KeeperMode) => {
    setKeeperMode(mode);
    setSelected(new Set());
  }, []);

  const handleScroll = useCallback(() => {
    const el = pageRef.current;
    if (!el || renderLimit >= groupViews.length) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 900) {
      setRenderLimit((limit) => Math.min(limit + GROUP_PAGE, groupViews.length));
    }
  }, [groupViews.length, renderLimit]);

  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (busy) return;
        if (isEditableTarget(e.target)) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
          e.preventDefault();
          selectAllCopies();
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
          e.preventDefault();
          selectNone();
        }
        if (e.key === "Escape" && selected.size > 0) {
          e.preventDefault();
          selectNone();
        }
        if ((e.key === "Delete" || e.key === "Backspace") && selected.size > 0) {
          e.preventDefault();
          onRequestDeleteItems([...selected]);
        }
      },
      [busy, selected, selectAllCopies, selectNone, onRequestDeleteItems],
    ),
  ]);

  const revealItem = (path: string) => {
    void tauri.items.revealInFinder(path);
  };

  const renderTile = (view: GroupView, item: MediaItem) => {
    const isKeeper = item.id === view.keeper.id;
    const isSelected = selected.has(item.id);

    return (
      <figure
        key={item.id}
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
                onClick={() => setCompare({ sha: view.group.sha256, copyId: item.id })}
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
              onClick={() => revealItem(item.path)}
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
          <span className="duplicate-tile-path" title={item.path}>
            {parentFolder(item.path)}
          </span>
        </figcaption>
      </figure>
    );
  };

  const renderStackThumb = (item: MediaItem) =>
    item.kind === "raw" ? (
      <span className="duplicate-stack-raw">
        <KindBadge kind="raw" />
      </span>
    ) : (
      <CachedThumbnail itemId={item.id} name="" size={128} />
    );

  const renderGroup = (view: GroupView) => {
    const { group } = view;
    const expanded = expandedGroups.has(group.sha256);
    const visible = expanded ? view.ordered : view.ordered.slice(0, INLINE_COPIES);
    const hiddenCount = view.ordered.length - visible.length;
    const copyIds = view.copies.map((item) => item.id);
    const allCopiesSelected = copyIds.length > 0 && copyIds.every((id) => selected.has(id));
    const groupFullySelected = view.ordered.every((item) => selected.has(item.id));

    return (
      <section className="duplicate-group" key={group.sha256}>
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
              <span className="duplicate-stack-sheet is-front">
                {renderStackThumb(view.keeper)}
              </span>
              <span className="duplicate-stack-count">{view.ordered.length}</span>
            </span>
            <span className="duplicate-group-copy">
              <span
                className="duplicate-group-title"
                title={group.sha256 ? `Content fingerprint (SHA-256): ${group.sha256}` : undefined}
              >
                {view.ordered.length} identical copies
              </span>
              <span className="duplicate-group-sub">
                {formatBytesSimple(group.size)} each · <b>{formatBytesSimple(view.reclaimable)}</b>{" "}
                reclaimable
              </span>
            </span>
            <span className={`duplicate-group-chevron${expanded ? " is-open" : ""}`}>
              <ChevronDownIcon size={14} />
            </span>
          </button>
          <div className="duplicate-group-actions">
            {groupFullySelected && (
              <span className="duplicate-group-note">Every copy selected</span>
            )}
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
          {visible.map((item) => renderTile(view, item))}
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
  };

  const hasGroups = groups.length > 0;
  const hasVisibleGroups = groupViews.length > 0;
  const isDuplicateScan = busy && progress?.phase === "hashing";
  const isTrashing = busy && progress?.phase === "trashing";
  const canAct = !busy && selected.size > 0;
  const allCopiesSelected = totalCopies > 0 && selectedCopyCount >= totalCopies;

  const pageHeading = (
    <div className="page-heading">
      <div>
        <p className="eyebrow">CLEANUP</p>
        <h1>Duplicate files</h1>
        <p className="page-subtitle">
          {hasGroups
            ? `${groups.length.toLocaleString()} ${groups.length === 1 ? "group" : "groups"} · ${libraryTotals.copies.toLocaleString()} extra ${libraryTotals.copies === 1 ? "copy" : "copies"} · ${formatBytesSimple(libraryTotals.bytes)} reclaimable`
            : "Find exact copies of the same file and free up the space they take."}
        </p>
      </div>
      <div className="duplicate-heading-actions">
        {hasGroups && (
          <button type="button" className="quiet-button" onClick={onClear} disabled={busy}>
            Clear
          </button>
        )}
        {/* With no results the empty state carries the only scan button. */}
        {(hasGroups || busy) && (
          <button type="button" className="primary-button" onClick={onScan} disabled={busy}>
            {isTrashing ? "Moving to Trash…" : isDuplicateScan ? "Scanning…" : "Rescan"}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="feature-page duplicates-page" ref={pageRef} onScroll={handleScroll}>
      {pageHeading}

      {hasGroups && (
        <div className="duplicate-toolbar">
          <div className="duplicate-filter-tabs" role="group" aria-label="Filter by media type">
            {(Object.keys(KIND_LABELS) as KindFilter[]).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={filterKind === kind}
                className={[
                  filterKind === kind ? "is-active" : "",
                  kindCounts[kind] === 0 ? "is-empty" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => changeFilter(kind)}
              >
                {KIND_LABELS[kind]}
                <span className="duplicate-filter-count">{kindCounts[kind]}</span>
              </button>
            ))}
          </div>
          <div className="duplicate-toolbar-right">
            <div className="duplicate-keeper" role="group" aria-label="Default copy to keep">
              <span className="duplicate-keeper-label">Keep</span>
              <button
                type="button"
                className={keeperMode === "best" ? "is-active" : ""}
                aria-pressed={keeperMode === "best"}
                title="Keep the highest-quality copy: RAW or TIFF first, then resolution and file size"
                onClick={() => changeKeeperMode("best")}
              >
                Best quality
              </button>
              <button
                type="button"
                className={keeperMode === "oldest" ? "is-active" : ""}
                aria-pressed={keeperMode === "oldest"}
                title="Keep the copy that entered your library first"
                onClick={() => changeKeeperMode("oldest")}
              >
                Oldest
              </button>
              <button
                type="button"
                className={keeperMode === "newest" ? "is-active" : ""}
                aria-pressed={keeperMode === "newest"}
                title="Keep the copy that entered your library last"
                onClick={() => changeKeeperMode("newest")}
              >
                Newest
              </button>
            </div>
            <div className="sort-control" role="group" aria-label="Sort groups">
              <select
                aria-label="Sort duplicate groups by"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
              >
                {(Object.keys(SORT_LABELS) as SortBy[]).map((option) => (
                  <option key={option} value={option}>
                    {SORT_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>
            <div className="layout-switcher" role="group" aria-label="Tile layout">
              <button
                type="button"
                className={viewMode === "grid" ? "selected" : ""}
                aria-pressed={viewMode === "grid"}
                title="Grid view"
                onClick={() => setViewMode("grid")}
              >
                <GridIcon size={14} />
              </button>
              <button
                type="button"
                className={viewMode === "list" ? "selected" : ""}
                aria-pressed={viewMode === "list"}
                title="List view"
                onClick={() => setViewMode("list")}
              >
                <ColumnsIcon size={14} />
              </button>
            </div>
            {expandableGroups.length > 0 && (
              <button type="button" className="quiet-button" onClick={toggleAllGroups}>
                {allExpanded ? "Collapse all" : "Expand all"}
              </button>
            )}
          </div>
        </div>
      )}
      {hasVisibleGroups && (
        <div className="duplicate-selection-bar">
          <div className="duplicate-selection-copy">
            <span>
              <b>{selectedCopyCount.toLocaleString()}</b> of {totalCopies.toLocaleString()} extra
              copies selected
            </span>
            {selectedCopyCount > 0 && (
              <span className="duplicate-selection-savings">
                {formatBytesSimple(selectedBytes)} reclaimable
              </span>
            )}
          </div>
          <div className="duplicate-selection-actions">
            <button
              type="button"
              className="quiet-button"
              disabled={busy || totalCopies === 0 || allCopiesSelected}
              onClick={selectAllCopies}
            >
              Select copies
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled={selected.size === 0}
              onClick={selectNone}
            >
              Clear
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled={!canAct}
              onClick={() => void onHideIds([...selected])}
            >
              Hide
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={!canAct}
              onClick={() => onRequestDeleteItems([...selected])}
            >
              <TrashIcon size={13} /> Move to Trash
            </button>
          </div>
        </div>
      )}
      {!hasVisibleGroups ? (
        <div className={`duplicate-empty${hasGroups && !busy ? " is-compact" : ""}`}>
          <span className="duplicate-empty-icon" aria-hidden="true">
            <DuplicatesIcon size={26} />
          </span>
          <h2>
            {isTrashing
              ? "Moving selected files to Trash"
              : isDuplicateScan
                ? "Scanning your library"
                : !hasGroups && !scanned
                  ? "Find duplicate files"
                  : EMPTY_TITLES[hasGroups ? filterKind : "all"]}
          </h2>
          <p>
            {isTrashing
              ? "The selected copies are being moved to Finder Trash. You can use Put Back in Finder if needed."
              : isDuplicateScan
                ? "Comparing files byte for byte. Large libraries can take a moment."
                : !hasGroups && !scanned
                  ? "The scan compares the contents of every file in your library. Nothing is moved until you choose which copies to remove."
                  : hasGroups
                    ? otherKinds.length > 0
                      ? `Found ${otherKindsLabel} instead. Use the media tabs above to switch.`
                      : "Nothing in this scan matches the selected media type."
                    : "Every file in your library is unique by content. Identical-looking photos that differ by even one byte are not flagged."}
          </p>
          {!busy &&
            (hasGroups ? (
              <button type="button" className="quiet-button" onClick={() => changeFilter("all")}>
                Show all {groups.length.toLocaleString()} groups
              </button>
            ) : (
              <button type="button" className="primary-button" onClick={onScan}>
                {scanned ? "Scan again" : "Scan library"}
              </button>
            ))}
        </div>
      ) : (
        <>
          <div className="duplicate-groups">
            {groupViews.slice(0, renderLimit).map((view) => renderGroup(view))}
          </div>
          {renderLimit < groupViews.length && (
            <div className="duplicate-load-more">
              <button
                type="button"
                className="quiet-button"
                onClick={() =>
                  setRenderLimit((limit) => Math.min(limit + GROUP_PAGE, groupViews.length))
                }
              >
                Show {Math.min(GROUP_PAGE, groupViews.length - renderLimit).toLocaleString()} more
                groups
              </button>
            </div>
          )}
        </>
      )}

      {compareView && compareView.copies.length > 0 ? (
        <CompareOverlay
          keeper={compareView.keeper}
          copies={compareView.copies}
          initialCopyId={compare?.copyId}
          assetUrl={assetUrl}
          onClose={() => setCompare(null)}
        />
      ) : null}
    </div>
  );
}

export default DuplicatesScreen;
