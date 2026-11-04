import {
  useCallback,
  useEffect,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { useFocusTrap } from "../design/hooks/useFocusTrap";
import { useKeyboard } from "../engine/hooks/useKeyboard";
import { AlbumsIcon, FolderIcon, PlusIcon, SearchIcon } from "../design/components/icons";
import { SourcesManager } from "../design/components/SourcesManager";
import { tauri } from "../engine/commands/tauri";
import type { LibraryFolder, UpdateCheckResult } from "../engine/types/commands";

type AlbumDialogMode = "create" | "rename";

interface AlbumPickerTarget {
  id: string;
  name: string;
  itemCount?: number;
}

interface AppDialogsProps {
  albumDialogOpen: boolean;
  albumDialogMode: AlbumDialogMode;
  albumName: string;
  albumSeedIds: string[] | null;
  creatingAlbum: boolean;
  setAlbumDialogOpen: (open: boolean) => void;
  setAlbumDialogMode: (mode: AlbumDialogMode) => void;
  setAlbumName: (name: string) => void;
  setAlbumSeedIds: (ids: string[] | null) => void;
  setRenamingAlbumId: (id: string | null) => void;
  setCreatingAlbum: (creating: boolean) => void;

  albumPendingDelete: AlbumPickerTarget | null;
  deletingAlbum: boolean;
  setAlbumPendingDelete: (album: AlbumPickerTarget | null) => void;
  setDeletingAlbum: (deleting: boolean) => void;

  itemPendingDeleteCount: number;
  setItemPendingDeleteCount: (count: number) => void;

  albumRemovePending: { albumId: string; itemIds: string[] } | null;
  setAlbumRemovePending: (pending: { albumId: string; itemIds: string[] } | null) => void;

  albumPickerOpen: boolean;
  albumPickerItemIds: string[];
  albumPickerSearch: string;
  addingToAlbumId: string | null;
  setAlbumPickerOpen: (open: boolean) => void;
  setAlbumPickerItemIds: (ids: string[]) => void;
  setAlbumPickerSearch: (search: string) => void;
  setAddingToAlbumId: (id: string | null) => void;

  sourcesSheetOpen: boolean;
  setSourcesSheetOpen: (open: boolean) => void;

  removeAllSourcesDialogOpen: boolean;
  setRemoveAllSourcesDialogOpen: (open: boolean) => void;

  folderPendingRemove: LibraryFolder | null;
  removingFolder: boolean;
  setFolderPendingRemove: (folder: LibraryFolder | null) => void;
  setRemovingFolder: (removing: boolean) => void;

  aboutOpen: boolean;
  setAboutOpen: (open: boolean) => void;
  appVersion: string;

  updateDialogOpen: boolean;
  setUpdateDialogOpen: (open: boolean) => void;
  updateInfo: UpdateCheckResult | null;
  updateChecking: boolean;

  library: any;
  setScreen: (screen: string) => void;
  submitAlbum: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
  closeAlbumDialog: () => void;
  addPickedItemsToAlbum: (album: AlbumPickerTarget) => Promise<void>;
  createAlbumFromPicker: () => void;
  confirmDeleteAlbum: () => Promise<void>;
  confirmDeleteItem: () => void;
  confirmRemoveFromAlbum: () => Promise<void>;
  confirmRemoveFolder: () => Promise<void>;
  removeAllSources: () => Promise<void>;
  rescanSources: () => Promise<void>;
  rescanSource: (folder: LibraryFolder) => Promise<void>;
  importFolder: () => void;
  checkForUpdates: (manual: boolean) => void;

  albumDialogRef: RefObject<HTMLFormElement>;
  updateDialogRef: RefObject<HTMLDivElement>;
  aboutDialogRef: RefObject<HTMLDivElement>;
  deleteAlbumDialogRef: RefObject<HTMLDivElement>;
  deleteItemDialogRef: RefObject<HTMLDivElement>;
  removeFolderDialogRef: RefObject<HTMLDivElement>;
  albumInputRef: RefObject<HTMLInputElement>;
  albumSearchRef: RefObject<HTMLInputElement>;
  itemPendingDeleteRef: MutableRefObject<string[] | null>;
}

function Backdrop({
  open,
  onClose,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  if (!open) return null;

  return (
    <div
      className={className ? `dialog-backdrop ${className}` : "dialog-backdrop"}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

function DialogHeader({
  eyebrow,
  title,
  titleId,
  onClose,
  disabled,
}: {
  eyebrow: string;
  title: string;
  titleId: string;
  onClose: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="dialog-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={titleId}>{title}</h2>
      </div>
      <button
        type="button"
        className="dialog-close"
        aria-label="Close"
        onClick={onClose}
        disabled={disabled}
      >
        ×
      </button>
    </div>
  );
}

function useEscape(onClose: () => void, condition = true) {
  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (condition && e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      },
      [onClose, condition],
    ),
  ]);
}

function UpdateDialog({
  open,
  onClose,
  dialogRef,
  info,
}: {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLDivElement>;
  info: UpdateCheckResult | null;
}) {
  useFocusTrap(open, dialogRef);
  useEscape(onClose, open);

  if (!open || !info) return null;

  return (
    <Backdrop open={open} onClose={onClose}>
      <div
        ref={dialogRef}
        className="album-dialog update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
      >
        <DialogHeader
          eyebrow="UPDATE"
          title={`VistoGallery ${info.latestVersion} is available`}
          titleId="update-dialog-title"
          onClose={onClose}
        />
        <p className="dialog-hint">
          You&apos;re running v{info.currentVersion}. Download the latest build, then drag
          VistoGallery.app into Applications to replace the old copy.
        </p>
        {info.notes && <pre className="update-notes">{info.notes}</pre>}
        <div className="dialog-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={() => {
              localStorage.setItem(`update:skip:${info.latestVersion}`, "1");
              onClose();
            }}
          >
            Skip this version
          </button>
          <button type="button" className="quiet-button" onClick={onClose}>
            Later
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              void tauri.app.openExternal(info.downloadUrl || info.releaseUrl);
            }}
          >
            Download
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function AboutDialog({
  open,
  onClose,
  dialogRef,
  version,
  updateAvailable,
  onCheckForUpdates,
  checking,
}: {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLDivElement>;
  version: string;
  updateAvailable: boolean;
  onCheckForUpdates: (manual: boolean) => void;
  checking: boolean;
}) {
  useFocusTrap(open, dialogRef);
  useEscape(onClose, open);

  if (!open) return null;

  return (
    <Backdrop open={open} onClose={onClose}>
      <div
        ref={dialogRef}
        className="album-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
      >
        <DialogHeader
          eyebrow="ABOUT"
          title="VistoGallery"
          titleId="about-dialog-title"
          onClose={onClose}
        />
        <p className="dialog-hint">Native macOS photo gallery.</p>
        <p className="dialog-hint">Version {version || "dev"}</p>
        {updateAvailable && <p className="dialog-hint">A new version is available to download.</p>}
        <div className="dialog-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={() => void onCheckForUpdates(true)}
            disabled={checking}
          >
            {checking ? "Checking…" : "Check for Updates"}
          </button>
          <button type="button" className="primary-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function AlbumDialog({
  open,
  mode,
  name,
  seedIds,
  creating,
  onClose,
  onSubmit,
  dialogRef,
  inputRef,
  library,
  setName,
}: {
  open: boolean;
  mode: AlbumDialogMode;
  name: string;
  seedIds: string[] | null;
  creating: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
  dialogRef: RefObject<HTMLFormElement>;
  inputRef: RefObject<HTMLInputElement>;
  library: any;
  setName: (name: string) => void;
}) {
  useFocusTrap(open, dialogRef);
  useEscape(onClose, open);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, inputRef]);

  if (!open) return null;

  const count = seedIds?.length ?? (library.selectedIds.length || (library.inspectedId ? 1 : 0));

  return (
    <Backdrop open={open} onClose={onClose}>
      <form
        ref={dialogRef}
        className="album-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="album-dialog-title"
        onSubmit={onSubmit}
      >
        <DialogHeader
          eyebrow="ORGANISE"
          title={mode === "rename" ? "Rename album" : "New album"}
          titleId="album-dialog-title"
          onClose={onClose}
          disabled={creating}
        />
        <div className="dialog-field">
          <label htmlFor="album-name">Album name</label>
          <input
            id="album-name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Summer 2026"
            maxLength={80}
            autoComplete="off"
            disabled={creating}
          />
        </div>
        <p className="dialog-hint">
          {mode === "rename"
            ? "This only changes the album name. Photos stay in this album."
            : count
              ? `Adds ${count.toLocaleString()} item${count === 1 ? "" : "s"} to the new album.`
              : "You can add photos to it from the library or an album at any time."}
        </p>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose} disabled={creating}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={!name.trim() || creating}>
            {creating
              ? mode === "rename"
                ? "Saving…"
                : "Creating…"
              : mode === "rename"
                ? "Save name"
                : "Create album"}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

