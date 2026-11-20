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
  XIcon,
} from "../design/components/icons";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { KindBadge } from "../design/components/KindBadge";
import { events, tauri } from "../engine/commands/tauri";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import type { DuplicateGroup, MediaItem } from "../engine/types/media";
import type {
  FileDuplicateGroup,
  FileDuplicateItem,
  FileDuplicateScan,
  LibraryFolder,
} from "../engine/types/commands";
import { buildGroupViews, type GroupView, type KeeperMode } from "../engine/duplicates/grouping";
import { CompareOverlay } from "../design/components/CompareOverlay";
import { formatFileDate } from "../engine/utils/mediaDate";
import { CleanupTabs } from "../design/components/CleanupTabs";
import { MiddleTruncate } from "../design/components/MiddleTruncate";

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
  /** Switch to the Mac storage tab of Clean up. */
  onOpenCleanup?: () => void;
  /** Library folders the scan can be limited to. Empty hides the picker. */
  folders?: LibraryFolder[];
  /** Folder the next scan is limited to; null compares the whole library. */
  scope?: string | null;
  onChangeScope?: (path: string | null) => void;
  /** Report a failed any-file scan or trash request. */
  onError?: (error: unknown, prefix?: string) => void;
  /** Called after files were trashed, so the library drops matching rows. */
  onFilesTrashed?: () => void;
}

const GROUP_PAGE = 40;
// Enough tiles to fill one row of a wide window; expansion reveals the rest.
const INLINE_COPIES = 4;

type ViewMode = "grid" | "list";
type ScanMode = "media" | "files";
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

function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** The row's folder relative to the folder being scanned, so one scan does not
 *  print the same absolute prefix on every line. */
function folderWithin(path: string, scope: string | undefined): string {
  const folder = parentFolder(path);
  if (!scope) return folder;
  const base = scope.replace(/\/+$/, "");
  if (folder === base) return "This folder";
  if (folder.startsWith(`${base}/`)) return folder.slice(base.length + 1);
  return folder;
}

/** The item to keep in a group. The first item stands in when no keeper is
 *  marked, so a group can never offer every copy for deletion. */
function keeperIdOf(group: FileDuplicateGroup): string | undefined {
  return (group.items.find((item) => item.keeper) ?? group.items[0])?.id;
}

