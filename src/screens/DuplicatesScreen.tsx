import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "../engine/hooks/useKeyboard";
import {
  CheckIcon,
  ChevronDownIcon,
  ColumnsIcon,
  DuplicatesIcon,
  FolderIcon,
  GridIcon,
  TrashIcon,
  XIcon,
} from "../design/components/icons";
import { events, tauri } from "../engine/commands/tauri";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import type { DuplicateGroup, MediaItem, SimilarGroup } from "../engine/types/media";
import type {
  FileDuplicateGroup,
  FileDuplicateItem,
  FileDuplicateScan,
  LibraryFolder,
} from "../engine/types/commands";
import {
  buildBurstGroupViews,
  buildGroupViews,
  type GroupView,
  type KeeperMode,
} from "../engine/duplicates/grouping";
import { CompareOverlay } from "../design/components/CompareOverlay";
import { CleanupTabs } from "../design/components/CleanupTabs";
import { MiddleTruncate } from "../design/components/MiddleTruncate";

import { DuplicateGroupCard, INLINE_COPIES } from "./duplicates/DuplicateGroupCard";
import { parentFolder } from "./duplicates/paths";

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
  burstGroups?: SimilarGroup[];
  burstScanned?: boolean;
  onSetBurstGroups?: (groups: SimilarGroup[]) => void;
  onSetBurstScanned?: (scanned: boolean) => void;
  onClearBursts?: () => void;
  onScanSimilar?: (scope?: string | null) => Promise<void>;
}

const GROUP_PAGE = 40;
// Any-file groups are single rows, so a whole page costs little. The scan can
// return thousands of them, and rendering all of them at once froze the UI.
const FILE_GROUP_PAGE = 50;

type ViewMode = "grid" | "list";
type ScanMode = "media" | "bursts" | "files";
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

