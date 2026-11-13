export type { AppSettings } from "./generated/ipc";

import type { AppSettings } from "./generated/ipc";

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
  albumsView: "cards",
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
