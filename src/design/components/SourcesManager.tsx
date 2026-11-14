import React, { useState } from "react";
import { formatBytes, tauri } from "../../engine/commands/tauri";
import { debugLog, useLibraryStore } from "../../engine/stores";
import type { LibraryFolder } from "../../engine/types/commands";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FolderIcon, InfoIcon, MoreIcon, PlusIcon } from "./icons";

export function SourcesManager(props: {
  variant?: "inline" | "sheet";
  onAddFolder?: () => void;
  onRemoveFolder?: (folder: LibraryFolder) => void;
  onFilterSource?: (folder: LibraryFolder) => void;
  onRescan?: () => void;
  onRescanFolder?: (folder: LibraryFolder) => void;
  onRemoveAllSources?: () => void;
}) {
  const {
    variant = "inline",
    onAddFolder,
    onRemoveFolder,
    onFilterSource,
    onRescan,
    onRescanFolder,
    onRemoveAllSources,
  } = props;
  const folders = useLibraryStore((s) => s.folders);
  const activeSource = useLibraryStore((s) => s.activeSource);
  const libraryBusy = useLibraryStore((s) => s.busy);
  const setActiveSource = useLibraryStore((s) => s.setActiveSource);
  const [query, setQuery] = useState("");
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
      debugLog("reveal_in_finder failed:", error);
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
          <span className="sources-summary-hint">
            Files stay in place. Select multiple folders with ⌘-click or ⌘A; they scan together.
          </span>
        </div>
        <div className="sources-summary-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => onAddFolder?.()}
            disabled={!onAddFolder}
            title="Select multiple folders with ⌘-click or ⌘A"
          >
            <PlusIcon size={14} />
            Add source
          </button>
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
          {onRemoveAllSources && folders.length > 0 && (
            <button
              className="quiet-button sources-remove-all"
              type="button"
              onClick={() => onRemoveAllSources()}
              disabled={libraryBusy}
            >
              Remove all sources…
            </button>
          )}
        </div>
      </div>

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

      {folders.length === 0 ? (
        <div className="sources-empty">
          <span className="sources-empty-icon">
            <FolderIcon size={24} />
          </span>
          <b>No sources yet</b>
          <span>Add a folder to start indexing your library.</span>
        </div>
      ) : filteredFolders.length === 0 ? (
        <div className="sources-empty">
          <span className="sources-empty-icon">
            <FolderIcon size={24} />
          </span>
          <b>No matching sources</b>
          <span>Try a different search term.</span>
        </div>
      ) : (
        <div className="sources-table-viewport">
          <table className="sources-table">
            <caption className="sources-sr-only">Library sources</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col" className="sources-num">
                  Items
                </th>
                <th scope="col" className="sources-num">
                  Size
                </th>
                <th scope="col">
                  <span className="sources-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredFolders.map((folder) => {
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

      {folders.length > 0 && (
        <p className="sources-note">
          <InfoIcon size={14} />
          <span>
            Removing a source only clears it from VistoGallery. Your files stay exactly where they
            are on disk, and adding the folder again brings everything back.
          </span>
        </p>
      )}
    </>
  );

  if (variant === "sheet") {
    return <div className="sources-manager">{body}</div>;
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Sources</h2>
      <p className="settings-section-desc">
        Folders VistoGallery indexes. Your files are read in place and never moved.
      </p>
      {body}
    </section>
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
