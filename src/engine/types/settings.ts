export interface AppSettings {
  // General
  appearance: "light" | "dark" | "system";
  accentColor: "blue" | "purple" | "green" | "orange" | "pink" | "red";
  sidebarWidth: number;
  inspectorWidth: number;
  showExtensions: boolean;
  animateTransitions: boolean;

  // Startup
  startupView: "library" | "last" | "slideshow";
  openLastFolder: boolean;
  restoreWindowState: boolean;

  // Viewing
  defaultLayout: "grid" | "details" | "timeline";
  thumbnailSize: "small" | "medium" | "large";
  viewerZoomBehavior: "fit" | "actual" | "last";
  slideshowInterval: number;
  slideshowShuffle: boolean;
  slideshowLoop: boolean;
  videoAutoPlay: boolean;
  videoLoop: boolean;

  // Library
  watchFolders: string[];
  autoImport: boolean;
  /**
   * Dormant compatibility fields. RAW+JPEG pairing and burst stacking are not
   * implemented yet; the controls are marked unavailable in Settings, but the
   * persisted values are kept so an upgrade never drops a user preference.
   */
  pairRawJpeg: boolean;
  stackBursts: boolean;
  stackLivePhotos: boolean;

  // Updates
  /**
   * Contact GitHub for public release metadata once after launch. Defaults to
   * false to preserve the local-first promise; Help > Check for Updates always
   * works regardless of this preference.
   */
  checkForUpdatesOnLaunch: boolean;

  // Advanced
  maxCacheSizeGB: number;
  thumbnailQuality: number;
  enableDebugLogging: boolean;
  showNativeLimitWarnings: boolean;
}

export const defaultSettings: AppSettings = {
  appearance: "system",
  accentColor: "blue",
  sidebarWidth: 240,
  inspectorWidth: 300,
  showExtensions: false,
  animateTransitions: true,
  startupView: "library",
  openLastFolder: true,
  restoreWindowState: true,
  defaultLayout: "grid",
  thumbnailSize: "small",
  viewerZoomBehavior: "fit",
  slideshowInterval: 5,
  slideshowShuffle: false,
  slideshowLoop: true,
  videoAutoPlay: true,
  videoLoop: false,
  watchFolders: [],
  autoImport: false,
  pairRawJpeg: true,
  stackBursts: true,
  stackLivePhotos: true,
  checkForUpdatesOnLaunch: false,
  maxCacheSizeGB: 5,
  thumbnailQuality: 80,
  enableDebugLogging: false,
  showNativeLimitWarnings: true,
};
