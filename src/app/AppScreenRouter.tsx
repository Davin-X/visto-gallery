import type { MutableRefObject, RefObject } from "react";
import { open as openFileDialog, save } from "@tauri-apps/plugin-dialog";
import { tauri } from "../engine/commands/tauri";
import { clearEditDraft } from "../engine/stores";
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
import type { LibraryFolder, LibraryStats } from "../engine/types/commands";
import type { MediaItem } from "../engine/types/media";
import type { Screen } from "./screen";

interface AppScreenRouterProps {
  screen: Screen;
  screenHistory: Screen[];
  goBack: () => void;
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
  searchInputRef: RefObject<HTMLInputElement>;
  itemPendingDeleteRef: MutableRefObject<string[] | null>;
  setItemPendingDeleteCount: (count: number) => void;
  setFolderPendingRemove: (folder: LibraryFolder | null) => void;
  setRemoveAllSourcesDialogOpen: (open: boolean) => void;
  rescanSources: () => Promise<void>;
  rescanSource: (folder: LibraryFolder) => Promise<void>;
  importFiles: () => Promise<void>;
  importFolder: () => Promise<void>;
  showNotice: (text: string) => void;
  exportToBatch: () => void;
  addItemsToAlbum: (albumId: string) => Promise<void>;
  albumDragOver: boolean;
  libraryStats: LibraryStats;
  photoViewerItems: MediaItem[];
  playbackItem: MediaItem | null;
  videoQueue: MediaItem[];
  queueAutoPlayId: string | null;
  viewerOrigin: Screen;
  navigateViewer: (delta: number) => Promise<void>;
  selectViewerItem: (id: string) => void;
  selectVideoItem: (id: string) => void;
  playPreviousVideo: () => boolean;
  playNextVideo: () => Promise<boolean>;
  playSlideshow: (ids?: string[]) => void;
  openAlbumMenu: (album: any, e: React.MouseEvent) => void;
  openSmartAlbum: (albumId: string) => Promise<void>;
  openSmartAlbumMenu: (album: any, e: React.MouseEvent) => void;
  setAlbumRemovePending: (pending: { albumId: string; itemIds: string[] } | null) => void;
  copyTagsToFinderForIds: (ids: string[]) => Promise<void>;
}

export function AppScreenRouter({
  screen,
  screenHistory,
  goBack,
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
  exportToBatch,
  addItemsToAlbum,
  albumDragOver,
  libraryStats,
  photoViewerItems,
  playbackItem,
  videoQueue,
  queueAutoPlayId,
  viewerOrigin,
  navigateViewer,
  selectViewerItem,
  selectVideoItem,
  playPreviousVideo,
  playNextVideo,
  playSlideshow,
  openAlbumMenu,
  openSmartAlbum,
  openSmartAlbumMenu,
  setAlbumRemovePending,
  copyTagsToFinderForIds,
}: AppScreenRouterProps) {
  return (
    <main id="main-content" className="main-content" tabIndex={-1} style={{ position: "relative" }}>
      {screenHistory.length > 0 && (
        <button
          className="icon-button"
          type="button"
          aria-label="Go back"
          title="Go back"
          onClick={goBack}
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            zIndex: 5,
            width: 32,
            height: 32,
            padding: 0,
            borderRadius: 8,
            opacity: 0.8,
          }}
        >
          ←
        </button>
      )}
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
            await library.loadAlbumItems(albumId);
            setScreen("Library");
          }}
        />
      )}

      {screen === "Viewer" && (
        <ViewerScreen
          active
          items={photoViewerItems}
          selected={library.viewerSelected?.kind === "video" ? null : library.viewerSelected}
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
          onClose={viewer.close}
          onToggleFavorite={library.toggleFavorite}
          onToggleHidden={library.toggleHidden}
          onOpenEdit={async (item: MediaItem) => {
            await edit.saveDraft();
            await edit.open(item);
            setScreen("Edit");
          }}
          onContextMenu={openContextMenu}
          assetUrl={assetUrl}
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
          onClose={edit.close}
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
                const suggestedName = String(item.name).replace(/\.[^.]+$/, "") + "_edited.jpg";
                const finalPath = await save({
                  defaultPath: suggestedName,
                  filters: [{ name: "JPEG image", extensions: ["jpg", "jpeg"] }],
                });
                if (!finalPath) {
                  showNotice("Export cancelled");
                  return;
                }
                // Move temp file to final destination
                await tauri.editing.moveExportedFile(result.outputPath, finalPath);
              }

              clearEditDraft(item.id);
              if (inPlace) await library.loadLibrary();
              showNotice(inPlace ? "Replaced original" : "Exported edited copy");
            } catch (e) {
              if (String(e).includes("cancelled")) {
                showNotice("Export cancelled");
              } else {
                showNotice("Export failed: " + String(e));
              }
            }
          }}
          onClearDraft={edit.clearDraft}
          onNotice={showNotice}
          assetUrl={assetUrl}
          items={library.items.filter((i: any) => i.kind === "photo" && !i.hidden)}
          onOpenEdit={async (item: any) => {
            await edit.saveDraft();
            await edit.open(item);
          }}
        />
      )}

      {screen === "Batch" && (
        <BatchScreen
          items={library.items.filter((i: any) => library.selectedIds.includes(i.id))}
          selectedIds={library.selectedIds}
          config={batch}
          state={batch}
          onSetPattern={batch.setPattern}
          onSetFormat={batch.setFormat}
          onSetQuality={batch.setQuality}
          onSetStripMetadata={batch.setStripMetadata}
          onSetMaxDimension={batch.setMaxDimension}
          onSetStep={batch.setStep}
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
          busy={batch.busy}
          cancelRequested={batch.cancelRequested}
          progress={batch.progress}
          result={batch.result}
          error={batch.error}
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
        />
      )}

      {screen === "Duplicates" && (
        <DuplicatesScreen
          groups={library.duplicates}
          items={library.items}
          onScan={library.scanDuplicates}
          onClear={library.clearDuplicates}
          busy={library.busy}
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
