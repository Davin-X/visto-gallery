import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { EyeOffIcon, ImageOffIcon } from "../design/components/icons";
import { BrandMark } from "../design/components/BrandMark";
import LibraryScreen from "./LibraryScreen";
import { useFocusTrap } from "../design/hooks/useFocusTrap";
import { useKeyboard } from "../engine/hooks/useKeyboard";
import { useLibraryStore } from "../engine/stores/useLibraryStore";
import { useShallow } from "zustand/react/shallow";
import type { MediaItem } from "../engine/types/media";

interface HiddenScreenProps {
  assetUrl: (path: string) => string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onContextMenu: (items: MediaItem[], e: React.MouseEvent) => void;
  onNavigate: (screen: any) => void;
  onCreateAlbum: () => void;
  onOpenAlbumPicker: (itemIds?: string[]) => void;
  onRequestDeleteItems: (ids: string[]) => void;
  onOpenEdit: (item: MediaItem) => void;
  onOpenViewer: (id?: string) => void;
  /** Start a background session for a video without leaving the grid. */
  onPlayBackground?: (id: string) => void;
  onPlaySlideshow?: (ids?: string[]) => void;
}

function HiddenScreen(props: HiddenScreenProps) {
  const library = useLibraryStore(
    useShallow((s) => ({
      albums: s.albums,
      busy: s.busy,
      clearSelection: s.clearSelection,
      colorLabelFilter: s.colorLabelFilter,
      dateFrom: s.dateFrom,
      dateTo: s.dateTo,
      deleteItems: s.deleteItems,
      hiddenCount: s.hiddenCount,
      hiddenFilter: s.hiddenFilter,
      hiddenItems: s.hiddenItems,
      hiddenQuery: s.hiddenQuery,
      inspectItem: s.inspectItem,
      inspectedId: s.inspectedId,
      items: s.items,
      layout: s.layout,
      minRating: s.minRating,
      progress: s.progress,
      selectedIds: s.selectedIds,
      setActiveAlbum: s.setActiveAlbum,
      setColorLabelFilter: s.setColorLabelFilter,
      setColorLabelForIds: s.setColorLabelForIds,
      setDateRange: s.setDateRange,
      setFavoriteForIds: s.setFavoriteForIds,
      setHiddenFilter: s.setHiddenFilter,
      setHiddenForIds: s.setHiddenForIds,
      setHiddenQuery: s.setHiddenQuery,
      setLayout: s.setLayout,
      setMinRating: s.setMinRating,
      setRatingForIds: s.setRatingForIds,
      setSelectedIds: s.setSelectedIds,
      showInspector: s.showInspector,
      showNotice: s.showNotice,
      toggleFavorite: s.toggleFavorite,
      toggleHidden: s.toggleHidden,
      toggleInspector: s.toggleInspector,
      toggleSelection: s.toggleSelection,
      updateItemTags: s.updateItemTags,
    })),
  );
  const hiddenLibraryStats = useMemo(
    () => ({
      photos: library.hiddenItems.filter((i: MediaItem) => i.kind === "photo").length,
      videos: library.hiddenItems.filter((i: MediaItem) => i.kind === "video").length,
      raws: library.hiddenItems.filter((i: MediaItem) => i.kind === "raw").length,
      animations: library.hiddenItems.filter((i: MediaItem) => i.isAnimated).length,
      favorites: library.hiddenItems.filter((i: MediaItem) => i.favorite).length,
    }),
    [library.hiddenItems],
  );
  const filter = library.hiddenFilter;
  const query = library.hiddenQuery;
  const [pendingReveal, setPendingReveal] = useState<
    | { kind: "viewer"; id?: string }
    | { kind: "background"; id: string }
    | { kind: "edit"; item: MediaItem }
    | { kind: "slideshow"; ids: string[] }
    | null
  >(null);

  const items = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return library.hiddenItems.filter((item: MediaItem) => {
      if (filter === "Photos" && item.kind !== "photo") return false;
      if (filter === "Videos" && item.kind !== "video") return false;
      if (filter === "RAW" && item.kind !== "raw") return false;
      if (filter === "Animations" && !item.isAnimated) return false;
      if (filter === "Favorites" && !item.favorite) return false;
      if (!normalized) return true;
      return `${item.name} ${item.path} ${item.extension} ${item.kind} ${item.camera || ""} ${item.lens || ""} ${(item.tags || []).join(" ")}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [library.hiddenItems, filter, query]);

  useEffect(() => {
    const onOpenHidden = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      setPendingReveal({ kind: "viewer", id });
    };
    window.addEventListener("mac-gallery:open-hidden", onOpenHidden);
    return () => window.removeEventListener("mac-gallery:open-hidden", onOpenHidden);
  }, []);

  useEffect(() => {
    if (!pendingReveal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPendingReveal(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pendingReveal]);

  const requestViewer = (id?: string) => setPendingReveal({ kind: "viewer", id });
  const requestBackground = (id: string) => setPendingReveal({ kind: "background", id });
  const requestEdit = (item: MediaItem) => setPendingReveal({ kind: "edit", item });

  const requestSlideshow = (ids?: string[]) => {
    const selection = ids && ids.length ? new Set(ids) : null;
    const scope = selection ? items.filter((item) => selection.has(item.id)) : items;
    if (scope.length === 0) {
      library.showNotice("Add photos or videos to start a slideshow.");
      return;
    }
    setPendingReveal({ kind: "slideshow", ids: scope.map((item) => item.id) });
  };

  const confirmReveal = () => {
    const request = pendingReveal;
    if (!request) return;
    setPendingReveal(null);
    if (request.kind === "slideshow") {
      const ids = new Set(request.ids);
      const scope = library.hiddenItems.filter((item) => ids.has(item.id));
      if (scope.length) props.onPlaySlideshow?.(scope.map((item: any) => item.id));
      return;
    }
    if (request.kind === "background") {
      props.onPlayBackground?.(request.id);
      return;
    }
    if (request.kind === "edit") {
      props.onOpenEdit(request.item);
      return;
    }
    props.onOpenViewer(request.id);
  };

  const revealCopy = (() => {
    if (!pendingReveal) return { title: "", body: "", action: "Show" };
    if (pendingReveal.kind === "slideshow") {
      const count = pendingReveal.ids.length;
      return {
        title: `Play ${count} hidden ${count === 1 ? "item" : "items"}?`,
        body: "They will be visible on screen until you stop the slideshow. Hidden items remain on disk at their original paths and are not encrypted.",
        action: "Play slideshow",
      };
    }
    if (pendingReveal.kind === "background") {
      return {
        title: "Play this hidden video?",
        body: "It will play in the background until you stop it. Hidden items remain on disk at their original paths and are not encrypted.",
        action: "Play video",
      };
    }
    if (pendingReveal.kind === "edit") {
      return {
        title: "Open this hidden item in the editor?",
        body: "The item will be visible in the editor. Hidden items remain on disk at their original paths and are not encrypted.",
        action: "Open editor",
      };
    }
    return {
      title: "Show this hidden item?",
      body: "It will be visible on screen. Hidden items remain on disk at their original paths and are not encrypted.",
      action: "Show item",
    };
  })();

  const mergeUnique = (base: string[], extra: string[]) => [...new Set([...base, ...extra])];

  const toggleSelectAll = () => {
    const allSelected =
      items.length > 0 && items.every((item) => library.selectedIds.includes(item.id));
    if (allSelected) {
      const visible = new Set(items.map((item) => item.id));
      library.setSelectedIds(library.selectedIds.filter((id) => !visible.has(id)));
    } else {
      library.setSelectedIds(mergeUnique(library.selectedIds, items.map((item) => item.id)));
    }
  };

  const selectRange = (startId: string, endId: string) => {
    const start = items.findIndex((item) => item.id === startId);
    const end = items.findIndex((item) => item.id === endId);
    if (start < 0 || end < 0) return;
    const [from, to] = start <= end ? [start, end] : [end, start];
    library.setSelectedIds(
      mergeUnique(
        library.selectedIds,
        items.slice(from, to + 1).map((item) => item.id),
      ),
    );
  };

  const revealDialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(pendingReveal !== null, revealDialogRef);
  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (e.key !== "Escape" || pendingReveal === null) return;
        e.preventDefault();
        setPendingReveal(null);
      },
      [pendingReveal],
    ),
  ]);

  return (
    <>
      <LibraryScreen
        hiddenView
        items={items}
        inspectedId={library.inspectedId}
        selectedIds={library.selectedIds}
        filter={filter}
        query={query}
        layout={library.layout}
        // With nothing hidden there is nothing to inspect; give the empty
        // state the full width instead of an empty panel.
        showInspector={library.showInspector && library.hiddenCount > 0}
        activeAlbum={null}
        albums={library.albums}
        hiddenCount={library.hiddenCount}
        libraryStats={hiddenLibraryStats}
        onInspectItem={library.inspectItem}
        onToggleSelect={library.toggleSelection}
        onSelectRange={selectRange}
        onSetSelection={library.setSelectedIds}
        onToggleSelectAll={toggleSelectAll}
        onClearSelection={library.clearSelection}
        onChangeFilter={library.setHiddenFilter}
        onChangeQuery={library.setHiddenQuery}
        onChangeLayout={library.setLayout}
        onToggleInspector={library.toggleInspector}
        onSetActiveAlbum={library.setActiveAlbum}
        onOpenAlbums={() => props.onNavigate("Albums")}
        onOpenAlbumPicker={props.onOpenAlbumPicker}
        onToggleFavorite={library.toggleFavorite}
        onToggleHidden={library.toggleHidden}
        onSetFavoriteForIds={library.setFavoriteForIds}
        onSetHiddenForIds={library.setHiddenForIds}
        onSetRatingForIds={library.setRatingForIds}
        onSetColorLabelForIds={library.setColorLabelForIds}
        minRating={library.minRating}
        colorLabelFilter={library.colorLabelFilter}
        dateFrom={library.dateFrom}
        dateTo={library.dateTo}
        onSetMinRating={library.setMinRating}
        onSetColorLabelFilter={library.setColorLabelFilter}
        onSetDateRange={library.setDateRange}
        onUpdateTags={library.updateItemTags}
        onDeleteItems={library.deleteItems}
        onRequestDeleteItems={props.onRequestDeleteItems}
        onOpenViewer={requestViewer}
        onPlayBackground={props.onPlayBackground ? requestBackground : undefined}
        onOpenEdit={requestEdit}
        onPlaySlideshow={requestSlideshow}
        onCreateAlbum={props.onCreateAlbum}
        searchInputRef={props.searchInputRef}
        onContextMenu={props.onContextMenu}
        busy={library.busy}
        progress={library.progress}
        notice={library.showNotice}
        assetUrl={props.assetUrl}
        onBrowseLibrary={() => props.onNavigate("Library")}
      />

      {pendingReveal && (
        <div className="dialog-backdrop" onClick={() => setPendingReveal(null)}>
          <div
            ref={revealDialogRef}
            className="album-dialog confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hidden-reveal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">HIDDEN ITEM</p>
                <h2 id="hidden-reveal-title">{revealCopy.title}</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                onClick={() => setPendingReveal(null)}
                aria-label="Cancel"
              >
                ×
              </button>
            </div>
            <p className="dialog-body">{revealCopy.body}</p>
            <div className="dialog-actions">
              <button className="quiet-button" type="button" onClick={() => setPendingReveal(null)}>
                Cancel
              </button>
              <button className="primary-button" type="button" onClick={confirmReveal}>
                {revealCopy.action}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default HiddenScreen;
