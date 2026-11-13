import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { useLibraryStore } from "../../engine/stores";
import type { SmartAlbum, SmartAlbumFilter } from "../../engine/types/commands";
import { setScreen } from "../useNavigationStore";
import type { AlbumTarget, OpenContextMenu, ShowErrorNotice, ShowNotice } from "../types";

export type AlbumDialogMode = "create" | "rename";

interface SmartAlbumDialogState {
  mode: "create" | "edit";
  albumId?: string;
  name: string;
  filter: SmartAlbumFilter;
}

export interface AlbumRemovePending {
  albumId: string;
  itemIds: string[];
}

interface UseAlbumDialogsOptions {
  showNotice: ShowNotice;
  showErrorNotice: ShowErrorNotice;
  openContextMenu: OpenContextMenu;
  addItemsToAlbum: (albumId: string) => Promise<void>;
}

/**
 * State and actions for every album dialog: create/rename, the album picker,
 * delete-album and remove-from-album confirmations, the Smart Album editor,
 * and the album / smart-album context menus that open them.
 */
export function useAlbumDialogs({
  showNotice,
  showErrorNotice,
  openContextMenu,
  addItemsToAlbum,
}: UseAlbumDialogsOptions) {
  // Create / rename dialog.
  const [albumDialogOpen, setAlbumDialogOpen] = useState(false);
  const [albumDialogMode, setAlbumDialogMode] = useState<AlbumDialogMode>("create");
  const [albumName, setAlbumName] = useState("");
  const [albumSeedIds, setAlbumSeedIds] = useState<string[] | null>(null);
  const [renamingAlbumId, setRenamingAlbumId] = useState<string | null>(null);
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const albumInputRef = useRef<HTMLInputElement | null>(null);
  const albumDialogRef = useRef<HTMLFormElement | null>(null);

  // Smart Albums are edited in their own dialog, mounted only while open so
  // the form always starts from the album's current definition.
  const [smartAlbumDialog, setSmartAlbumDialog] = useState<SmartAlbumDialogState | null>(null);

  // Delete / remove confirmations.
  const [albumPendingDelete, setAlbumPendingDelete] = useState<AlbumTarget | null>(null);
  const [deletingAlbum, setDeletingAlbum] = useState(false);
  const deleteAlbumDialogRef = useRef<HTMLDivElement | null>(null);
  const [albumRemovePending, setAlbumRemovePending] = useState<AlbumRemovePending | null>(null);

  // Album picker ("Add to Album…").
  const [albumPickerOpen, setAlbumPickerOpen] = useState(false);
  const [albumPickerItemIds, setAlbumPickerItemIds] = useState<string[]>([]);
  const [albumSearch, setAlbumSearch] = useState("");
  const [addingToAlbumId, setAddingToAlbumId] = useState<string | null>(null);
  const albumSearchRef = useRef<HTMLInputElement | null>(null);

  const openAlbumDialog = useCallback((seedIds?: string[]) => {
    setAlbumDialogMode("create");
    setRenamingAlbumId(null);
    setAlbumSeedIds(seedIds && seedIds.length ? seedIds : null);
    setAlbumName("");
    setAlbumDialogOpen(true);
  }, []);

  const openRenameAlbumDialog = useCallback((album: AlbumTarget) => {
    setAlbumDialogMode("rename");
    setRenamingAlbumId(album.id);
    setAlbumSeedIds(null);
    setAlbumName(album.name);
    setAlbumDialogOpen(true);
  }, []);

  const closeAlbumDialog = useCallback(() => {
    if (creatingAlbum) return;
    setAlbumDialogOpen(false);
    setAlbumName("");
    setAlbumSeedIds(null);
    setRenamingAlbumId(null);
    setAlbumDialogMode("create");
  }, [creatingAlbum]);

  // Focus the name field as soon as the dialog mounts. Escape is owned by the
  // dialog layer (AppDialogs), not by this effect.
  useEffect(() => {
    if (!albumDialogOpen) return;
    const frame = requestAnimationFrame(() => {
      albumInputRef.current?.focus();
      albumInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [albumDialogOpen]);

  const submitAlbum = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = albumName.trim();
    if (!name || creatingAlbum) return;
    setCreatingAlbum(true);
    const library = useLibraryStore.getState();
    try {
      if (albumDialogMode === "rename" && renamingAlbumId) {
        await library.renameAlbum(renamingAlbumId, name);
        showNotice(`Renamed album to "${name}"`);
      } else {
        const seedIds = albumSeedIds ?? undefined;
        // The store updates the album list and posts the success notice.
        await library.createAlbum(name, seedIds);
      }
      setAlbumDialogOpen(false);
      setAlbumName("");
      setAlbumSeedIds(null);
      setRenamingAlbumId(null);
      setAlbumDialogMode("create");
    } catch (error) {
      showErrorNotice(
        error,
        `Could not ${albumDialogMode === "rename" ? "rename" : "create"} album`,
      );
    } finally {
      setCreatingAlbum(false);
    }
  };

  const openAlbumPicker = useCallback(
    (itemIds?: string[]) => {
      const selectedIds = useLibraryStore.getState().selectedIds;
      const ids = (itemIds && itemIds.length ? itemIds : selectedIds).filter(Boolean);
      if (!ids.length) {
        showNotice("Select photos first, then add them to an album.");
        return;
      }
      setAlbumPickerItemIds(ids);
      setAlbumSearch("");
      setAlbumPickerOpen(true);
    },
    [showNotice],
  );

  useEffect(() => {
    if (!albumPickerOpen) return;
    const frame = requestAnimationFrame(() => albumSearchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [albumPickerOpen]);

  const addPickedItemsToAlbum = async (album: AlbumTarget) => {
    if (!albumPickerItemIds.length || addingToAlbumId) return;
    setAddingToAlbumId(album.id);
    try {
      await useLibraryStore.getState().addToAlbum(album.id, albumPickerItemIds);
      setAlbumPickerOpen(false);
    } catch (error) {
      showErrorNotice(error, "Could not add to album");
    } finally {
      setAddingToAlbumId(null);
    }
  };

  const createAlbumFromPicker = () => {
    const seedIds = albumPickerItemIds;
    setAlbumPickerOpen(false);
    openAlbumDialog(seedIds);
  };

  const confirmRemoveFromAlbum = async () => {
    if (!albumRemovePending) return;
    try {
      await useLibraryStore
        .getState()
        .removeFromAlbum(albumRemovePending.albumId, albumRemovePending.itemIds);
      showNotice(
        `Removed ${albumRemovePending.itemIds.length} item${albumRemovePending.itemIds.length === 1 ? "" : "s"} from album.`,
      );
      setAlbumRemovePending(null);
    } catch (error) {
      showErrorNotice(error, "Could not remove");
    }
  };

  const confirmDeleteAlbum = async () => {
    if (!albumPendingDelete || deletingAlbum) return;
    const library = useLibraryStore.getState();
    const wasActiveAlbum = library.activeAlbum === albumPendingDelete.id;
    setDeletingAlbum(true);
    try {
      await library.deleteAlbum(albumPendingDelete.id);
      if (wasActiveAlbum) setScreen("Albums");
      showNotice(`Deleted album "${albumPendingDelete.name}". Your photos remain in the library.`);
      setAlbumPendingDelete(null);
    } catch (error) {
      showErrorNotice(error, "Could not delete album");
    } finally {
      setDeletingAlbum(false);
    }
  };

  const openAlbumMenu = (album: AlbumTarget, e: React.MouseEvent) => {
    openContextMenu(
      [
        {
          label: "Open Album",
          onClick: () => {
            const library = useLibraryStore.getState();
            library.setActiveAlbum(album.id);
            library.setFilter("All");
            library.setQuery("");
            setScreen("Library");
          },
        },
        { label: "Rename Album…", onClick: () => openRenameAlbumDialog(album) },
        { label: "Add Items…", onClick: () => addItemsToAlbum(album.id) },
        { divider: true },
        {
          label: "Delete Album…",
          danger: true,
          onClick: () => setAlbumPendingDelete(album),
        },
      ],
      e,
    );
  };

  const openSmartAlbum = async (albumId: string) => {
    await useLibraryStore.getState().openSmartAlbum(albumId);
    setScreen("Library");
  };

  const openSmartAlbumCreate = () =>
    setSmartAlbumDialog({
      mode: "create",
      name: "",
      filter: {},
    });

  const openSmartAlbumEdit = (album: SmartAlbum) =>
    setSmartAlbumDialog({
      mode: "edit",
      albumId: album.id,
      name: album.name,
      filter: album.filter,
    });

  const confirmDeleteSmartAlbum = (album: SmartAlbum) => {
    if (
      window.confirm(
        `Delete the Smart Album "${album.name}"? The saved filter is removed; photos are not changed.`,
      )
    ) {
      void useLibraryStore.getState().deleteSmartAlbum(album.id);
    }
  };

  const submitSmartAlbum = async (name: string, filter: SmartAlbumFilter) => {
    if (!smartAlbumDialog) return false;
    const library = useLibraryStore.getState();
    if (smartAlbumDialog.mode === "edit" && smartAlbumDialog.albumId) {
      return library.updateSmartAlbum(smartAlbumDialog.albumId, name, filter);
    }
    return library.createSmartAlbumFrom(name, filter);
  };

  const closeSmartAlbumDialog = () => setSmartAlbumDialog(null);

  const openSmartAlbumMenu = (album: SmartAlbum, e: React.MouseEvent) => {
    openContextMenu(
      [
        {
          label: "Open Smart Album",
          onClick: () => void openSmartAlbum(album.id),
        },
        {
          label: "Edit Smart Album…",
          onClick: () => openSmartAlbumEdit(album),
        },
        { divider: true },
        {
          label: "Delete Smart Album…",
          danger: true,
          onClick: () => confirmDeleteSmartAlbum(album),
        },
      ],
      e,
    );
  };

  return {
    // create / rename
    albumDialogOpen,
    albumDialogMode,
    albumName,
    albumSeedIds,
    creatingAlbum,
    setAlbumDialogOpen,
    setAlbumDialogMode,
    setAlbumName,
    setAlbumSeedIds,
    setRenamingAlbumId,
    setCreatingAlbum,
    albumInputRef,
    albumDialogRef,
    openAlbumDialog,
    openRenameAlbumDialog,
    closeAlbumDialog,
    submitAlbum,
    // delete / remove
    albumPendingDelete,
    setAlbumPendingDelete,
    deletingAlbum,
    setDeletingAlbum,
    deleteAlbumDialogRef,
    confirmDeleteAlbum,
    albumRemovePending,
    setAlbumRemovePending,
    confirmRemoveFromAlbum,
    // picker
    albumPickerOpen,
    setAlbumPickerOpen,
    albumPickerItemIds,
    setAlbumPickerItemIds,
    albumSearch,
    setAlbumSearch,
    addingToAlbumId,
    setAddingToAlbumId,
    albumSearchRef,
    openAlbumPicker,
    addPickedItemsToAlbum,
    createAlbumFromPicker,
    // menus
    openAlbumMenu,
    openSmartAlbumMenu,
    // smart albums
    smartAlbumDialog,
    closeSmartAlbumDialog,
    openSmartAlbum,
    openSmartAlbumCreate,
    openSmartAlbumEdit,
    confirmDeleteSmartAlbum,
    submitSmartAlbum,
  };
}
