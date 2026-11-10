import React, { useEffect, useRef, useState, useCallback } from "react";
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
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useKeyboard } from "../../engine/hooks/useKeyboard";
import { tauri } from "../../engine/commands/tauri";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import type { BackupInfo, LibraryFolder } from "../../engine/types/commands";
import { GeneralPanel } from "./settings/GeneralPanel";
import { ViewingPanel } from "./settings/ViewingPanel";
import { LibraryPanel } from "./settings/LibraryPanel";
import { PrivacyPanel } from "./settings/PrivacyPanel";
import { AdvancedPanel } from "./settings/AdvancedPanel";
import { GearIcon, EyeIcon, FolderIcon, ShieldIcon, CpuIcon } from "./icons";

type SettingsTab = "general" | "viewing" | "library" | "privacy" | "advanced";

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: "General", icon: <GearIcon size={15} /> },
  { id: "viewing", label: "Viewing", icon: <EyeIcon size={15} /> },
  { id: "library", label: "Library", icon: <FolderIcon size={15} /> },
  { id: "advanced", label: "Advanced", icon: <CpuIcon size={15} /> },
  { id: "privacy", label: "Privacy", icon: <ShieldIcon size={15} /> },
];

export function SettingsScreen(props: {
  onAddFolder?: () => void;
  onRemoveFolder?: (folder: LibraryFolder) => void;
  onRescan?: () => void;
  onRescanFolder?: (folder: LibraryFolder) => void;
  onRemoveAllSources?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const sidebarWidth = useSidebarWidth();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingLibrary, setDeletingLibrary] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [vacuuming, setVacuuming] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<{
    path: string;
    info: BackupInfo;
  } | null>(null);
  const [suggestedOldRoot, setSuggestedOldRoot] = useState<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const resetDialogRef = useRef<HTMLDivElement | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const restoreDialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(showResetConfirm, resetDialogRef);
  useFocusTrap(showDeleteConfirm, deleteDialogRef);
  useFocusTrap(!!pendingRestore, restoreDialogRef);

  // Escape cancels whichever confirm dialog is open (restore stays pinned
  // while a restore is in flight, matching its backdrop guard).
  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (showResetConfirm) {
          e.preventDefault();
          setShowResetConfirm(false);
        } else if (showDeleteConfirm) {
          e.preventDefault();
          setShowDeleteConfirm(false);
        } else if (pendingRestore && !restoring) {
          e.preventDefault();
          setPendingRestore(null);
        }
      },
      [showResetConfirm, showDeleteConfirm, pendingRestore, restoring],
    ),
  ]);

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
  const videoAutoPlay = useSettingsStore((s) => s.videoAutoPlay);
  const videoLoop = useSettingsStore((s) => s.videoLoop);
  const maxCacheSize = useSettingsStore((s) => s.maxCacheSizeGB);
  const thumbnailQuality = useSettingsStore((s) => s.thumbnailQuality);
  const debugLogging = useSettingsStore((s) => s.enableDebugLogging);
  const showNativeWarnings = useSettingsStore((s) => s.showNativeLimitWarnings);
  const checkForUpdatesOnLaunch = useSettingsStore((s) => s.checkForUpdatesOnLaunch);

  const update = useSettingsStore((s) => s.update);
  const updateMany = useSettingsStore((s) => s.updateMany);
  const resetSettings = useSettingsStore((s) => s.reset);
  const loadLibrary = useLibraryStore((s) => s.loadLibrary);
  const showNotice = useLibraryStore((s) => s.showNotice);
  const showErrorNotice = useLibraryStore((s) => s.showErrorNotice);

  // Settings hydration and theme application are owned by App.tsx, which is
  // always mounted; Settings only reads and writes.

  const handleSidebarWidthChange = (width: number) => {
    update("sidebarWidth", width);
  };

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
      showNotice("Library database deleted. Original files were left untouched.");
    } catch (e) {
      showErrorNotice(e, "Could not delete the library database");
    } finally {
      setDeletingLibrary(false);
    }
  }, [loadLibrary, showErrorNotice, showNotice]);

  // Re-scan every registered source through the existing scan path. There is no
  // thumbnail cache yet, so this is the honest replacement for "Clear Cache".
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
      const destination = await save({
        title: "Save VistoGallery catalog backup",
        defaultPath: `VistoGallery-Catalog-${new Date().toISOString().slice(0, 10)}.db`,
        filters: [{ name: "VistoGallery catalog backup", extensions: ["db"] }],
      });
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

  const handleChooseRestore = useCallback(async () => {
    try {
      const path = await openDialog({
        title: "Choose a VistoGallery catalog backup",
        multiple: false,
        filters: [{ name: "VistoGallery catalog backup", extensions: ["db"] }],
      });
      if (!path || Array.isArray(path)) return;
      setBackupBusy(true);
      const info = await tauri.backup.validate(path);
      setPendingRestore({ path, info });
    } catch (error) {
      showNotice(
        `That file is not a restorable VistoGallery backup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setBackupBusy(false);
    }
  }, [showNotice]);

  const handleConfirmRestore = useCallback(async () => {
    if (!pendingRestore) return;
    setRestoring(true);
    try {
      const result = await tauri.backup.restore(pendingRestore.path);
      setPendingRestore(null);
      setSuggestedOldRoot(result.missingRoots[0] ?? null);
      await loadLibrary();
      const missing = result.missingRoots.length
        ? ` Missing source folder(s): ${result.missingRoots.slice(0, 3).join(", ")}${result.missingRoots.length > 3 ? ", …" : ""}.`
        : "";
      showNotice(
        `Catalog restored (${result.backup.itemCount.toLocaleString()} items, ${result.backup.albumCount.toLocaleString()} albums). Pre-restore backup: ${result.preRestoreBackup}.${missing} Original media files were not modified.`,
      );
    } catch (error) {
      showErrorNotice(error, "Restore failed; the active catalog was left in place");
    } finally {
      setRestoring(false);
    }
  }, [loadLibrary, pendingRestore, showErrorNotice, showNotice]);

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
    options: { id: string; label: string }[],
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
          <p className="eyebrow">PREFERENCES</p>
          <h1>Settings</h1>
          <p className="page-subtitle">Customize VistoGallery to match your workflow.</p>
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
        {activeTab === "viewing" && (
          <ViewingPanel
            defaultLayout={defaultLayout}
            thumbnailSize={thumbnailSize}
            slideshowInterval={slideshowInterval}
            slideshowShuffle={slideshowShuffle}
            slideshowLoop={slideshowLoop}
            videoAutoPlay={videoAutoPlay}
            videoLoop={videoLoop}
            onChange={update}
            renderRadioGroup={renderRadioGroup}
          />
        )}
        {activeTab === "library" && (
          <LibraryPanel
            autoImport={autoImport}
            onAddFolder={props.onAddFolder}
            onRemoveFolder={props.onRemoveFolder}
            onRescan={props.onRescan}
            onRescanFolder={props.onRescanFolder}
            onRemoveAllSources={props.onRemoveAllSources}
            onChange={update}
          />
        )}
        {activeTab === "privacy" && (
          <PrivacyPanel checkForUpdatesOnLaunch={checkForUpdatesOnLaunch} onChange={update} />
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
            onChooseRestore={handleChooseRestore}
            backupBusy={backupBusy}
            restoring={restoring}
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
        <div className="dialog-backdrop" onClick={() => setShowResetConfirm(false)}>
          <div
            ref={resetDialogRef}
            className="album-dialog confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-reset-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">RESET</p>
                <h2 id="settings-reset-title">Reset All Settings?</h2>
              </div>
            </div>
            <p className="dialog-body">
              This will restore all preferences to their defaults. Your library, albums, and tags
              will not be affected.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setShowResetConfirm(false)}
              >
                Cancel
              </button>
              <button type="button" className="danger-button" onClick={handleResetSettings}>
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingRestore && (
        <div
          className="dialog-backdrop"
          onClick={() => {
            if (!restoring) setPendingRestore(null);
          }}
        >
          <div
            ref={restoreDialogRef}
            className="album-dialog delete-album-dialog confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-restore-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">RESTORE</p>
                <h2 id="settings-restore-title">Replace the Current Catalog?</h2>
              </div>
            </div>
            <p className="dialog-body">
              This backup contains <b>{pendingRestore.info.itemCount.toLocaleString()} items</b>,{" "}
              {pendingRestore.info.albumCount.toLocaleString()} albums, and{" "}
              {pendingRestore.info.tagCount.toLocaleString()} tags, created with app version{" "}
              {pendingRestore.info.appVersion}. Restoring replaces the current catalog organization.
              A pre-restore snapshot is written automatically, and{" "}
              <b>original media files are never modified</b>.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setPendingRestore(null)}
                disabled={restoring}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={handleConfirmRestore}
                disabled={restoring}
              >
                {restoring ? "Restoring…" : "Restore Catalog"}
              </button>
            </div>
          </div>
        </div>
      )}
      {showDeleteConfirm && (
        <div className="dialog-backdrop" onClick={() => setShowDeleteConfirm(false)}>
          <div
            ref={deleteDialogRef}
            className="album-dialog delete-album-dialog confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">DELETE</p>
                <h2 id="settings-delete-title">Delete Library Database?</h2>
              </div>
            </div>
            <p className="dialog-body">
              This removes the catalog, albums, tags, and all metadata.{" "}
              <b>Original files on disk are not affected.</b> You can re-import folders to rebuild.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="quiet-button"
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </button>
              <button type="button" className="danger-button" onClick={handleDeleteLibrary}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
