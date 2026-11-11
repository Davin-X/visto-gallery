import type { MutableRefObject, RefObject } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { tauri } from "../engine/commands/tauri";
import { clearEditDraft } from "../engine/stores";
import { useLibraryStore } from "../engine/stores/useLibraryStore";
import { errorCode } from "../engine/types/errors";
import { invalidateThumbnailCache } from "../design/components/CachedThumbnail";
import HiddenScreen from "../screens/HiddenScreen";
import LibraryScreen from "../screens/LibraryScreen";
import EditScreen from "../screens/EditScreen";
import ViewerScreen from "../screens/ViewerScreen";
import VideoPlayerScreen from "../screens/VideoPlayerScreen";
import CameraLensBrowserScreen from "../screens/CameraLensBrowserScreen";
import BatchScreen from "../screens/BatchScreen";
import AlbumsScreen from "../screens/AlbumsScreen";
import DuplicatesScreen from "../screens/DuplicatesScreen";
import { SettingsScreen } from "../design/components/SettingsScreen";
import type { LibraryFolder, LibraryStats, ErrorCode } from "../engine/types/commands";
import type { MediaItem } from "../engine/types/media";
import type { Screen } from "./screen";
import { buildItemContextMenu, type ItemMenuActions } from "../engine/utils/itemContextMenu";

interface AppScreenRouterProps {
  screen: Screen;
  library: any;
  viewer: any;
  edit: any;
  batch: any;
  assetUrl: (path: string) => string;
  setScreen: (screen: Screen) => void;
  openViewer: (id?: string, origin?: Screen, scope?: "library" | "hidden") => void;
  openScreen: (screen: Screen) => void;
  openAlbumDialog: (seedIds?: string[]) => void;
  openAlbumPicker: (itemIds?: string[]) => void;
  openContextMenu: (items: any[], e: React.MouseEvent) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  itemPendingDeleteRef: MutableRefObject<string[] | null>;
  setItemPendingDeleteCount: (count: number) => void;
  setFolderPendingRemove: (folder: LibraryFolder | null) => void;
  setRemoveAllSourcesDialogOpen: (open: boolean) => void;
  rescanSources: () => Promise<void>;
  rescanSource: (folder: LibraryFolder) => Promise<void>;
  importFiles: () => Promise<void>;
  importFolder: () => Promise<void>;
  showNotice: (text: string, code?: ErrorCode) => void;
  showErrorNotice: (error: unknown, prefix?: string) => void;
  exportToBatch: () => void;
  addItemsToAlbum: (albumId: string) => Promise<void>;
  albumDragOver: boolean;
  libraryStats: LibraryStats;
  photoViewerItems: MediaItem[];
  photoViewerHasMore: boolean;
  photoViewerLoadingMore: boolean;
  onLoadMorePhotos: () => unknown;
  playbackItem: MediaItem | null;
  videoQueue: MediaItem[];
  queueAutoPlayId: string | null;
  viewerOrigin: Screen;
  navigateViewer: (delta: number) => Promise<void>;
  selectViewerItem: (id: string) => void;
  selectVideoItem: (id: string) => void;
  playPreviousVideo: () => boolean;
  playNextVideo: () => Promise<boolean>;
  queueHasMore: boolean;
  onLoadMoreQueue: () => unknown;
  playSlideshow: (ids?: string[]) => void;
  openAlbumMenu: (album: any, e: React.MouseEvent) => void;
  openSmartAlbum: (albumId: string) => Promise<void>;
  openSmartAlbumMenu: (album: any, e: React.MouseEvent) => void;
  setAlbumRemovePending: (pending: { albumId: string; itemIds: string[] } | null) => void;
  copyTagsToFinderForIds: (ids: string[]) => Promise<void>;
  playVideoInBackground: (id?: string, scope?: "library" | "hidden") => void;
}

