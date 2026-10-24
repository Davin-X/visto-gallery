import React, { useEffect, useRef, useState, useCallback } from "react";
import { useSettingsStore, useAppearance, useAccentColor, useSidebarWidth, useDefaultLayout, useLibraryStore, useSystemDark, ACCENT_PALETTE } from "../../engine/stores";
import { tauri } from "../../engine/commands/tauri";
import type { LibraryFolder } from "../../engine/types/commands";
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
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const sidebarWidth = useSidebarWidth();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingLibrary, setDeletingLibrary] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  
  // Settings values
  const appearance = useAppearance();
  const accentColor = useAccentColor();
  // Which accent variant (light/dark) is live, so the swatches preview the
  // color that will actually be applied.
  const systemDark = useSystemDark();
  const isDark = appearance === "dark" || (appearance === "system" && systemDark);
  const defaultLayout = useDefaultLayout();
  const autoImport = useSettingsStore((s) => s.autoImport);
  const pairRawJpeg = useSettingsStore((s) => s.pairRawJpeg);
  const stackBursts = useSettingsStore((s) => s.stackBursts);
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
  
  const update = useSettingsStore((s) => s.update);
  const updateMany = useSettingsStore((s) => s.updateMany);
  const resetSettings = useSettingsStore((s) => s.reset);
  const loadLibrary = useLibraryStore((s) => s.loadLibrary);
  const showNotice = useLibraryStore((s) => s.showNotice);

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
      showNotice(`Could not delete the library database: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeletingLibrary(false);
    }
  }, [loadLibrary, showNotice]);

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
      showNotice(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRebuilding(false);
    }
  }, [loadLibrary, showNotice]);

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
    onChange: (v: string) => void
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
    <div className="accent-picker" role="radiogroup" aria-label="Accent color">
      {ACCENT_PALETTE.map((c) => {
        const selected = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            className={`accent-option ${selected ? "selected" : ""}`}
            onClick={() => onChange(c.id)}
            aria-label={c.label}
            aria-pressed={selected}
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
          <p className="page-subtitle">Customize Stillroom to match your workflow.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="settings-tabs" role="tablist" aria-label="Settings categories">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(el) => { tabRefs.current[index] = el; }}
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
      <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`} className="settings-panel">
        {activeTab === "general" && <GeneralPanel
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
        />}
        {activeTab === "viewing" && <ViewingPanel
          defaultLayout={defaultLayout}
          thumbnailSize={thumbnailSize}
          slideshowInterval={slideshowInterval}
          slideshowShuffle={slideshowShuffle}
          slideshowLoop={slideshowLoop}
          videoAutoPlay={videoAutoPlay}
          videoLoop={videoLoop}
          onChange={update}
          renderRadioGroup={renderRadioGroup}
        />}
        {activeTab === "library" && <LibraryPanel
          autoImport={autoImport}
          pairRawJpeg={pairRawJpeg}
          stackBursts={stackBursts}
          onAddFolder={props.onAddFolder}
          onRemoveFolder={props.onRemoveFolder}
          onRescan={props.onRescan}
          onRescanFolder={props.onRescanFolder}
          onChange={update}
        />}
        {activeTab === "privacy" && <PrivacyPanel />}
        {activeTab === "advanced" && <AdvancedPanel
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
        />}
      </div>

      {/* Confirmation Dialogs */}
      {showResetConfirm && (
        <div className="dialog-backdrop" onClick={() => setShowResetConfirm(false)}>
          <div className="album-dialog confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">RESET</p>
                <h2>Reset All Settings?</h2>
              </div>
            </div>
            <p className="dialog-body">This will restore all preferences to their defaults. Your library, albums, and tags will not be affected.</p>
            <div className="dialog-actions">
              <button type="button" className="quiet-button" onClick={() => setShowResetConfirm(false)}>Cancel</button>
              <button type="button" className="danger-button" onClick={handleResetSettings}>Reset</button>
            </div>
          </div>
        </div>
      )}
      {showDeleteConfirm && (
        <div className="dialog-backdrop" onClick={() => setShowDeleteConfirm(false)}>
          <div className="album-dialog delete-album-dialog confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">DELETE</p>
                <h2>Delete Library Database?</h2>
              </div>
            </div>
            <p className="dialog-body">This removes the catalog, albums, tags, and all metadata. <b>Original files on disk are not affected.</b> You can re-import folders to rebuild.</p>
            <div className="dialog-actions">
              <button type="button" className="quiet-button" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
              <button type="button" className="danger-button" onClick={handleDeleteLibrary}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