function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed || "/";
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
  const [mode, setMode] = useState<ScanMode>("media");
  const [localBurstGroups, setLocalBurstGroups] = useState<SimilarGroup[]>([]);
  const [localBurstScanned, setLocalBurstScanned] = useState(false);
  const burstGroups = props.burstGroups ?? localBurstGroups;
  const burstScanned = props.burstScanned ?? localBurstScanned;
  const setBurstGroups = props.onSetBurstGroups ?? setLocalBurstGroups;
  const setBurstScanned = props.onSetBurstScanned ?? setLocalBurstScanned;
  const [burstBusy, setBurstBusy] = useState(false);
  const [burstProgress, setBurstProgress] = useState<{
    phase?: string;
    processed?: number;
    total?: number;
    currentFile?: string;
  } | null>(null);
  const burstScanRequest = useRef(0);
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
    const currentItems =
      mode === "bursts" ? burstGroups.map((bg) => bg.items) : groups.map((g) => g.items);
    const counts: Record<KindFilter, number> = {
      all: currentItems.length,
      photo: 0,
      video: 0,
      raw: 0,
    };
    currentItems.forEach((items) => {
      const kinds = new Set(items.map((item) => item.kind));
      if (kinds.has("photo")) counts.photo += 1;
      if (kinds.has("video")) counts.video += 1;
      if (kinds.has("raw")) counts.raw += 1;
    });
    return counts;
  }, [mode, burstGroups, groups]);

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

  const burstMap = useMemo(() => {
    const map = new Map<string, SimilarGroup>();
    for (const bg of burstGroups) {
      map.set(bg.id, bg);
    }
    return map;
  }, [burstGroups]);

  const groupViews = useMemo<GroupView[]>(() => {
    if (mode === "bursts") {
      return buildBurstGroupViews(burstGroups, { filterKind, keeperMode, sortBy });
    }
    return buildGroupViews(groups, { filterKind, keeperMode, sortBy });
  }, [mode, burstGroups, groups, filterKind, keeperMode, sortBy]);

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
    const activeItems =
      mode === "bursts" ? burstGroups.map((bg) => bg.items) : groups.map((g) => g.items);
    activeItems.forEach((items) => {
      copies += Math.max(0, items.length - 1);
      bytes += items.slice(1).reduce((sum, item) => sum + item.size, 0);
    });
    return { copies, bytes };
  }, [mode, burstGroups, groups]);

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

  // ---- Any-file scan --------------------------------------------------
  // A separate scan from the media one: the backend walks the chosen folder,
  // keeps every hash in memory and never touches the media catalog. Results
  // live here, so leaving the screen throws them away.
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
  const [fileRenderLimit, setFileRenderLimit] = useState(FILE_GROUP_PAGE);
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
    let pending: {
      phase?: string;
      processed?: number;
      total?: number;
      currentFile?: string;
    } | null = null;

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

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    let frame: number | null = null;
    let pending: {
      phase?: string;
      processed?: number;
      total?: number;
      currentFile?: string;
    } | null = null;

    if (typeof events.onSimilarProgress !== "function") return;

    void events
      .onSimilarProgress((event) => {
        pending = event;
        if (frame === null) {
          frame = window.requestAnimationFrame(() => {
            frame = null;
            if (!disposed && pending) {
              setBurstProgress(pending);
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
    setFileRenderLimit(FILE_GROUP_PAGE);
    if (fileBusyRef.current) void tauri.duplicates.cancel();
  }, [fileScope]);

  useEffect(() => {
    burstScanRequest.current += 1;
    setBurstGroups([]);
    setBurstScanned(false);
    setBurstProgress(null);
  }, [scope, setBurstGroups, setBurstScanned]);

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

  // Progressive render for file groups to keep DOM small on huge scans.
  const renderedFileGroups = useMemo(
    () => fileGroups.slice(0, fileRenderLimit),
    [fileGroups, fileRenderLimit],
  );

  const { onScanSimilar, onSetBurstGroups, onSetBurstScanned } = props;
  const runBurstScan = useCallback(async () => {
    if (onScanSimilar) {
      await onScanSimilar(scope);
      return;
    }
    const request = burstScanRequest.current + 1;
    burstScanRequest.current = request;
    setBurstBusy(true);
    setBurstProgress({
      phase: "analyzing",
      processed: 0,
      total: 0,
      currentFile: "Loading photos for visual scan…",
    });
    try {
      const result = await tauri.duplicates.scanSimilar({
        scope: scope ?? null,
        timeWindowMs: 3500,
        maxHammingDistance: 14,
      });
      if (request !== burstScanRequest.current) return;
      setBurstGroups(result);
      setBurstScanned(true);
      onSetBurstGroups?.(result);
      onSetBurstScanned?.(true);
      setSelected(new Set());
    } catch (error) {
      if (request === burstScanRequest.current) {
        onError?.(error, "Could not find burst photos");
      }
    } finally {
      if (request === burstScanRequest.current) {
        setBurstBusy(false);
        setBurstProgress(null);
      }
    }
  }, [
    onScanSimilar,
    onSetBurstGroups,
    onSetBurstScanned,
    scope,
    onError,
    setBurstGroups,
    setBurstScanned,
  ]);

  const switchMode = useCallback((next: ScanMode) => {
    setMode(next);
    setConfirmFileTrash(false);
    setSelected(new Set());
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
      setFileRenderLimit(FILE_GROUP_PAGE);
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
  const clearPickedFolder = useCallback(() => setPickedFolder(null), []);

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
    <div
      className="duplicate-filter-tabs duplicate-mode-tabs"
      role="group"
      aria-label="What to compare"
    >
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
        aria-pressed={mode === "bursts"}
        className={mode === "bursts" ? "is-active" : ""}
        title="Find camera bursts and visually similar photos in your library"
        onClick={() => switchMode("bursts")}
      >
        Bursts &amp; similar
      </button>
      <button
        type="button"
        aria-pressed={mode === "files"}
        className={mode === "files" ? "is-active" : ""}
        title="Compare file contents in a single folder"
        onClick={() => switchMode("files")}
      >
        Any file type
      </button>
    </div>
  ) : null;

  const folderPicker =
    onChangeScope && (mode === "files" || folders.length > 0) ? (
      <div className="duplicate-folder-picker">
        <label
          className="source-select"
          title={
            scopeFolder
              ? `Only comparing files inside ${scopeFolder.name}`
              : "Comparing the whole library"
          }
        >
          <FolderIcon size={14} />
          <span className="source-select-label">Folder</span>
          <span className="duplicate-folder-value" aria-hidden="true">
            {scopeFolder ? <MiddleTruncate text={scopeFolder.name} /> : "All folders"}
            <ChevronDownIcon size={12} />
          </span>
          <select
            value={scope ?? ""}
            onChange={(e) => onChangeScope(e.target.value || null)}
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
        <h1>Duplicate files</h1>
        {fileGroups.length > 0 && (
          <p className="page-subtitle">
            {fileGroups.length.toLocaleString()} {fileGroups.length === 1 ? "group" : "groups"} ·{" "}
            {fileTotals.copies.toLocaleString()} extra {fileTotals.copies === 1 ? "copy" : "copies"}{" "}
            · {formatBytesSimple(fileTotals.bytes)} reclaimable
          </p>
        )}
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
          <h2>Ready to scan {fileScopeLabel}</h2>
          <p>VistoGallery compares file contents without changing your files.</p>
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
          <p className="duplicate-notice">
            {fileScan.filesScanned.toLocaleString()} files scanned ·{" "}
            {fileScan.filesCompared.toLocaleString()} compared
          </p>
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
          <div className="duplicate-groups">{renderedFileGroups.map(renderFileGroup)}</div>
          {fileRenderLimit < fileGroups.length && (
            <div className="duplicate-load-more">
              <button
                type="button"
                className="quiet-button"
                onClick={() =>
                  setFileRenderLimit((limit) =>
                    Math.min(limit + FILE_GROUP_PAGE, fileGroups.length),
                  )
                }
              >
                Show{" "}
                {Math.min(FILE_GROUP_PAGE, fileGroups.length - fileRenderLimit).toLocaleString()}{" "}
                more {fileGroups.length - fileRenderLimit === 1 ? "group" : "groups"}
              </button>
            </div>
          )}
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

  const hasGroups = mode === "bursts" ? burstGroups.length > 0 : groups.length > 0;
  const hasVisibleGroups = groupViews.length > 0;
  const isCurrentBusy = mode === "bursts" ? burstBusy : busy;
  const isCurrentScanned = mode === "bursts" ? burstScanned : scanned;
  const currentOnScan = mode === "bursts" ? runBurstScan : onScan;
  const isDuplicateScan =
    isCurrentBusy && (progress?.phase === "hashing" || progress?.phase === "analyzing");
  const isTrashing = isCurrentBusy && progress?.phase === "trashing";
  const canAct = !isCurrentBusy && selected.size > 0;
  const allCopiesSelected = totalCopies > 0 && selectedCopyCount >= totalCopies;

  const visibleSummaryCount = (mode === "bursts" ? burstGroups : groups).length;
  const pageHeading = (
    <div className="page-heading">
      <div>
        <h1>{mode === "bursts" ? "Bursts & similar photos" : "Duplicate photos & videos"}</h1>
        {hasGroups && (
          <p className="page-subtitle">
            {visibleSummaryCount.toLocaleString()} {visibleSummaryCount === 1 ? "group" : "groups"}{" "}
            · {libraryTotals.copies.toLocaleString()} extra{" "}
            {mode === "bursts"
              ? libraryTotals.copies === 1
                ? "shot"
                : "shots"
              : libraryTotals.copies === 1
                ? "copy"
                : "copies"}{" "}
            · {formatBytesSimple(libraryTotals.bytes)} reclaimable
          </p>
        )}
      </div>
      <div className="duplicate-heading-actions">
        {modeTabs}
        <div className="duplicate-heading-row">
          {folderPicker}
          {hasGroups && (
            <button
              type="button"
              className="quiet-button"
              onClick={
                mode === "bursts"
                  ? () => (props.onClearBursts ? props.onClearBursts() : setBurstGroups([]))
                  : onClear
              }
              disabled={isCurrentBusy}
            >
              Clear
            </button>
          )}
          {/* With no results the empty state carries the only scan button. */}
          {(hasGroups || isCurrentBusy) && (
            <button
              type="button"
              className="primary-button"
              onClick={currentOnScan}
              disabled={isCurrentBusy}
            >
              {isTrashing
                ? "Moving to Trash…"
                : mode === "bursts" && burstBusy
                  ? "Analyzing bursts…"
                  : isDuplicateScan
                    ? "Scanning…"
                    : "Rescan"}
            </button>
          )}
          {mode === "bursts" && burstBusy && (
            <button
              type="button"
              className="quiet-button"
              onClick={() => void tauri.duplicates.cancelSimilar()}
            >
              Cancel
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
          {mode === "bursts" ? (
            burstBusy ? (
              <>
                <h2>Analyzing camera bursts</h2>
                <p>
                  {burstProgress && burstProgress.total
                    ? `${(burstProgress.processed ?? 0).toLocaleString()} of ${burstProgress.total.toLocaleString()} photos analyzed (${Math.round(((burstProgress.processed ?? 0) / burstProgress.total) * 100)}%)…`
                    : (burstProgress?.currentFile ??
                      "Finding camera bursts and visually similar photos…")}
                </p>
                {burstProgress && burstProgress.total ? (
                  <div
                    className="busy-indicator-progress-track"
                    role="progressbar"
                    aria-label="Burst scan progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(
                      ((burstProgress.processed ?? 0) / burstProgress.total) * 100,
                    )}
                    style={{ width: 280, maxWidth: "100%", margin: "14px auto" }}
                  >
                    <span
                      style={{
                        width: `${Math.round(((burstProgress.processed ?? 0) / burstProgress.total) * 100)}%`,
                      }}
                    />
                  </div>
                ) : null}
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => void tauri.duplicates.cancelSimilar()}
                >
                  Cancel
                </button>
              </>
            ) : !burstScanned ? (
              <>
                <h2>Ready to scan {scope ? scopeLabel : "your library"}</h2>
                <p>
                  Find camera bursts and visually similar photos you can review before removing
                  anything.
                </p>
                <button type="button" className="primary-button" onClick={runBurstScan}>
                  {scope ? "Scan folder for bursts" : "Scan library for bursts"}
                </button>
              </>
            ) : (
              <>
                <h2>No burst photos found</h2>
                <p>
                  {scope
                    ? `Every photo inside ${scopeLabel} appears visually distinct or outside burst time windows.`
                    : "Every photo in your library appears visually distinct or outside burst time windows."}
                </p>
                <button type="button" className="primary-button" onClick={runBurstScan}>
                  Scan again
                </button>
              </>
            )
          ) : (
            <>
              <h2>
                {isTrashing
                  ? "Moving selected files to Trash"
                  : isDuplicateScan
                    ? "Scanning your library"
                    : !hasGroups && !scanned
                      ? `Ready to scan ${scope ? scopeLabel : "your library"}`
                      : EMPTY_TITLES[hasGroups ? filterKind : "all"]}
              </h2>
              <p>
                {isTrashing
                  ? "The selected copies are being moved to Finder Trash. You can use Put Back in Finder if needed."
                  : isDuplicateScan
                    ? "Comparing files byte for byte. Large libraries can take a moment."
                    : !hasGroups && !scanned
                      ? "Find exact copies of photos and videos. You choose which copies to remove."
                      : hasGroups
                        ? otherKinds.length > 0
                          ? `Found ${otherKindsLabel} instead. Use the media tabs above to switch.`
                          : "Nothing in this scan matches the selected media type."
                        : scope
                          ? `Every photo and video inside ${scopeLabel} is unique by content. Identical-looking shots that differ by even one byte are not flagged.`
                          : "Every photo and video in your library is unique by content. Identical-looking shots that differ by even one byte are not flagged."}
              </p>
              {!isCurrentBusy &&
                (hasGroups ? (
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => changeFilter("all")}
                  >
                    Show all {groups.length.toLocaleString()} groups
                  </button>
                ) : (
                  <button type="button" className="primary-button" onClick={currentOnScan}>
                    {isCurrentScanned ? "Scan again" : scope ? "Scan folder" : "Scan library"}
                  </button>
                ))}
            </>
          )}
        </div>
      ) : (
        <>
          {mode === "bursts" && burstBusy && (
            <div className="duplicate-burst-progress-banner" role="status">
              <span className="spinner" />
              <span className="duplicate-burst-progress-text">
                {burstProgress && burstProgress.total
                  ? `Analyzing bursts: ${(burstProgress.processed ?? 0).toLocaleString()} of ${burstProgress.total.toLocaleString()} photos (${Math.round(((burstProgress.processed ?? 0) / burstProgress.total) * 100)}%)`
                  : (burstProgress?.currentFile ?? "Finding camera bursts…")}
              </span>
              {burstProgress && burstProgress.total ? (
                <div
                  className="busy-indicator-progress-track"
                  role="progressbar"
                  aria-label="Burst scan progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(
                    ((burstProgress.processed ?? 0) / burstProgress.total) * 100,
                  )}
                  style={{ width: 140, flexShrink: 0 }}
                >
                  <span
                    style={{
                      width: `${Math.round(((burstProgress.processed ?? 0) / burstProgress.total) * 100)}%`,
                    }}
                  />
                </div>
              ) : null}
              <button
                type="button"
                className="quiet-button"
                onClick={() => void tauri.duplicates.cancelSimilar()}
              >
                Cancel
              </button>
            </div>
          )}
          <div className="duplicate-groups">
            {groupViews.slice(0, renderLimit).map((view) => (
              <DuplicateGroupCard
                key={view.group.sha256}
                view={view}
                expanded={expandedGroups.has(view.group.sha256)}
                busy={busy}
                viewMode={viewMode}
                burst={mode === "bursts" ? burstMap.get(view.group.id) : undefined}
                selected={selected}
                toggleGroupCopies={toggleGroupCopies}
                toggleGroupExpand={toggleGroupExpand}
                assetUrl={assetUrl}
                onOpenItem={onOpenItem}
                toggleItem={toggleItem}
                onCompare={setCompare}
              />
            ))}
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