export function AppScreenRouter({
  screen,
  library,
  viewer,
  edit,
  batch,
  assetUrl,
  setScreen,
  openViewer,
  openScreen,
  openAlbumDialog,
  openAlbumPicker,
  openContextMenu,
  searchInputRef,
  itemPendingDeleteRef,
  setItemPendingDeleteCount,
  setFolderPendingRemove,
  setRemoveAllSourcesDialogOpen,
  rescanSources,
  rescanSource,
  importFiles,
  importFolder,
  showNotice,
  showErrorNotice,
  exportToBatch,
  addItemsToAlbum,
  albumDragOver,
  libraryStats,
  photoViewerItems,
  photoViewerHasMore,
  photoViewerLoadingMore,
  onLoadMorePhotos,
  playbackItem,
  videoQueue,
  queueAutoPlayId,
  viewerOrigin,
  navigateViewer,
  selectViewerItem,
  selectVideoItem,
  playPreviousVideo,
  playNextVideo,
  queueHasMore,
  onLoadMoreQueue,
  playSlideshow,
  openAlbumMenu,
  openSmartAlbum,
  openSmartAlbumMenu,
  setAlbumRemovePending,
  copyTagsToFinderForIds,
  playVideoInBackground,
}: AppScreenRouterProps) {
  const openViewerEdit = async (item: MediaItem) => {
    await edit.saveDraft();
    await edit.open(item);
    setScreen("Edit");
  };
  // The viewer and the video player share the grid's item menu, so star
  // ratings, colour labels, album membership and delete work without extra
  // buttons on either screen.
  const itemMenuActions: ItemMenuActions = {
    onEdit: (item) => void openViewerEdit(item),
    onCopyTagsToFinder: copyTagsToFinderForIds,
    onOpenAlbumPicker: (ids) => openAlbumPicker(ids),
    onCreateAlbum: (ids) => openAlbumDialog(ids),
    activeAlbum: library.activeAlbum,
    onRequestRemoveFromAlbum: (albumId, ids) => setAlbumRemovePending({ albumId, itemIds: ids }),
    onToggleFavorite: library.toggleFavorite,
    onSetRating: library.setRatingForIds,
    onSetColorLabel: library.setColorLabelForIds,
    onToggleHidden: library.toggleHidden,
    onRequestDelete: (ids) => {
      itemPendingDeleteRef.current = ids;
      setItemPendingDeleteCount(ids.length);
    },
  };
  return (
    <main id="main-content" className="main-content" tabIndex={-1} style={{ position: "relative" }}>
      {screen === "Library" && (
        <LibraryScreen
          items={library.visibleItems}
          hasItems={library.items.length > 0}
          inspectedId={library.inspectedId}
          selectedIds={library.selectedIds}
          filter={library.filter}
          query={library.query}
          layout={library.layout}
          showInspector={library.showInspector}
          activeAlbum={library.activeAlbum}
          albums={library.albums}
          onInspectItem={library.inspectItem}
          onToggleSelect={library.toggleSelection}
          onSelectRange={library.selectRange}
          onSetSelection={library.setSelectedIds}
          onToggleSelectAll={library.toggleSelectAll}
          onClearSelection={library.clearSelection}
          onOpenBatch={() => exportToBatch()}
          onChangeFilter={library.setFilter}
          onChangeQuery={library.setQuery}
          onChangeLayout={library.setLayout}
          onToggleInspector={library.toggleInspector}
          onSetActiveAlbum={library.setActiveAlbum}
          onOpenAlbums={() => openScreen("Albums")}
          onAddItems={(albumId: string) => addItemsToAlbum(albumId)}
          onOpenAlbumPicker={(itemIds?: string[]) => openAlbumPicker(itemIds)}
          onAlbumMenu={(e: React.MouseEvent) => {
            const album = library.albums.find((a: any) => a.id === library.activeAlbum);
            if (album) openAlbumMenu(album, e);
          }}
          albumDragOver={albumDragOver}
          onToggleFavorite={library.toggleFavorite}
          onToggleHidden={library.toggleHidden}
          onSetFavoriteForIds={library.setFavoriteForIds}
          onSetHiddenForIds={library.setHiddenForIds}
          onSetRatingForIds={library.setRatingForIds}
          onSetColorLabelForIds={library.setColorLabelForIds}
          minRating={library.minRating}
          libraryStats={libraryStats}
          colorLabelFilter={library.colorLabelFilter}
          dateFrom={library.dateFrom}
          dateTo={library.dateTo}
          onSetMinRating={library.setMinRating}
          onSetColorLabelFilter={library.setColorLabelFilter}
          onSetDateRange={library.setDateRange}
          onCreateSmartAlbum={(name: string) => void library.createSmartAlbum(name)}
          onCopyTagsToFinder={copyTagsToFinderForIds}
          onUpdateTags={library.updateItemTags}
          onDeleteItems={library.deleteItems}
          onRequestDeleteItems={(ids: string[]) => {
            itemPendingDeleteRef.current = ids;
            setItemPendingDeleteCount(ids.length);
          }}
          onRequestRemoveFromAlbum={(albumId: string, itemIds: string[]) =>
            setAlbumRemovePending({ albumId, itemIds })
          }
          onOpenViewer={(id?: string) => openViewer(id, "Library")}
          onPlayBackground={(id: string) => playVideoInBackground(id, "library")}
          onOpenEdit={async (item: any) => {
            if (item?.kind === "video") {
              openViewer(item.id, "Library");
              return;
            }
            await edit.saveDraft();
            await edit.open(item);
            setScreen("Edit");
          }}
          onImportFolder={() => importFolder()}
          onImportFiles={() => importFiles()}
          onPlaySlideshow={playSlideshow}
          onCreateAlbum={openAlbumDialog}
          searchInputRef={searchInputRef}
          onContextMenu={openContextMenu}
          busy={library.busy}
          progress={library.progress}
          notice={showNotice}
          assetUrl={assetUrl}
          hiddenCount={library.hiddenCount}
        />
      )}

      {screen === "Albums" && (
        <AlbumsScreen
          albums={library.albums}
          items={library.items}
          smartAlbums={library.smartAlbums}
          assetUrl={assetUrl}
          onCreateAlbum={openAlbumDialog}
          onAlbumContextMenu={openAlbumMenu}
          onSmartAlbumContextMenu={openSmartAlbumMenu}
          onOpenSmartAlbum={(albumId: string) => void openSmartAlbum(albumId)}
          onOpenAlbum={async (albumId: string) => {
            library.setActiveAlbum(albumId);
            library.setFilter("All");
            library.setQuery("");
            // Navigate immediately; the album grid loads from the same active
            // album filter. Cover loading must never block opening the album.
            setScreen("Library");
            try {
              await library.loadAlbumItems(albumId);
            } catch (error) {
              showErrorNotice(error, "Could not load album items");
            }
          }}
        />
      )}

      {screen === "Viewer" && (
        <ViewerScreen
          active
          items={photoViewerItems}
          selected={library.viewerSelected}
          zoom={viewer.zoom}
          fitMode={viewer.fitMode}
          rotation={viewer.rotation}
          flipX={viewer.flipX}
          onNavigate={navigateViewer}
          onSetPhoto={selectViewerItem}
          onSetZoom={viewer.setZoom}
          onZoomIn={viewer.zoomIn}
          onZoomOut={viewer.zoomOut}
          onResetZoom={viewer.resetZoom}
          onToggleFitMode={viewer.toggleFitMode}
          onRotate={viewer.rotate}
          onToggleFlip={viewer.toggleFlip}
          onResetTransform={viewer.resetTransform}
          onToggleFullscreen={viewer.toggleFullscreen}
          onClose={() => {
            viewer.close();
            // Never return to the viewer itself: a close action that leaves
            // `screen === "Viewer"` would be re-opened by the sync effect in App.
            setScreen(viewerOrigin === "Viewer" ? "Library" : viewerOrigin || "Library");
          }}
          onToggleFavorite={library.toggleFavorite}
          onToggleHidden={library.toggleHidden}
          onOpenEdit={openViewerEdit}
          onContextMenu={(items, event) => {
            const target = items[0];
            if (target) openContextMenu(buildItemContextMenu(target, itemMenuActions), event);
          }}
          assetUrl={assetUrl}
          hasMore={photoViewerHasMore}
          loadingMore={photoViewerLoadingMore}
          onLoadMore={onLoadMorePhotos}
        />
      )}

      <VideoPlayerScreen
        active={screen === "Video"}
        item={playbackItem}
        queue={videoQueue}
        queueAutoPlayItemId={queueAutoPlayId}
        assetUrl={assetUrl}
        onBack={() => setScreen(viewerOrigin || "Library")}
        onSelect={selectVideoItem}
        onPrevious={playPreviousVideo}
        onNext={playNextVideo}
        queueHasMore={queueHasMore}
        onLoadMoreQueue={onLoadMoreQueue}
        onContextMenu={(target, event) =>
          openContextMenu(buildItemContextMenu(target, itemMenuActions), event)
        }
      />

      {screen === "Edit" && (
        <EditScreen
          item={edit.item}
          values={edit.values}
          crop={edit.crop}
          history={edit.history}
          historyIndex={edit.historyIndex}
          onSetValue={edit.setValue}
          onSetValues={edit.setValues}
          onReset={edit.reset}
          onAuto={edit.auto}
          onRotate={edit.rotate}
          onFlip={edit.flip}
          onSetCrop={edit.setCrop}
          onResetCrop={edit.resetCrop}
          onUndo={edit.undo}
          onRedo={edit.redo}
          canUndo={edit.canUndo}
          canRedo={edit.canRedo}
          onClose={async () => {
            await edit.close();
            setScreen("Library");
          }}
          onSaveDraft={edit.saveDraft}
          onBack={() => setScreen("Library")}
          onExport={async (inPlace = false) => {
            const item = edit.item;
            if (!item) return;
            const sourceExtension = String(
              item.extension || item.name.split(".").pop() || "",
            ).toLowerCase();
            if (inPlace) {
              if (!["jpg", "jpeg", "png", "webp"].includes(sourceExtension)) {
                showNotice("Replace original supports JPEG, PNG, and WebP. Save a copy instead.");
                return;
              }
            }
            try {
              const v = edit.values || {};
              const crop = edit.crop || {
                enabled: false,
                x: 0,
                y: 0,
                width: 1,
                height: 1,
              };

              // Build render request for native backend
              const request = {
                sourcePath: item.path,
                mediaId: item.id,
                edits: v,
                outputFormat: (inPlace ? "in_place" : "image/jpeg") as
                  "jpeg" | "png" | "webp" | "heic" | "avif" | "in_place",
                quality: 0.92,
                stripMetadata: false,
                crop: crop.enabled ? crop : undefined,
              };

              const result = await tauri.editing.render(request);

              if (!inPlace) {
                // For save-copy, backend wrote to temp; now show save dialog
                const extension = result.outputPath.split(".").pop() ?? "jpg";
                const suggestedName =
                  String(item.name).replace(/\.[^.]+$/, "") + `_edited.${extension}`;
                // The backend opens the save dialog and moves the staged file,
                // so the webview never names a source or destination path.
                const finalPath = await tauri.editing.saveExportedFile(
                  result.outputPath,
                  suggestedName,
                );
                if (!finalPath) {
                  showNotice("Export cancelled");
                  return;
                }
              }

              if (inPlace) {
                invalidateThumbnailCache(item.id);
                // Replace bakes current edits into the file bytes. Clear the
                // draft and reopen neutral against the refreshed item so the
                // preview shows the newly baked file without double-applying
                // adjustment filters (which can look like the edit reverted).
                await edit.clearDraft();
                await library.loadLibrary();
                const fresh =
                  useLibraryStore.getState().items.find((i: any) => i.id === item.id) ??
                  ({
                    ...item,
                    modifiedAt: Date.now(),
                  } as any);
                await edit.open(fresh);
              } else {
                clearEditDraft(item.id);
              }
              showNotice(
                inPlace
                  ? "Replaced original file — preview shows the saved edit"
                  : "Exported edited copy",
              );
            } catch (e) {
              if (errorCode(e) === "cancelled") {
                showNotice("Export cancelled");
              } else {
                showErrorNotice(e, "Export failed");
              }
            }
          }}
          onClearDraft={edit.clearDraft}
          onNotice={showNotice}
          onReloadLibrary={library.loadLibrary}
          assetUrl={assetUrl}
          items={library.items.filter((i: any) => i.kind === "photo" && !i.hidden)}
          onOpenEdit={async (item: any) => {
            await edit.saveDraft();
            // Prefer freshest library metadata (size/modifiedAt) after file ops.
            const fresh =
              useLibraryStore.getState().items.find((i: any) => i.id === item.id) ?? item;
            await edit.open(fresh);
          }}
        />
      )}

      {screen === "Batch" && (
        <BatchScreen
          items={library.items.filter((i: any) => library.selectedIds.includes(i.id))}
          selectedIds={library.selectedIds}
          state={batch}
          onSetPattern={batch.setPattern}
          onSetFormat={batch.setFormat}
          onSetQuality={batch.setQuality}
          onSetStripMetadata={batch.setStripMetadata}
          onSetMaxDimension={batch.setMaxDimension}
          onChooseFolder={async () => {
            const folder = await openFileDialog({
              directory: true,
              multiple: false,
              title: "Choose export folder",
            });
            if (typeof folder === "string") batch.setOutputFolder(folder);
          }}
          onOpenFolder={() => {
            if (batch.outputFolder) tauri.items.openFolder(batch.outputFolder);
          }}
          onExportBatch={batch.exportBatch}
          onCancelBatch={batch.cancelBatch}
          onReset={batch.reset}
          onOpenLibrary={() => setScreen("Library")}
          onClearSelection={library.clearSelection}
          onSelectAll={library.selectAll}
          onSetSelection={library.setSelectedIds}
          onRemoveItem={library.toggleSelection}
          assetUrl={assetUrl}
        />
      )}

      {screen === "CameraLens" && (
        <CameraLensBrowserScreen
          items={library.items}
          assetUrl={assetUrl}
          onBack={() => setScreen("Library")}
          onOpenViewer={(id?: string) => openViewer(id, "Library")}
        />
      )}

      {screen === "Hidden" && (
        <HiddenScreen
          assetUrl={assetUrl}
          searchInputRef={searchInputRef}
          onContextMenu={openContextMenu}
          onNavigate={openScreen}
          onCreateAlbum={openAlbumDialog}
          onOpenAlbumPicker={(itemIds?: string[]) => openAlbumPicker(itemIds)}
          onRequestDeleteItems={(ids: string[]) => {
            itemPendingDeleteRef.current = ids;
            setItemPendingDeleteCount(ids.length);
          }}
          onOpenEdit={async (item: any) => {
            if (item?.kind === "video") {
              openViewer(item.id, "Hidden", "hidden");
              return;
            }
            await edit.saveDraft();
            await edit.open(item);
            setScreen("Edit");
          }}
          onOpenViewer={(id?: string) => openViewer(id, "Hidden", "hidden")}
          onPlayBackground={(id: string) => playVideoInBackground(id, "hidden")}
        />
      )}

      {screen === "Duplicates" && (
        <DuplicatesScreen
          groups={library.duplicates}
          scanned={library.duplicatesScanned}
          items={library.items}
          onScan={library.scanDuplicates}
          onClear={library.clearDuplicates}
          busy={library.busy}
          progress={library.progress ?? null}
          assetUrl={assetUrl}
          onRequestDeleteItems={(ids: string[]) => {
            itemPendingDeleteRef.current = ids;
            setItemPendingDeleteCount(ids.length);
          }}
          onHideIds={async (ids: string[]) => {
            if (!ids.length) return;
            library.showNotice(`Hiding ${ids.length.toLocaleString()} item(s)…`);
            await library.setHiddenForIds(ids, true);
            library.showNotice(`Hidden ${ids.length.toLocaleString()} item(s).`);
            await library.scanDuplicates();
          }}
          onOpenItem={(id: string) => openViewer(id, "Duplicates")}
        />
      )}

      {screen === "Settings" && (
        <SettingsScreen
          onAddFolder={() => importFolder()}
          onRemoveFolder={(folder: LibraryFolder) => setFolderPendingRemove(folder)}
          onRescan={() => {
            void rescanSources();
          }}
          onRescanFolder={(folder) => {
            void rescanSource(folder);
          }}
          onRemoveAllSources={() => setRemoveAllSourcesDialogOpen(true)}
        />
      )}
    </main>
  );
}
