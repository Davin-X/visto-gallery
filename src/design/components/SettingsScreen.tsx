import React, { useRef, useState, useCallback } from "react";
import {
  useSettingsStore,
  useAppearance,
  useAccentColor,
  useSidebarWidth,
  useDefaultLayout,
  useLibraryStore,
  useSystemDark,
  ACCENT_PALETTE,
} from "../../engine/stores";
import { TypedConfirmDialog } from "./TypedConfirmDialog";
import { tauri } from "../../engine/commands/tauri";
import type { LibraryFolder } from "../../engine/types/commands";
import { useRestoreBackup } from "./settings/useRestoreBackup";
import { GeneralPanel } from "./settings/GeneralPanel";
import { ViewingPanel } from "./settings/ViewingPanel";
import { LibraryPanel } from "./settings/LibraryPanel";
import { PrivacyPanel } from "./settings/PrivacyPanel";
import { AdvancedPanel } from "./settings/AdvancedPanel";
import { DefaultAppsSection } from "./settings/DefaultAppsSection";
import { GearIcon, EyeIcon, FolderIcon, ShieldIcon, CpuIcon } from "./icons";

export type SettingsTab = "general" | "viewing" | "library" | "privacy" | "advanced";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <GearIcon size={15} /> },
  { id: "viewing", label: "Viewing", icon: <EyeIcon size={15} /> },
  { id: "library", label: "Library", icon: <FolderIcon size={15} /> },
  { id: "advanced", label: "Advanced", icon: <CpuIcon size={15} /> },
  { id: "privacy", label: "Privacy", icon: <ShieldIcon size={15} /> },
];

