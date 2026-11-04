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

interface DuplicatesScreenProps {
  groups: DuplicateGroup[];
  items: MediaItem[];
  onScan: () => void | Promise<void>;
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
type KeeperMode = "oldest" | "newest";
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

/** Newest-first ordering is expressed as a negative "oldest" timestamp. */
function copyOrderValue(item: MediaItem): number {
  return item.createdAt || item.modifiedAt || 0;
}

/**
 * The backend stores hash groups in query order, so the first item is not
 * necessarily the original file. Order every group explicitly: the keeper
 * first (oldest or newest import), then the rest by path so the list is
 * stable between scans.
 */
function orderGroup(items: MediaItem[], keeperMode: KeeperMode): MediaItem[] {
  const direction = keeperMode === "oldest" ? 1 : -1;
  return [...items].sort((a, b) => {
    const byAge = (copyOrderValue(a) - copyOrderValue(b)) * direction;
    if (byAge !== 0) return byAge;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

function parentFolder(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleDateString();
}

interface GroupView {
  group: DuplicateGroup;
  /** Keeper first, then every other copy. */
  ordered: MediaItem[];
  keeper: MediaItem;
  copies: MediaItem[];
  reclaimable: number;
  newest: number;
}

function DuplicatesScreen(props: DuplicatesScreenProps) {
  const {
    groups: groupsProp,
    progress: progressProp,
    busy,
    onScan,
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
  const [keeperMode, setKeeperMode] = useState<KeeperMode>("oldest");
  const [filterKind, setFilterKind] = useState<KindFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("saving");
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

  const groupViews = useMemo<GroupView[]>(() => {
    const views: GroupView[] = [];
    groups.forEach((group) => {
      if (filterKind !== "all" && !group.items.some((item) => item.kind === filterKind)) return;
      const ordered = orderGroup(group.items, keeperMode);
      const copies = ordered.slice(1);
      views.push({
        group,
        ordered,
        keeper: ordered[0],
        copies,
        reclaimable: copies.reduce((sum, item) => sum + item.size, 0),
        newest: group.items.reduce((latest, item) => Math.max(latest, copyOrderValue(item)), 0),
      });
    });
    views.sort((a, b) => {
      if (sortBy === "copies")
        return b.ordered.length - a.ordered.length || b.reclaimable - a.reclaimable;
      if (sortBy === "newest") return b.newest - a.newest;
      if (sortBy === "name") return a.keeper.name.localeCompare(b.keeper.name);
      return b.reclaimable - a.reclaimable;
    });
    return views;
  }, [groups, filterKind, keeperMode, sortBy]);

  const totalCopies = useMemo(
    () => groupViews.reduce((sum, view) => sum + view.copies.length, 0),
    [groupViews],
  );
  const reclaimableBytes = useMemo(
    () => groupViews.reduce((sum, view) => sum + view.reclaimable, 0),
    [groupViews],
  );
  const selectedBytes = useMemo(() => {
    let total = 0;
    groupViews.forEach((view) => {
      view.ordered.forEach((item) => {
        if (selected.has(item.id)) total += item.size;
      });
    });
    return total;
  }, [groupViews, selected]);

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
    pageRef.current?.scrollTo({ top: 0 });
  }, [filterKind, sortBy, keeperMode]);

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

  const scanPercent = useMemo(() => {
    if (!progress?.total || !progress.processed) return null;
    return Math.max(0, Math.min(100, Math.round((progress.processed / progress.total) * 100)));
  }, [progress]);

  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (busy) return;
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

  const stackPose = (count: number, index: number) => {
    if (count <= 1) return { x: 0, r: 0, z: 1 };
    if (count === 2) {
      return index === 0 ? { x: -5, r: -7, z: 1 } : { x: 5, r: 4, z: 2 };
    }
    const poses = [
      { x: -11, r: -9, z: 1 },
      { x: 11, r: 8, z: 2 },
      { x: 0, r: -1, z: 3 },
    ];
    return poses[index] ?? poses[2];
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
        </div>
        <figcaption className="duplicate-tile-caption">
          <span className="duplicate-tile-head">
            <span className={`duplicate-tile-flag${isKeeper ? " is-keeper" : ""}`}>
              {isKeeper ? "Keep" : "Copy"}
            </span>
            <span className="duplicate-tile-name" title={item.path}>
              {item.name}
            </span>
            <span className="duplicate-tile-tools">
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
                title="Reveal in Finder"
                aria-label={`Reveal ${item.name} in Finder`}
                onClick={() => revealItem(item.path)}
              >
                <FolderIcon size={13} />
              </button>
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

  const renderGroup = (view: GroupView) => {
    const { group } = view;
    const expanded = expandedGroups.has(group.sha256);
    const visible = expanded ? view.ordered : view.ordered.slice(0, INLINE_COPIES);
    const hiddenCount = view.ordered.length - visible.length;
    const stackItems = view.ordered.slice(0, 3);
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
            <span
              className={`duplicate-stack${stackItems.length === 1 ? " is-single" : ""}`}
              aria-hidden="true"
            >
              {stackItems.map((item, index) => {
                const pose = stackPose(stackItems.length, index);
                return (
                  <span
                    key={item.id}
                    className="duplicate-stack-sheet"
                    style={
                      {
                        "--stack-x": `${pose.x}px`,
                        "--stack-r": `${pose.r}deg`,
                        zIndex: pose.z,
                      } as React.CSSProperties
                    }
                  >
                    {item.kind === "raw" ? (
                      <span className="duplicate-stack-raw" />
                    ) : (
                      <CachedThumbnail itemId={item.id} name="" size={128} />
                    )}
                  </span>
                );
              })}
              <span className="duplicate-stack-count">{view.ordered.length}</span>
            </span>
            <span className="duplicate-group-copy">
              <span className="duplicate-group-title">{view.ordered.length} identical copies</span>
              <span className="duplicate-group-sub">
                {formatBytesSimple(group.size)} each · <b>{formatBytesSimple(view.reclaimable)}</b>{" "}
                reclaimable
              </span>
              <span className="duplicate-group-hash" title={group.sha256}>
                SHA-256 {(group.sha256 || "").slice(0, 16)}
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
  const canAct = !busy && selected.size > 0;
  const allCopiesSelected = totalCopies > 0 && selected.size >= totalCopies;

  const pageHeading = (
    <div className="page-heading">
      <div>
        <p className="eyebrow">CLEANUP</p>
        <h1>Duplicate files</h1>
        <p className="page-subtitle">
          {hasGroups
            ? `${groups.length.toLocaleString()} ${groups.length === 1 ? "group" : "groups"} · ${libraryTotals.copies.toLocaleString()} extra ${libraryTotals.copies === 1 ? "copy" : "copies"} · ${formatBytesSimple(libraryTotals.bytes)} reclaimable`
            : "Find byte-identical files by SHA-256 content hash and reclaim disk space."}
        </p>
      </div>
      <div className="duplicate-heading-actions">
        {hasGroups && (
          <button type="button" className="quiet-button" onClick={onClear} disabled={busy}>
            Clear
          </button>
        )}
        <button type="button" className="primary-button" onClick={onScan} disabled={busy}>
          {busy ? "Scanning…" : hasGroups ? "Rescan" : "Scan library"}
        </button>
      </div>
    </div>
  );

  const scanBar = busy ? (
    <div className="duplicate-scan" role="status" aria-live="polite">
      <span className="duplicate-scan-pip" aria-hidden="true" />
      <div className="duplicate-scan-copy">
        <span className="duplicate-scan-title">
          {progress?.phase === "hashing" ? "Comparing file contents" : "Finding candidates"}
          {scanPercent !== null ? ` · ${scanPercent}%` : ""}
        </span>
        <span className="duplicate-scan-file" title={progress?.currentFile}>
          {progress?.currentFile || "Reading file fingerprints…"}
        </span>
        <div className={`duplicate-scan-track${scanPercent === null ? " is-indeterminate" : ""}`}>
          <span
            className="duplicate-scan-fill"
            style={scanPercent !== null ? { width: `${scanPercent}%` } : undefined}
          />
        </div>
      </div>
      <button type="button" className="quiet-button" onClick={onClear}>
        Cancel
      </button>
    </div>
  ) : null;

  return (
    <div className="feature-page duplicates-page" ref={pageRef} onScroll={handleScroll}>
      {hasGroups ? (
        <header className="duplicate-header">
          {pageHeading}
          {scanBar}

          {hasGroups && (
            <div className="duplicate-toolbar">
              <div
                className="duplicate-filter-tabs"
                role="tablist"
                aria-label="Filter by media type"
              >
                {(Object.keys(KIND_LABELS) as KindFilter[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="tab"
                    aria-selected={filterKind === kind}
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
                  <b>{selected.size.toLocaleString()}</b> of {totalCopies.toLocaleString()} extra
                  copies selected
                </span>
                {selected.size > 0 && (
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
        </header>
      ) : (
        <>
          {pageHeading}
          {scanBar}
        </>
      )}
      {!hasVisibleGroups ? (
        <div className={`duplicate-empty${hasGroups && !busy ? " is-compact" : ""}`}>
          <span className="duplicate-empty-icon" aria-hidden="true">
            <DuplicatesIcon size={26} />
          </span>
          <h2>{busy ? "Scanning your library" : EMPTY_TITLES[hasGroups ? filterKind : "all"]}</h2>
          <p>
            {busy
              ? "Comparing files by content hash. Large libraries can take a moment."
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
                Scan library
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
    </div>
  );
}

export default DuplicatesScreen;
