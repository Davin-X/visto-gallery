import React, { useState } from "react";
import { formatBytes, tauri } from "../../engine/commands/tauri";
import { useLibraryStore } from "../../engine/stores";
import type { LibraryFolder } from "../../engine/types/commands";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ChevronDownIcon, ChevronUpIcon, FolderIcon, InfoIcon, MoreIcon, PlusIcon } from "./icons";

type SourceSortColumn = "name" | "itemCount" | "totalSize";
type SortDirection = "ascending" | "descending";

const sourceNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareSourceValue(a: LibraryFolder, b: LibraryFolder, column: SourceSortColumn) {
  if (column === "name") return sourceNameCollator.compare(a.name, b.name);
  const left = column === "itemCount" ? a.itemCount : a.totalSize;
  const right = column === "itemCount" ? b.itemCount : b.totalSize;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function SourcesManager(props: {
  variant?: "inline" | "sheet";
  onAddFolder?: () => void;
  onAddSourcePath?: (path: string) => Promise<void> | void;
  onRemoveFolder?: (folder: LibraryFolder) => void;
  onFilterSource?: (folder: LibraryFolder) => void;
  onRescan?: () => void;
  onRescanFolder?: (folder: LibraryFolder) => void;
  onRemoveAllSources?: () => void;
  onRestoreBackup?: () => void;
}) {
  const {
    variant = "inline",
    onAddFolder,
    onAddSourcePath,
    onRemoveFolder,
    onFilterSource,
    onRescan,
    onRescanFolder,
    onRemoveAllSources,
    onRestoreBackup,
  } = props;
  const folders = useLibraryStore((s) => s.folders);
  const activeSource = useLibraryStore((s) => s.activeSource);
  const libraryBusy = useLibraryStore((s) => s.busy);
  const setActiveSource = useLibraryStore((s) => s.setActiveSource);
  const [query, setQuery] = useState("");
  const [showPastePath, setShowPastePath] = useState(false);
  const [pastePath, setPastePath] = useState("");
  const [pasting, setPasting] = useState(false);
  const [sort, setSort] = useState<{ column: SourceSortColumn; direction: SortDirection }>({
    column: "itemCount",
    direction: "descending",
  });
  const [menu, setMenu] = useState<{
    folder: LibraryFolder;
    x: number;
    y: number;
  } | null>(null);

  const totalItems = folders.reduce((sum, folder) => sum + folder.itemCount, 0);
  const totalSize = folders.reduce((sum, folder) => sum + folder.totalSize, 0);

  const isViewing = (folder: LibraryFolder) =>
    activeSource === folder.path || Boolean(activeSource?.startsWith(`${folder.path}/`));

  const openMenu = (folder: LibraryFolder, event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ folder, x: rect.right - 4, y: rect.bottom + 4 });
  };

  const reveal = (folder: LibraryFolder) => {
    void tauri.items.revealInFinder(folder.path).catch((error: unknown) => {
      useLibraryStore
        .getState()
        .showErrorNotice(error, `Could not reveal “${folder.name}” in Finder`);
    });
  };

  // A missing source usually just moved (a renamed folder, a drive mounted
  // under a new name). Locate… points it at the new place with the same root
  // mapping Settings offers, so every item keeps its albums, tags and edits.
  const [locating, setLocating] = useState<string | null>(null);
  const locate = async (folder: LibraryFolder) => {
    if (locating) return;
    const library = useLibraryStore.getState();
    let picked: string | null;
    try {
      picked = await tauri.rootMap.chooseFolder(folder.path);
    } catch (error) {
      library.showErrorNotice(error, "Could not open the folder picker");
      return;
    }
    if (!picked) return;
    setLocating(folder.path);
    try {
      const preview = await tauri.rootMap.preview(folder.path, picked);
      if (preview.conflictingPaths.length > 0) {
        library.showNotice(
          `“${folder.name}” was not moved: ${preview.conflictingPaths.length.toLocaleString()} file(s) there are already in the library. Nothing was changed.`,
          "invalidInput",
        );
        return;
      }
      const result = await tauri.rootMap.apply(folder.path, picked);
      await library.loadFolders();
      await library.loadLibrary();
      library.showNotice(
        `Found “${folder.name}”. ${result.updatedItemCount.toLocaleString()} item${result.updatedItemCount === 1 ? "" : "s"} reconnected; your files were not changed.`,
      );
    } catch (error) {
      library.showErrorNotice(error, `Could not locate “${folder.name}”`);
    } finally {
      setLocating(null);
    }
  };

  const filterTo = (folder: LibraryFolder) => {
    setActiveSource(folder.path);
    onFilterSource?.(folder);
  };

  const menuItems = (folder: LibraryFolder): ContextMenuItem[] => {
    const viewing = isViewing(folder);
    const missing = !folder.available;
    return [
      {
        label: viewing ? "Viewing in Library" : "View in Library",
        disabled: viewing || missing,
        onClick: () => filterTo(folder),
      },
      { label: "Show in Finder", disabled: missing, onClick: () => reveal(folder) },
      {
        label: "Rescan this source",
        disabled: !onRescanFolder || missing,
        onClick: () => void onRescanFolder?.(folder),
      },
      { label: "", divider: true },
      {
        label: "Remove source…",
        danger: true,
        disabled: !onRemoveFolder,
        onClick: () => onRemoveFolder?.(folder),
      },
    ];
  };

  const q = query.trim().toLowerCase();
  const filteredFolders = q
    ? folders.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
    : folders;
  const sortedFolders = [...filteredFolders].sort((a, b) => {
    const comparison = compareSourceValue(a, b, sort.column);
    const pathComparison = a.path.toLowerCase().localeCompare(b.path.toLowerCase());
    const primary = sort.direction === "ascending" ? comparison : -comparison;
    return primary || pathComparison;
  });
  const sortBy = (column: SourceSortColumn) =>
    setSort((current) =>
      current.column === column
        ? {
            column,
            direction: current.direction === "ascending" ? "descending" : "ascending",
          }
        : { column, direction: "ascending" },
    );
  const sortHeader = (column: SourceSortColumn, label: string) => {
    const active = sort.column === column;
    const nextDirection = active && sort.direction === "ascending" ? "descending" : "ascending";
    const Indicator = sort.direction === "ascending" ? ChevronUpIcon : ChevronDownIcon;
    return (
      <button
        type="button"
        className="sources-sort-button"
        aria-label={`Sort by ${label} ${nextDirection}`}
        onClick={() => sortBy(column)}
      >
        {label}
        {active ? (
          <Indicator size={12} />
        ) : (
          <span className="sources-sort-hint" aria-hidden="true">
            <ChevronUpIcon size={9} />
            <ChevronDownIcon size={9} />
          </span>
        )}
      </button>
    );
  };

  const body = (
    <>
      <div className="sources-summary">
        <div className="sources-summary-copy">
          <span className="sources-summary-text">
            {folders.length.toLocaleString()} source
            {folders.length === 1 ? "" : "s"}
            <span className="sources-summary-dot" aria-hidden="true">
              ·
            </span>
            {totalItems.toLocaleString()} items
            <span className="sources-summary-dot" aria-hidden="true">
              ·
            </span>
            {formatBytes(totalSize)}
          </span>
        </div>
        <div className="sources-summary-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => onAddFolder?.()}
            disabled={!onAddFolder || libraryBusy}
            title="Select multiple folders with ⌘-click or ⌘A"
          >
            <PlusIcon size={14} />
            Add source
          </button>
          {onAddSourcePath && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setShowPastePath((v) => !v);
                setPastePath("");
              }}
              disabled={libraryBusy}
              title="Paste or type a folder path to index"
            >
              Add by path…
            </button>
          )}
          {onRescan && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => onRescan()}
              disabled={libraryBusy || folders.length === 0}
              title={folders.length === 0 ? "Add a source before rescanning" : undefined}
            >
              {libraryBusy ? "Working…" : "Rescan sources"}
            </button>
          )}
          {folders.length > 0 && (
            <div className="sources-filter">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter sources…"
                aria-label="Filter sources"
              />
            </div>
          )}
        </div>
      </div>

      {showPastePath && (
        <form
          className="sources-paste-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const trimmed = pastePath.trim();
            if (!trimmed || pasting) return;
            setPasting(true);
            try {
              await onAddSourcePath?.(trimmed);
              setShowPastePath(false);
              setPastePath("");
            } finally {
              setPasting(false);
            }
          }}
        >
          <input
            type="text"
            className="sources-paste-input"
            value={pastePath}
            onChange={(e) => setPastePath(e.target.value)}
            placeholder="e.g. ~/Pictures or /Volumes/Drive/Photos"
            aria-label="Folder path"
            autoFocus
          />
          <button
            type="submit"
            className="primary-button"
            disabled={!pastePath.trim() || pasting || libraryBusy}
          >
            {pasting ? "Adding…" : "Add"}
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={pasting}
            onClick={() => {
              setShowPastePath(false);
              setPastePath("");
            }}
          >
            Cancel
          </button>
        </form>
      )}

      {folders.length === 0 ? (
        <div className="sources-empty">
          <span className="sources-empty-icon">
            <FolderIcon size={24} />
          </span>
          <b>No sources yet</b>
          <p>Add a folder to start indexing your library.</p>
          {onRestoreBackup && (
            <button type="button" className="quiet-button" onClick={onRestoreBackup}>
              Restore from backup…
            </button>
          )}
        </div>
      ) : filteredFolders.length === 0 ? (
        <div className="sources-empty">
          <span className="sources-empty-icon">
            <FolderIcon size={24} />
          </span>
          <b>No matching sources</b>
          <p>Try a different search term.</p>
        </div>
      ) : (
        <div className="sources-table-viewport">
          <table className="sources-table">
            <caption className="sources-sr-only">Library sources</caption>
            <thead>
              <tr>
                <th scope="col" aria-sort={sort.column === "name" ? sort.direction : undefined}>
                  {sortHeader("name", "Source")}
                </th>
                <th
                  scope="col"
                  className="sources-num"
                  aria-sort={sort.column === "itemCount" ? sort.direction : undefined}
                >
                  {sortHeader("itemCount", "Items")}
                </th>
                <th
                  scope="col"
                  className="sources-num"
                  aria-sort={sort.column === "totalSize" ? sort.direction : undefined}
                >
                  {sortHeader("totalSize", "Size")}
                </th>
                <th scope="col">
                  <span className="sources-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedFolders.map((folder) => {
                const viewing = isViewing(folder);
                const missing = !folder.available;
                return (
                  <tr
                    key={folder.path}
                    className={
                      [viewing ? "is-active" : "", missing ? "is-missing" : ""]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({ folder, x: event.clientX, y: event.clientY });
                    }}
                  >
                    <td>
                      <span className="sources-name">
                        <span className="sources-icon">
                          <FolderIcon size={15} />
                        </span>
                        <span className="sources-name-body">
                          <span className="sources-name-line">
                            <span className="sources-name-text" title={folder.name}>
                              {folder.name}
                            </span>
                            {missing ? (
                              <span className="sources-missing">Missing</span>
                            ) : viewing ? (
                              <span className="sources-active">Viewing</span>
                            ) : null}
                          </span>
                          <button
                            type="button"
                            className="sources-path"
                            title={folder.path}
                            aria-label={
                              missing
                                ? `Missing folder: ${folder.path}`
                                : `Show ${folder.path} in Finder`
                            }
                            onClick={() => {
                              if (!missing) reveal(folder);
                            }}
                            disabled={missing}
                          >
                            {compactPath(folder.path)}
                          </button>
                        </span>
                      </span>
                    </td>
                    <td className="sources-num">{folder.itemCount.toLocaleString()}</td>
                    <td className="sources-num">{formatBytes(folder.totalSize)}</td>
                    <td className="sources-actions">
                      <div className="sources-row-actions">
                        {missing ? (
                          <button
                            type="button"
                            className="sources-row-view"
                            title={`Point ${folder.name} at its new location`}
                            disabled={locating !== null}
                            onClick={() => void locate(folder)}
                          >
                            {locating === folder.path ? "Locating…" : "Locate…"}
                          </button>
                        ) : !viewing ? (
                          <button
                            type="button"
                            className="sources-row-view"
                            title={`View ${folder.name} in the library`}
                            onClick={() => filterTo(folder)}
                          >
                            View
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="sources-row-menu"
                          aria-label={`Actions for ${folder.name}`}
                          aria-haspopup="menu"
                          aria-expanded={menu?.folder.path === folder.path}
                          title="Source actions"
                          onClick={(event) => openMenu(folder, event)}
                        >
                          <MoreIcon size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {menu && (
        <ContextMenu
          items={menuItems(menu.folder)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}

      {folders.length > 0 && variant !== "sheet" && (
        <div className="sources-footer">
          <SourcesRemovalNote />
          {onRemoveAllSources && (
            <button
              className="quiet-button sources-remove-all"
              type="button"
              onClick={onRemoveAllSources}
              disabled={libraryBusy}
            >
              Remove all sources…
            </button>
          )}
        </div>
      )}
    </>
  );

  if (variant === "sheet") {
    return <div className="sources-manager">{body}</div>;
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">
        <FolderIcon size={14} /> Sources
      </h2>
      <p className="settings-section-desc">
        Folders VistoGallery indexes. Your files are read in place and never moved.
      </p>
      {body}
    </section>
  );
}

export function SourcesRemovalNote() {
  return (
    <p className="sources-note">
      <InfoIcon size={14} />
      <span>Removing a source leaves its files on disk.</span>
    </p>
  );
}

/** `/Users/dev/Pictures/Trips/2024` → `~/Pictures/…/2024` — keeps the tail. */
function compactPath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+/);
  let compact = home ? `~${path.slice(home[0].length)}` : path;
  const parts = compact.split("/").filter(Boolean);
  if (parts.length > 4) {
    compact = `${parts[0] === "~" ? "~/" : "/"}…/${parts.slice(-2).join("/")}`;
  }
  return compact;
}