export function SettingsScreen(props: {
  onAddFolder?: () => void;
  onAddSourcePath?: (path: string) => Promise<void> | void;
  onRemoveFolder?: (folder: LibraryFolder) => void;
  onRescan?: () => void;
  onRescanFolder?: (folder: LibraryFolder) => void;
  onRemoveAllSources?: () => void;
  /** Which tab to open on. Set when the screen is opened from the Sources
   *  shortcut; remounting is enough, so the shard only seeds the initial tab. */
  initialTab?: SettingsTab;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(props.initialTab ?? "general");
  const sidebarWidth = useSidebarWidth();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingLibrary, setDeletingLibrary] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [vacuuming, setVacuuming] = useState(false);
  const [suggestedOldRoot, setSuggestedOldRoot] = useState<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restore = useRestoreBackup({
    onBusyChange: setBackupBusy,
    onRestored: (result) => setSuggestedOldRoot(result.missingRoots[0] ?? null),
  });

  // Settings values
  const appearance = useAppearance();
  const accentColor = useAccentColor();
  // Which accent variant (light/dark) is live, so the swatches preview the
  // color that will actually be applied.
  const systemDark = useSystemDark();
  const isDark = appearance === "dark" || (appearance === "system" && systemDark);
  const defaultLayout = useDefaultLayout();
  const autoImport = useSettingsStore((s) => s.autoImport);
  const animateTransitions = useSettingsStore((s) => s.animateTransitions);
  const showExtensions = useSettingsStore((s) => s.showExtensions);
  const openLastFolder = useSettingsStore((s) => s.openLastFolder);
  const restoreWindow = useSettingsStore((s) => s.restoreWindowState);
  const startupView = useSettingsStore((s) => s.startupView);
  const thumbnailSize = useSettingsStore((s) => s.thumbnailSize);
  const slideshowInterval = useSettingsStore((s) => s.slideshowInterval);
  const slideshowShuffle = useSettingsStore((s) => s.slideshowShuffle);
  const slideshowLoop = useSettingsStore((s) => s.slideshowLoop);
  const slideshowBackgroundAudio = useSettingsStore((s) => s.slideshowBackgroundAudio);
  const slideshowBackgroundAudioPath = useSettingsStore((s) => s.slideshowBackgroundAudioPath);
  const videoAutoPlay = useSettingsStore((s) => s.videoAutoPlay);
  const videoLoop = useSettingsStore((s) => s.videoLoop);
  const maxCacheSize = useSettingsStore((s) => s.maxCacheSizeGB);
  const thumbnailQuality = useSettingsStore((s) => s.thumbnailQuality);
  const debugLogging = useSettingsStore((s) => s.enableDebugLogging);
  const showNativeWarnings = useSettingsStore((s) => s.showNativeLimitWarnings);
  const checkForUpdatesOnLaunch = useSettingsStore((s) => s.checkForUpdatesOnLaunch);
  const requireHiddenUnlock = useSettingsStore((s) => s.requireHiddenUnlock);
  const hiddenAutoLockMinutes = useSettingsStore((s) => s.hiddenAutoLockMinutes);
  const lockHiddenInBackground = useSettingsStore((s) => s.lockHiddenInBackground);

  const update = useSettingsStore((s) => s.update);
  const resetSettings = useSettingsStore((s) => s.reset);
  const loadLibrary = useLibraryStore((s) => s.loadLibrary);
  const showNotice = useLibraryStore((s) => s.showNotice);
  const showErrorNotice = useLibraryStore((s) => s.showErrorNotice);

  // Settings hydration and theme application are owned by App.tsx, which is
  // always mounted; Settings only reads and writes.

  const handleSidebarWidthChange = (width: number) => {
    update("sidebarWidth", width);
  };

  const pickAmbientAudio = useCallback(async () => {
    try {
      const path = await tauri.library.pickAmbientAudio();
      if (!path) return;
      // Save the path first: if this fails we never flip the toggle on, so the
      // show can't be left enabled with no track.
      await update("slideshowBackgroundAudioPath", path);
      await update("slideshowBackgroundAudio", true);
    } catch (error) {
      showErrorNotice(error, "Could not pick an ambient audio track");
    }
  }, [update, showErrorNotice]);

  const clearAmbientAudio = useCallback(async () => {
    try {
      await update("slideshowBackgroundAudio", false);
      await update("slideshowBackgroundAudioPath", null);
    } catch (error) {
      showErrorNotice(error, "Could not clear the ambient audio track");
    }
  }, [update, showErrorNotice]);

  const handleResetSettings = useCallback(async () => {
    setShowResetConfirm(false);
    await resetSettings();
  }, [resetSettings]);

  const handleDeleteLibrary = useCallback(async () => {
    setShowDeleteConfirm(false);
    setDeletingLibrary(true);
    try {
      await tauri.library.deleteDatabase();
      await loadLibrary();
      showNotice("Library reset. Your files on disk were not touched.");
    } catch (e) {
      showErrorNotice(e, "Could not delete the library database");
    } finally {
      setDeletingLibrary(false);
    }
  }, [loadLibrary, showErrorNotice, showNotice]);

  // Re-scan every registered source through the existing scan path.
  const handleRebuildLibrary = useCallback(async () => {
    setRebuilding(true);
    try {
      const folders = await tauri.library.getFolders();
      if (!folders.length) {
        showNotice("No library folders to rebuild.");
        return;
      }
      for (const folder of folders) {
        await tauri.library.scan(folder.path, true);
      }
      await loadLibrary();
      showNotice(`Rebuilt ${folders.length} folder${folders.length === 1 ? "" : "s"}.`);
    } catch (e) {
      showErrorNotice(e, "Rebuild failed");
    } finally {
      setRebuilding(false);
    }
  }, [loadLibrary, showErrorNotice, showNotice]);

  const handleCreateBackup = useCallback(async () => {
    try {
      const destination = await tauri.backup.chooseDestination(
        `VistoGallery-Catalog-${new Date().toISOString().slice(0, 10)}.db`,
      );
      if (!destination) return;
      setBackupBusy(true);
      const info = await tauri.backup.create(destination);
      showNotice(
        `Catalog backup saved (${info.itemCount.toLocaleString()} items, ${info.albumCount.toLocaleString()} albums). Original media files were not touched.`,
      );
    } catch (error) {
      showErrorNotice(error, "Could not create the catalog backup");
    } finally {
      setBackupBusy(false);
    }
  }, [showErrorNotice, showNotice]);

  const handleVacuumCatalog = useCallback(async () => {
    try {
      setVacuuming(true);
      await tauri.edit.vacuumCatalog();
      showNotice("Catalog vacuumed — disk space reclaimed.");
    } catch (error) {
      showErrorNotice(error, "Vacuum failed");
    } finally {
      setVacuuming(false);
    }
  }, [showErrorNotice, showNotice]);

  // Standard ARIA tabs keyboard model: arrows cycle, Home/End jump.
  const handleTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = TABS.length - 1;
    let next = index;
    switch (event.key) {
      case "ArrowRight":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    setActiveTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  const renderRadioGroup = (
    name: string,
    value: string,
    options: readonly { id: string; label: string }[],
    onChange: (v: string) => void,
  ) => (
    <div className="radio-group" role="radiogroup" aria-label={name}>
      {options.map((opt) => (
        <label key={opt.id} className="radio-option">
          <input
            type="radio"
            name={name}
            value={opt.id}
            checked={value === opt.id}
            onChange={() => onChange(opt.id)}
          />
          <span className="radio-dot" />
          <span className="radio-label">{opt.label}</span>
        </label>
      ))}
    </div>
  );

  const renderAccentPicker = (value: string, onChange: (v: string) => void) => (
    <div
      className="accent-picker"
      role="radiogroup"
      aria-label="Accent color"
      onKeyDown={(event) => {
        const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
        if (!keys.includes(event.key)) return;
        const current = ACCENT_PALETTE.findIndex((c) => c.id === value);
        if (current < 0) return;
        const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
        const next = (current + direction + ACCENT_PALETTE.length) % ACCENT_PALETTE.length;
        event.preventDefault();
        onChange(ACCENT_PALETTE[next].id);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
      }}
    >
      {ACCENT_PALETTE.map((c) => {
        const selected = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`accent-option ${selected ? "selected" : ""}`}
            onClick={() => onChange(c.id)}
            aria-label={c.label}
            title={c.label}
          >
            <span
              className="accent-swatch"
              style={{ background: isDark ? c.dark : c.light }}
              aria-hidden="true"
            />
            <span className="accent-name">{c.label}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
        </div>
      </div>

      {/* Tabs */}
      <div className="settings-tabs" role="tablist" aria-label="Settings categories">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={activeTab === tab.id ? `panel-${tab.id}` : undefined}
            id={`tab-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={`settings-tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            <span className="settings-tab-icon">{tab.icon}</span>
            <span className="settings-tab-label">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Panels */}
      <div
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
        className="settings-panel"
      >
        {activeTab === "general" && (
          <GeneralPanel
            appearance={appearance}
            accentColor={accentColor}
            sidebarWidth={sidebarWidth}
            animateTransitions={animateTransitions}
            showExtensions={showExtensions}
            startupView={startupView}
            openLastFolder={openLastFolder}
            restoreWindow={restoreWindow}
            onChange={update}
            onSidebarWidthChange={handleSidebarWidthChange}
            renderRadioGroup={renderRadioGroup}
            renderAccentPicker={renderAccentPicker}
          />
        )}
        {activeTab === "general" && <DefaultAppsSection showNotice={showNotice} />}
        {activeTab === "viewing" && (
          <ViewingPanel
            defaultLayout={defaultLayout}
            thumbnailSize={thumbnailSize}
            slideshowInterval={slideshowInterval}
            slideshowShuffle={slideshowShuffle}
            slideshowLoop={slideshowLoop}
            slideshowBackgroundAudio={slideshowBackgroundAudio}
            slideshowBackgroundAudioPath={slideshowBackgroundAudioPath}
            videoAutoPlay={videoAutoPlay}
            videoLoop={videoLoop}
            onChange={update}
            onPickAmbientAudio={pickAmbientAudio}
            onClearAmbientAudio={clearAmbientAudio}
            renderRadioGroup={renderRadioGroup}
          />
        )}
        {activeTab === "library" && (
          <LibraryPanel
            autoImport={autoImport}
            onAddFolder={props.onAddFolder}
            onAddSourcePath={props.onAddSourcePath}
            onRemoveFolder={props.onRemoveFolder}
            onRescan={props.onRescan}
            onRescanFolder={props.onRescanFolder}
            onRemoveAllSources={props.onRemoveAllSources}
            onRestoreBackup={restore.chooseRestore}
            onChange={update}
          />
        )}
        {activeTab === "privacy" && (
          <PrivacyPanel
            checkForUpdatesOnLaunch={checkForUpdatesOnLaunch}
            requireHiddenUnlock={requireHiddenUnlock}
            hiddenAutoLockMinutes={hiddenAutoLockMinutes}
            lockHiddenInBackground={lockHiddenInBackground}
            onChange={update}
            onChangeAutoLock={(minutes) => update("hiddenAutoLockMinutes", minutes)}
          />
        )}
        {activeTab === "advanced" && (
          <AdvancedPanel
            maxCacheSize={maxCacheSize}
            thumbnailQuality={thumbnailQuality}
            debugLogging={debugLogging}
            showNativeWarnings={showNativeWarnings}
            onChange={update}
            setShowResetConfirm={setShowResetConfirm}
            setShowDeleteConfirm={setShowDeleteConfirm}
            deleting={deletingLibrary}
            onRebuild={handleRebuildLibrary}
            rebuilding={rebuilding}
            onCreateBackup={handleCreateBackup}
            onChooseRestore={restore.chooseRestore}
            backupBusy={backupBusy}
            restoring={restore.restoring}
            vacuuming={vacuuming}
            onVacuumCatalog={handleVacuumCatalog}
            suggestedOldRoot={suggestedOldRoot}
            onRootMappingApplied={loadLibrary}
            showNotice={showNotice}
          />
        )}
      </div>

      {/* Confirmation Dialogs */}
      {showResetConfirm && (
        <TypedConfirmDialog
          open
          eyebrow="RESET"
          title="Reset all settings?"
          description="Restores every preference to its default. Your library, albums and tags are not affected."
          requiredPhrase="RESET"
          confirmLabel="Reset"
          onClose={() => setShowResetConfirm(false)}
          onConfirm={handleResetSettings}
          titleId="settings-reset-title"
        />
      )}
      {restore.modal}
      {showDeleteConfirm && (
        <TypedConfirmDialog
          open
          eyebrow="RESET"
          title="Reset library?"
          description={
            <>
              This removes every item, album, tag and rating from VistoGallery.{" "}
              <b>Your files on disk are not touched.</b> Add your folders again to rebuild the
              library.
            </>
          }
          requiredPhrase="RESET"
          confirmLabel="Reset library"
          onClose={() => setShowDeleteConfirm(false)}
          onConfirm={handleDeleteLibrary}
          titleId="settings-delete-title"
        />
      )}
    </div>
  );
}