/** The ids a click on "Select copies" would trash: everything except the keeper. */
function copyIdsOf(group: FileDuplicateGroup): string[] {
  const keeper = keeperIdOf(group);
  return group.items.filter((item) => item.id !== keeper).map((item) => item.id);
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
    onOpenCleanup,
    folders = [],
    scope = null,
    onChangeScope,
    onError,
    onFilesTrashed,
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
  const scopeFolder = useMemo(
    () => (scope ? (folders.find((folder) => folder.path === scope) ?? null) : null),
    [folders, scope],
  );
  const scopeLabel = scopeFolder?.name ?? "this folder";
  // A folder picked with "Choose folder…" that is not a library source. It is
  // kept apart from `scope`, so an any-file scan never narrows the media scan,
  // and it is session-only like the rest of this screen.
  const [pickedFolder, setPickedFolder] = useState<string | null>(null);
  // An any-file scan always compares one folder, so it never offers "All
  // folders": with none chosen it uses the first source instead of showing a
  // screen with nothing to scan.
  const fileScope = pickedFolder ?? scope ?? folders[0]?.path ?? null;
  const fileScopeLabel =
    folders.find((folder) => folder.path === fileScope)?.name ??
    (fileScope ? folderName(fileScope) : "this folder");

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
          <MiddleTruncate text={parentFolder(item.path)} className="duplicate-tile-path" />
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

  // ---- Any-file scan --------------------------------------------------
  // A separate scan from the media one: the backend walks the chosen folder,
  // keeps every hash in memory and never touches the media catalog. Results
  // live here, so leaving the screen throws them away.
  const [mode, setMode] = useState<ScanMode>("media");
  const [fileScan, setFileScan] = useState<FileDuplicateScan | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileProgress, setFileProgress] = useState<{
    phase?: string;
    processed?: number;
    total?: number;
    currentFile?: string;
  } | null>(null);
  const [fileSelected, setFileSelected] = useState<Set<string>>(new Set());
  const [confirmFileTrash, setConfirmFileTrash] = useState(false);
  // Bumped when the scope changes, so a scan still running for the previous
  // folder cannot paint its results over the new one.
  const fileScanRequest = useRef(0);
  const fileBusyRef = useRef(false);

  useEffect(() => {
    fileBusyRef.current = fileBusy;
  }, [fileBusy]);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    let frame: number | null = null;
    let pending: { phase?: string; processed?: number; total?: number; currentFile?: string } | null = null;

    void events
      .onFileDuplicatesProgress((event) => {
        pending = event;
        if (frame === null) {
          frame = window.requestAnimationFrame(() => {
            frame = null;
            if (!disposed && pending) {
              setFileProgress(pending);
              pending = null;
            }
          });
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      });
    return () => {
      disposed = true;
      stop?.();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  // Results belong to the folder they came from; a new scope invalidates them,
  // and a scan for the old folder is stopped rather than left running.
  useEffect(() => {
    fileScanRequest.current += 1;
    setFileScan(null);
    setFileSelected(new Set());
    setConfirmFileTrash(false);
    if (fileBusyRef.current) void tauri.duplicates.cancel();
  }, [fileScope]);

  // A folder picked for the any-file scan is session-only; narrowing the
  // library scope means the user is choosing a source again, so the pick
  // falls away instead of silently winning over the new scope.
  useEffect(() => {
    setPickedFolder(null);
  }, [scope]);

  const fileGroups = useMemo(() => fileScan?.groups ?? [], [fileScan]);
  const fileTotals = useMemo(() => {
    let copies = 0;
    let bytes = 0;
    fileGroups.forEach((group) => {
      const keeper = keeperIdOf(group);
      group.items.forEach((item) => {
        if (item.id === keeper) return;
        copies += 1;
        bytes += item.size;
      });
    });
    return { copies, bytes };
  }, [fileGroups]);
  const fileSelectedBytes = useMemo(() => {
    let bytes = 0;
    fileGroups.forEach((group) => {
      group.items.forEach((item) => {
        if (fileSelected.has(item.id)) bytes += item.size;
      });
    });
    return bytes;
  }, [fileGroups, fileSelected]);

  const switchMode = useCallback((next: ScanMode) => {
    setMode(next);
    setConfirmFileTrash(false);
    // The any-file scan falls back to the first folder on its own; changing
    // modes must not narrow the media scan or throw its results away.
  }, []);

  const runFileScan = useCallback(async () => {
    if (!fileScope) return;
    const request = fileScanRequest.current + 1;
    fileScanRequest.current = request;
    setFileBusy(true);
    setConfirmFileTrash(false);
    setFileProgress({ phase: "walking", processed: 0, total: 0 });
    try {
      const result = await tauri.fileDuplicates.scan(fileScope);
      if (request !== fileScanRequest.current) return;
      setFileScan(result);
      setFileSelected(new Set());
    } catch (error) {
      if (request === fileScanRequest.current) onError?.(error, "Could not compare that folder");
    } finally {
      setFileBusy(false);
      setFileProgress(null);
    }
  }, [fileScope, onError]);

  const toggleFileItem = useCallback((id: string) => {
    setFileSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectFileCopies = useCallback((group: FileDuplicateGroup) => {
    setFileSelected((prev) => {
      const next = new Set(prev);
      for (const id of copyIdsOf(group)) next.add(id);
      return next;
    });
  }, []);

  const trashFileSelection = useCallback(async () => {
    if (fileSelected.size === 0) return;
    // Non-media files are the user's own documents, so the first click only
    // arms the button; nothing moves until they confirm.
    if (!confirmFileTrash) {
      setConfirmFileTrash(true);
      return;
    }
    setFileBusy(true);
    try {
      const result = await tauri.fileDuplicates.trash([...fileSelected]);
      const gone = new Set(result.trashed);
      setFileScan((previous) =>
        previous
          ? {
              ...previous,
              groups: previous.groups
                .map((group) => {
                  const remaining = group.items.filter((item) => !gone.has(item.id));
                  // If the keeper was trashed, promote the first remaining item to keeper.
                  const hasKeeper = remaining.some((item) => item.keeper);
                  const items = hasKeeper
                    ? remaining
                    : remaining.map((item, index) => ({ ...item, keeper: index === 0 }));
                  return { ...group, items };
                })
                // A group of one is no longer a duplicate.
                .filter((group) => group.items.length > 1),
            }
          : previous,
      );
      setFileSelected(new Set());
      setConfirmFileTrash(false);
      // Files that belong to the catalog left rows behind; reload so Library
      // does not keep showing what just went to the Trash.
      if (result.trashed.length > 0) onFilesTrashed?.();
      if (result.failed.length > 0) {
        onError?.(
          new Error(result.failed[0].error),
          `${result.failed.length} file${result.failed.length === 1 ? "" : "s"} stayed put`,
        );
      }
    } catch (error) {
      onError?.(error, "Could not move those files to Trash");
    } finally {
      setFileBusy(false);
    }
  }, [fileSelected, confirmFileTrash, onError, onFilesTrashed]);

  // Media mode keyboard shortcuts
  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (mode !== "media" || busy) return;
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
      [mode, busy, selected, selectAllCopies, selectNone, onRequestDeleteItems],
    ),
  ]);

  // File mode keyboard shortcuts
  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (mode !== "files" || fileBusy) return;
        if (isEditableTarget(e.target)) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
          e.preventDefault();
          // Select all copies in all groups
          const ids = new Set<string>();
          fileGroups.forEach((group) => {
            const hasKeeper = group.items.some((item) => item.keeper);
            group.items.forEach((item, index) => {
              const isKeeper = hasKeeper ? item.keeper : index === 0;
              if (!isKeeper) ids.add(item.id);
            });
          });
          setFileSelected(ids);
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
          e.preventDefault();
          setFileSelected(new Set());
        }
        if (e.key === "Escape" && fileSelected.size > 0) {
          e.preventDefault();
          setFileSelected(new Set());
          setConfirmFileTrash(false);
        }
        if ((e.key === "Delete" || e.key === "Backspace") && fileSelected.size > 0) {
          e.preventDefault();
          void trashFileSelection();
        }
      },
      [mode, fileBusy, fileGroups, fileSelected, trashFileSelection],
    ),
  ]);

  const chooseFileFolder = useCallback(async () => {
    try {
      const chosen = await tauri.fileDuplicates.chooseFolder();
      if (chosen) setPickedFolder(chosen);
    } catch (error) {
      onError?.(error, "Could not open that folder");
    }
  }, [onError]);

  // A picked folder belongs to the any-file scan only, so clearing it must not
  // touch the library scope the user set for photos and videos.
  const clearPickedFolder = useCallback(() => {
    setPickedFolder(null);
  }, []);

  // Scanned files need not be catalog entries, so they cannot go through the
  // catalog-only reveal command: the backend resolves the scan id instead.
  const revealFileItem = useCallback(
    (id: string) => {
      void tauri.fileDuplicates
        .reveal(id)
        .catch((error: unknown) => onError?.(error, "Could not show that file in Finder"));
    },
    [onError],
  );

  const modeTabs = onChangeScope ? (
    <div className="duplicate-filter-tabs" role="group" aria-label="What to compare">
      <button
        type="button"
        aria-pressed={mode === "media"}
        className={mode === "media" ? "is-active" : ""}
        onClick={() => switchMode("media")}
      >
        Photos &amp; videos
      </button>
      <button
        type="button"
        aria-pressed={mode === "files"}
        className={mode === "files" ? "is-active" : ""}
        title="Compare every file type inside one folder, in memory only"
        onClick={() => switchMode("files")}
      >
        Any file type
      </button>
    </div>
  ) : null;

  const folderPicker =
    onChangeScope && (mode === "files" || folders.length > 0) ? (
      <div className="duplicate-folder-picker">
        <label className="source-select" title={scopeFolder ? `Only comparing files inside ${scopeFolder.name}` : "Comparing the whole library"}>
          <FolderIcon size={14} />
          <span className="source-select-label">Folder</span>
          <select
            value={scope ?? ""}
            onChange={(e) => {
              onChangeScope(e.target.value || null);
            }}
            aria-label="Only compare files in this folder"
            disabled={fileBusy}
          >
            <option value="">All folders</option>
            {folders.map((folder) => (
              <option key={folder.path} value={folder.path}>
                {folder.name}
              </option>
            ))}
          </select>
        </label>
        {mode === "files" && (
          <>
            <button
              type="button"
              className="choose-folder-button"
              title="Pick any folder on this Mac to compare every file type inside it"
              onClick={chooseFileFolder}
              disabled={fileBusy}
            >
              <FolderIcon size={14} />
              Choose folder…
            </button>
            {pickedFolder && (
              <div className="picked-folder-pill">
                <span>{folderName(pickedFolder)}</span>
                <button
                  type="button"
                  className="picked-folder-clear"
                  title="Compare the library folder again"
                  aria-label="Clear the folder picked for this scan"
                  onClick={clearPickedFolder}
                >
                  <XIcon size={12} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    ) : null;

  const renderFileRow = (item: FileDuplicateItem) => {
    const isSelected = fileSelected.has(item.id);
    return (
      <li key={item.id} className={`file-duplicate-row${isSelected ? " is-selected" : ""}`}>
        <button
          type="button"
          className="file-duplicate-pick"
          aria-pressed={isSelected}
          aria-label={`${isSelected ? "Deselect" : "Select"} ${item.name} in ${folderWithin(item.path, fileScan?.scope)}`}
          onClick={() => toggleFileItem(item.id)}
        >
          <span className={`file-duplicate-check${isSelected ? " is-on" : ""}`} aria-hidden="true">
            {isSelected ? <CheckIcon size={11} /> : null}
          </span>
        </button>
        <span className="file-duplicate-ext" aria-hidden="true">
          {item.extension || "file"}
        </span>
        <span className="file-duplicate-main">
          <span className="file-duplicate-name" title={item.path}>
            {item.name}
          </span>
          <MiddleTruncate
            text={folderWithin(item.path, fileScan?.scope)}
            className="file-duplicate-path"
          />
        </span>
        <span className="file-duplicate-size">{formatBytesSimple(item.size)}</span>
        {item.keeper ? <span className="file-duplicate-keep">Keep</span> : null}
        <button
          type="button"
          className="duplicate-tile-tool"
          title="Show in Finder"
          aria-label={`Show ${item.name} in Finder`}
          onClick={() => revealFileItem(item.id)}
        >
          <FolderIcon size={13} />
        </button>
      </li>
    );
  };

  const renderFileGroup = (group: FileDuplicateGroup) => {
    const keeper = keeperIdOf(group);
    const reclaimable = group.items
      .filter((item) => item.id !== keeper)
      .reduce((sum, item) => sum + item.size, 0);
    return (
      <section className="duplicate-group" key={group.id}>
        <header className="duplicate-group-head">
          <div className="duplicate-group-copy">
            <span className="duplicate-group-title">{group.items.length} identical copies</span>
            <span className="duplicate-group-sub">
              {formatBytesSimple(group.size)} each · <b>{formatBytesSimple(reclaimable)}</b>{" "}
              reclaimable
            </span>
          </div>
          <div className="duplicate-group-actions">
            <button
              type="button"
              className="quiet-button"
              disabled={fileBusy}
              onClick={() => selectFileCopies(group)}
            >
              Select copies
            </button>
          </div>
        </header>
        <ul className="file-duplicate-rows">{group.items.map(renderFileRow)}</ul>
      </section>
    );
  };

  const fileHeading = (
    <div className="page-heading">
      <div>
        <p className="eyebrow">CLEANUP</p>
        <h1>Duplicate files</h1>
        <p className="page-subtitle">
          {fileScan && fileGroups.length > 0
            ? `${fileGroups.length.toLocaleString()} ${fileGroups.length === 1 ? "group" : "groups"} · ${fileTotals.copies.toLocaleString()} extra ${fileTotals.copies === 1 ? "copy" : "copies"} · ${formatBytesSimple(fileTotals.bytes)} reclaimable · ${fileScan.filesScanned.toLocaleString()} files scanned · ${fileScan.filesCompared.toLocaleString()} compared`
            : fileScan
              ? `${fileScan.filesScanned.toLocaleString()} files scanned · ${fileScan.filesCompared.toLocaleString()} compared byte for byte inside ${fileScopeLabel}.`
              : fileScope
                ? `Compare every file type inside ${fileScopeLabel} — documents, project files, archives, photos. Hashes stay in memory for this scan and are never saved.`
                : "Pick a folder to compare every file type inside it."}
        </p>
      </div>
      <div className="duplicate-heading-actions">
        {modeTabs}
        <div className="duplicate-heading-row">
          {folderPicker}
          {fileScan && !fileBusy && (
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                setFileScan(null);
                setFileSelected(new Set());
                setConfirmFileTrash(false);
              }}
            >
              Clear
            </button>
          )}
          {fileBusy ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => void tauri.duplicates.cancel()}
            >
              Cancel
            </button>
          ) : fileScope && fileScan ? (
            <button type="button" className="primary-button" onClick={runFileScan}>
              Rescan
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );

  const fileBody = (
    <>
      {!fileScope ? (
        <div className="duplicate-empty">
          <span className="duplicate-empty-icon" aria-hidden="true">
            <DuplicatesIcon size={26} />
          </span>
          <h2>Choose a folder to compare</h2>
          <p>
            An any-file comparison runs inside one folder. Pick any folder on this Mac — it does not
            have to be a library source, because files are only read and never imported.
          </p>
          <button type="button" className="primary-button" onClick={() => void chooseFileFolder()}>
            Choose folder…
          </button>
        </div>
      ) : fileBusy ? (
        <div className="duplicate-empty">
          <span className="duplicate-empty-icon" aria-hidden="true">
            <DuplicatesIcon size={26} />
          </span>
          <h2>{fileProgress?.phase === "walking" ? "Listing files" : "Comparing file contents"}</h2>
          <p>
            {fileProgress?.phase === "walking"
              ? `Walking ${fileScopeLabel}. Hidden files, packages and node_modules are skipped.`
              : fileProgress && fileProgress.total
                ? `${(fileProgress.processed ?? 0).toLocaleString()} of ${fileProgress.total.toLocaleString()} files compared so far…`
                : `Comparing file contents inside ${fileScopeLabel}…`}
          </p>
          <button
            type="button"
            className="quiet-button"
            onClick={() => void tauri.duplicates.cancel()}
          >
            Cancel
          </button>
        </div>
      ) : !fileScan ? (
        <div className="duplicate-empty">
          <span className="duplicate-empty-icon" aria-hidden="true">
            <DuplicatesIcon size={26} />
          </span>
          <h2>Find duplicate files</h2>
          <p>
            Compares every file inside {fileScopeLabel} — text, PDFs, project files, archives,
            photos. Files are only read: the hashes stay in memory for this scan and are thrown away
            when you leave this screen.
          </p>
          <button type="button" className="primary-button" onClick={runFileScan}>
            Scan folder
          </button>
        </div>
      ) : fileGroups.length === 0 ? (
        <div className="duplicate-empty">
          <span className="duplicate-empty-icon" aria-hidden="true">
            <DuplicatesIcon size={26} />
          </span>
          <h2>
            {fileScan.cancelled
              ? "Scan cancelled"
              : fileScan.stoppedEarly
                ? "Scan stopped early"
                : "Every file is unique"}
          </h2>
          <p>
            {fileScan.cancelled || fileScan.stoppedEarly
              ? `${fileScan.filesScanned.toLocaleString()} files scanned and ${fileScan.filesCompared.toLocaleString()} compared inside ${fileScopeLabel} before the scan stopped. Files it did not reach were not compared.`
              : `${fileScan.filesScanned.toLocaleString()} files scanned and ${fileScan.filesCompared.toLocaleString()} compared byte for byte inside ${fileScopeLabel}. No two files have the same contents.`}
          </p>
          <button type="button" className="primary-button" onClick={runFileScan}>
            Scan again
          </button>
        </div>
      ) : (
        <>
          {fileScan.stoppedEarly && <p className="duplicate-notice">{fileScan.stoppedEarly}</p>}
          {fileScan.cancelled && (
            <p className="duplicate-notice">
              The scan was cancelled, so these results are partial. Scan again to finish.
            </p>
          )}
          <div className="duplicate-selection-bar">
            <div className="duplicate-selection-copy">
              <span>
                <b>{fileSelected.size.toLocaleString()}</b> of {fileTotals.copies.toLocaleString()}{" "}
                extra copies selected
              </span>
              {fileSelected.size > 0 && (
                <span className="duplicate-selection-savings">
                  {formatBytesSimple(fileSelectedBytes)} reclaimable
                </span>
              )}
            </div>
            <div className="duplicate-selection-actions">
              <button
                type="button"
                className="quiet-button"
                disabled={fileBusy || fileTotals.copies === 0}
                onClick={() => {
                  setFileSelected(new Set(fileGroups.flatMap(copyIdsOf)));
                  setConfirmFileTrash(false);
                }}
              >
                Select copies
              </button>
              <button
                type="button"
                className="quiet-button"
                disabled={fileSelected.size === 0}
                onClick={() => {
                  setFileSelected(new Set());
                  setConfirmFileTrash(false);
                }}
              >
                Clear
              </button>
              <button
                type="button"
                className={confirmFileTrash ? "danger-button is-armed" : "danger-button"}
                disabled={fileBusy || fileSelected.size === 0}
                onClick={trashFileSelection}
              >
                <TrashIcon size={13} />
                {confirmFileTrash
                  ? `Confirm: move ${fileSelected.size.toLocaleString()} to Trash`
                  : "Move to Trash"}
              </button>
            </div>
          </div>
          <div className="duplicate-groups">{fileGroups.map(renderFileGroup)}</div>
        </>
      )}
    </>
  );

  // File mode renders on its own so the media screen stays exactly as it was.
  if (mode === "files") {
    return (
      <div className="feature-page duplicates-page" ref={pageRef}>
        {onOpenCleanup && <CleanupTabs screen="Duplicates" onOpenCleanup={onOpenCleanup} />}
        {fileHeading}
        {fileBody}
      </div>
    );
  }

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
        <h1>Duplicate media</h1>
        <p className="page-subtitle">
          {hasGroups
            ? `${groups.length.toLocaleString()} ${groups.length === 1 ? "group" : "groups"} · ${libraryTotals.copies.toLocaleString()} extra ${libraryTotals.copies === 1 ? "copy" : "copies"} · ${formatBytesSimple(libraryTotals.bytes)} reclaimable`
            : scope
              ? `Find exact copies of the same photo or video inside ${scopeLabel} and free up the space they take.`
              : "Find exact copies of the same photo or video in your library and free up the space they take."}
        </p>
      </div>
      <div className="duplicate-heading-actions">
        {modeTabs}
        <div className="duplicate-heading-row">
          {folderPicker}
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
    </div>
  );

  return (
    <div className="feature-page duplicates-page" ref={pageRef} onScroll={handleScroll}>
      {onOpenCleanup && <CleanupTabs screen="Duplicates" onOpenCleanup={onOpenCleanup} />}
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
                  ? "Find duplicate media"
                  : EMPTY_TITLES[hasGroups ? filterKind : "all"]}
          </h2>
          <p>
            {isTrashing
              ? "The selected copies are being moved to Finder Trash. You can use Put Back in Finder if needed."
              : isDuplicateScan
                ? "Comparing files byte for byte. Large libraries can take a moment."
                : !hasGroups && !scanned
                  ? scope
                    ? `The scan compares the contents of every photo and video inside ${scopeLabel} — nothing outside it. Nothing is moved until you choose which copies to remove.`
                    : "The scan compares the contents of every photo and video in your library — nothing outside it. Nothing is moved until you choose which copies to remove."
                  : hasGroups
                    ? otherKinds.length > 0
                      ? `Found ${otherKindsLabel} instead. Use the media tabs above to switch.`
                      : "Nothing in this scan matches the selected media type."
                    : scope
                      ? `Every photo and video inside ${scopeLabel} is unique by content. Identical-looking shots that differ by even one byte are not flagged.`
                      : "Every photo and video in your library is unique by content. Identical-looking shots that differ by even one byte are not flagged."}
          </p>
          {!busy &&
            (hasGroups ? (
              <button type="button" className="quiet-button" onClick={() => changeFilter("all")}>
                Show all {groups.length.toLocaleString()} groups
              </button>
            ) : (
              <button type="button" className="primary-button" onClick={onScan}>
                {scanned ? "Scan again" : scope ? "Scan folder" : "Scan library"}
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