function AlbumPickerDialog({
  open,
  itemIds,
  search,
  addingToAlbumId,
  onClose,
  onSearchChange,
  onClearSearch,
  onAddToAlbum,
  onCreateAlbum,
  searchRef,
  library,
}: {
  open: boolean;
  itemIds: string[];
  search: string;
  addingToAlbumId: string | null;
  onClose: () => void;
  onSearchChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClearSearch: () => void;
  onAddToAlbum: (album: AlbumPickerTarget) => Promise<void>;
  onCreateAlbum: () => void;
  searchRef: RefObject<HTMLInputElement>;
  library: any;
}) {
  useFocusTrap(open, searchRef);
  useEscape(onClose, open);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, searchRef]);

  if (!open) return null;

  const selectedItems = library.items.filter((item: any) => itemIds.includes(item.id));
  const query = search.trim().toLowerCase();
  const matching = library.albums.filter(
    (album: any) => !query || album.name.toLowerCase().includes(query),
  );

  return (
    <Backdrop open={open} onClose={onClose} className="album-picker-backdrop">
      <div
        className="album-dialog album-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="album-picker-title"
      >
        <DialogHeader
          eyebrow="ORGANISE"
          title="Add to album"
          titleId="album-picker-title"
          onClose={onClose}
          disabled={Boolean(addingToAlbumId)}
        />
        <p className="album-picker-subtitle">
          {itemIds.length.toLocaleString()} selected item
          {itemIds.length === 1 ? "" : "s"}
        </p>
        <div className="album-picker-search">
          <SearchIcon size={15} />
          <input
            ref={searchRef}
            value={search}
            onChange={onSearchChange}
            placeholder="Search albums"
            aria-label="Search albums"
            disabled={Boolean(addingToAlbumId)}
          />
          {search && (
            <button
              type="button"
              className="album-picker-search-clear"
              aria-label="Clear album search"
              onClick={onClearSearch}
            >
              ×
            </button>
          )}
        </div>
        <div className="album-picker-list" role="listbox" aria-label="Albums">
          {!matching.length ? (
            <div className="album-picker-empty">
              <AlbumsIcon size={24} />
              <b>{library.albums.length ? "No matching albums" : "No albums yet"}</b>
              <p>
                {library.albums.length
                  ? "Try a different search."
                  : "Create an album and these photos will be added to it."}
              </p>
            </div>
          ) : (
            matching.map((album: any, index: number) => {
              const alreadyAdded =
                selectedItems.length > 0 &&
                selectedItems.every((item: any) => item.albumIds?.includes(album.id));
              const busy = addingToAlbumId === album.id;
              const count = album.itemCount || 0;
              return (
                <button
                  key={album.id}
                  type="button"
                  className="album-picker-row"
                  onClick={() => onAddToAlbum(album)}
                  disabled={Boolean(addingToAlbumId) || alreadyAdded}
                  role="option"
                  aria-selected="false"
                >
                  <i className={`album-dot ${["coral", "violet", "blue", "green"][index % 4]}`} />
                  <span className="album-picker-name">{album.name}</span>
                  <span className="album-picker-count">
                    {alreadyAdded
                      ? "Already added"
                      : `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`}
                  </span>
                  {busy && <span className="spinner album-picker-spinner" />}
                </button>
              );
            })
          )}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={onClose}
            disabled={Boolean(addingToAlbumId)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onCreateAlbum}
            disabled={Boolean(addingToAlbumId)}
          >
            <PlusIcon size={14} /> New album
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function DeleteAlbumDialog({
  open,
  album,
  deleting,
  onClose,
  onConfirm,
  dialogRef,
}: {
  open: boolean;
  album: AlbumPickerTarget | null;
  deleting: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  dialogRef: RefObject<HTMLDivElement>;
}) {
  useFocusTrap(open, dialogRef);
  useEscape(onClose, open && !deleting);

  if (!open || !album) return null;

  return (
    <Backdrop
      open={open}
      onClose={() => {
        if (!deleting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="album-dialog delete-album-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-album-title"
        aria-describedby="delete-album-description"
      >
        <DialogHeader
          eyebrow="ALBUM"
          title="Delete Album?"
          titleId="delete-album-title"
          onClose={onClose}
          disabled={deleting}
        />
        <p className="delete-album-copy">
          Are you sure you want to delete <b>“{album.name}”</b>?
        </p>
        <div className="delete-album-safety" id="delete-album-description">
          <span>
            <AlbumsIcon size={19} />
          </span>
          <p>
            <b>Your photos are safe.</b> This only removes the album and its grouping.{" "}
            {album.itemCount
              ? `${album.itemCount.toLocaleString()} item${
                  album.itemCount === 1 ? "" : "s"
                } will remain in your library.`
              : "The items remain in your library."}
          </p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete Album"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function DeleteItemDialog({
  open,
  count,
  onClose,
  onConfirm,
  dialogRef,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onConfirm: () => void;
  dialogRef: RefObject<HTMLDivElement>;
}) {
  useFocusTrap(open, dialogRef);
  useEscape(onClose, open);

  if (!open) return null;

  return (
    <Backdrop open={open} onClose={onClose}>
      <div
        ref={dialogRef}
        className="album-dialog delete-album-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-item-title"
      >
        <DialogHeader
          eyebrow="PHOTO"
          title="Delete Item?"
          titleId="delete-item-title"
          onClose={onClose}
        />
        <p className="delete-album-copy">
          Are you sure you want to delete{" "}
          <b>
            {count} item{count === 1 ? "" : "s"}
          </b>
          ? They will be moved to Trash.
        </p>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function RemoveFromAlbumDialog({
  open,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  pending: { albumId: string; itemIds: string[] } | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  useEscape(onClose, open);

  if (!open || !pending) return null;

  return (
    <Backdrop open={open} onClose={onClose}>
      <div className="album-dialog delete-album-dialog" role="alertdialog" aria-modal="true">
        <DialogHeader
          eyebrow="ALBUM"
          title="Remove from Album?"
          titleId="remove-from-album-title"
          onClose={onClose}
        />
        <p className="delete-album-copy">
          Remove {pending.itemIds.length} item
          {pending.itemIds.length === 1 ? "" : "s"} from this album?
        </p>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={onConfirm}>
            Remove
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function SourcesSheet({
  open,
  onClose,
  onAddFolder,
  onRemoveFolder,
  onFilterSource,
  onRescan,
  onRescanFolder,
  onRequestRemoveAll,
  escapeBlocked,
  library,
}: {
  open: boolean;
  onClose: () => void;
  onAddFolder: () => void;
  onRemoveFolder: (folder: LibraryFolder) => void;
  onFilterSource: () => void;
  onRescan: () => Promise<void>;
  onRescanFolder: (folder: LibraryFolder) => Promise<void>;
  onRequestRemoveAll: () => void;
  /** When a confirmation is stacked on top, it owns Escape instead. */
  escapeBlocked: boolean;
  library: any;
}) {
  useEscape(onClose, open && !escapeBlocked);

  if (!open) return null;

  return (
    <Backdrop open={open} onClose={onClose} className="sources-sheet-backdrop">
      <div
        className="album-dialog sources-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sources-sheet-title"
      >
        <DialogHeader
          eyebrow="LIBRARY"
          title="Sources"
          titleId="sources-sheet-title"
          onClose={onClose}
        />
        <SourcesManager
          variant="sheet"
          onAddFolder={onAddFolder}
          onRemoveFolder={onRemoveFolder}
          onFilterSource={onFilterSource}
          onRescan={() => {
            void onRescan();
          }}
          onRescanFolder={(folder) => {
            void onRescanFolder(folder);
          }}
        />
        <div className="dialog-actions">
          <button
            type="button"
            className="danger-button"
            disabled={library.busy || library.folders.length === 0}
            onClick={onRequestRemoveAll}
          >
            Remove all sources
          </button>
          <div style={{ flex: 1 }} />
          <button type="button" className="quiet-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function RemoveAllSourcesDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  useEscape(onClose, open);

  if (!open) return null;

  return (
    <Backdrop open={open} onClose={onClose}>
      <div className="album-dialog" role="dialog" aria-modal="true">
        <div className="dialog-heading">
          <h2>Remove all sources?</h2>
        </div>
        <div className="dialog-body">
          This removes all source folders from the library. Files stay on disk.
        </div>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={onConfirm}>
            Remove all
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

function RemoveFolderDialog({
  open,
  folder,
  removing,
  onClose,
  onConfirm,
  dialogRef,
}: {
  open: boolean;
  folder: LibraryFolder | null;
  removing: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  dialogRef: RefObject<HTMLDivElement>;
}) {
  useFocusTrap(open, dialogRef);
  useEscape(onClose, open && !removing);

  if (!open || !folder) return null;

  return (
    <Backdrop
      open={open}
      onClose={() => {
        if (!removing) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="album-dialog delete-album-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-folder-title"
        aria-describedby="remove-folder-description"
      >
        <DialogHeader
          eyebrow="FOLDER"
          title="Remove Folder?"
          titleId="remove-folder-title"
          onClose={onClose}
          disabled={removing}
        />
        <p className="delete-album-copy">
          Remove <b>“{folder.name}”</b> from VistoGallery?
        </p>
        <div className="delete-album-safety" id="remove-folder-description">
          <span>
            <FolderIcon size={19} />
          </span>
          <p>
            <b>Your files are safe.</b>{" "}
            {folder.itemCount > 0
              ? `This only unstages the folder and its ${folder.itemCount.toLocaleString()} item${
                  folder.itemCount === 1 ? "" : "s"
                } from the library.`
              : "This only removes the empty folder entry from the library."}{" "}
            Nothing is deleted from disk — import the folder again to bring it back.
          </p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose} disabled={removing}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={removing}>
            {removing ? "Removing…" : "Remove Folder"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

/**
 * AppDialogs renders every modal dialog and sheet in the app. All state and
 * handlers are passed in from App so the dialogs remain presentational.
 */
export function AppDialogs(props: AppDialogsProps) {
  const {
    albumDialogOpen,
    albumDialogMode,
    albumName,
    albumSeedIds,
    creatingAlbum,
    setAlbumName,
    albumPendingDelete,
    deletingAlbum,
    setAlbumPendingDelete,
    itemPendingDeleteCount,
    setItemPendingDeleteCount,
    albumRemovePending,
    setAlbumRemovePending,
    albumPickerOpen,
    albumPickerItemIds,
    albumPickerSearch,
    addingToAlbumId,
    setAlbumPickerOpen,
    setAlbumPickerSearch,
    sourcesSheetOpen,
    setSourcesSheetOpen,
    removeAllSourcesDialogOpen,
    setRemoveAllSourcesDialogOpen,
    folderPendingRemove,
    removingFolder,
    setFolderPendingRemove,
    aboutOpen,
    setAboutOpen,
    appVersion,
    updateDialogOpen,
    setUpdateDialogOpen,
    updateInfo,
    updateChecking,
    library,
    setScreen,
    submitAlbum,
    closeAlbumDialog,
    addPickedItemsToAlbum,
    createAlbumFromPicker,
    confirmDeleteAlbum,
    confirmDeleteItem,
    confirmRemoveFromAlbum,
    confirmRemoveFolder,
    removeAllSources,
    rescanSources,
    rescanSource,
    importFolder,
    checkForUpdates,
    albumDialogRef,
    updateDialogRef,
    aboutDialogRef,
    deleteAlbumDialogRef,
    deleteItemDialogRef,
    removeFolderDialogRef,
    albumInputRef,
    albumSearchRef,
    itemPendingDeleteRef,
  } = props;

  const closeItemDialog = () => {
    setItemPendingDeleteCount(0);
    itemPendingDeleteRef.current = null;
  };

  return (
    <>
      <UpdateDialog
        open={updateDialogOpen}
        onClose={() => setUpdateDialogOpen(false)}
        dialogRef={updateDialogRef}
        info={updateInfo}
      />
      <AboutDialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        dialogRef={aboutDialogRef}
        version={appVersion}
        updateAvailable={updateInfo?.available ?? false}
        onCheckForUpdates={checkForUpdates}
        checking={updateChecking}
      />
      <AlbumDialog
        open={albumDialogOpen}
        mode={albumDialogMode}
        name={albumName}
        seedIds={albumSeedIds}
        creating={creatingAlbum}
        onClose={closeAlbumDialog}
        onSubmit={submitAlbum}
        dialogRef={albumDialogRef}
        inputRef={albumInputRef}
        library={library}
        setName={setAlbumName}
      />
      <AlbumPickerDialog
        open={albumPickerOpen}
        itemIds={albumPickerItemIds}
        search={albumPickerSearch}
        addingToAlbumId={addingToAlbumId}
        onClose={() => {
          if (!addingToAlbumId) setAlbumPickerOpen(false);
        }}
        onSearchChange={(e) => setAlbumPickerSearch(e.target.value)}
        onClearSearch={() => {
          setAlbumPickerSearch("");
          albumSearchRef.current?.focus();
        }}
        onAddToAlbum={addPickedItemsToAlbum}
        onCreateAlbum={createAlbumFromPicker}
        searchRef={albumSearchRef}
        library={library}
      />
      <DeleteAlbumDialog
        open={albumPendingDelete != null}
        album={albumPendingDelete}
        deleting={deletingAlbum}
        onClose={() => setAlbumPendingDelete(null)}
        onConfirm={confirmDeleteAlbum}
        dialogRef={deleteAlbumDialogRef}
      />
      <DeleteItemDialog
        open={itemPendingDeleteCount > 0}
        count={itemPendingDeleteCount}
        onClose={closeItemDialog}
        onConfirm={confirmDeleteItem}
        dialogRef={deleteItemDialogRef}
      />
      <RemoveFromAlbumDialog
        open={albumRemovePending != null}
        pending={albumRemovePending}
        onClose={() => setAlbumRemovePending(null)}
        onConfirm={confirmRemoveFromAlbum}
      />
      <SourcesSheet
        open={sourcesSheetOpen}
        onClose={() => setSourcesSheetOpen(false)}
        onAddFolder={importFolder}
        onRemoveFolder={(folder: LibraryFolder) => setFolderPendingRemove(folder)}
        onFilterSource={() => {
          setScreen("Library");
          setSourcesSheetOpen(false);
        }}
        onRescan={rescanSources}
        onRescanFolder={rescanSource}
        onRequestRemoveAll={() => setRemoveAllSourcesDialogOpen(true)}
        escapeBlocked={removeAllSourcesDialogOpen || folderPendingRemove != null}
        library={library}
      />
      <RemoveAllSourcesDialog
        open={removeAllSourcesDialogOpen}
        onClose={() => setRemoveAllSourcesDialogOpen(false)}
        onConfirm={() => {
          setRemoveAllSourcesDialogOpen(false);
          void removeAllSources();
        }}
      />
      <RemoveFolderDialog
        open={folderPendingRemove != null}
        folder={folderPendingRemove}
        removing={removingFolder}
        onClose={() => setFolderPendingRemove(null)}
        onConfirm={confirmRemoveFolder}
        dialogRef={removeFolderDialogRef}
      />
    </>
  );
}
