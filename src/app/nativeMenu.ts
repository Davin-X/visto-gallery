/**
 * Native menu event names emitted by `src-tauri/src/lib.rs`.
 *
 * Keeping the dispatch table in one small module means the File > Export…
 * menu item and the in-app keyboard shortcut can be verified to call the same
 * action without mounting the whole application.
 */
export type NativeMenuEvent =
  | "menu-open-folder"
  | "menu-import-files"
  | "menu-export"
  | "menu-toggle-sidebar"
  | "menu-toggle-inspector"
  | "menu-zoom-in"
  | "menu-zoom-out"
  | "menu-about"
  | "menu-check-updates";

export interface NativeMenuHandlers {
  importFolder: () => void;
  importFiles: () => void;
  exportToBatch: () => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  showAbout: () => void;
  checkUpdates: () => void;
}

/**
 * Route a native menu event to its app action. Returns false for unknown
 * events so callers can ignore forward-compatible additions.
 */
export function dispatchNativeMenuEvent(
  event: string,
  handlers: NativeMenuHandlers,
): boolean {
  switch (event) {
    case "menu-open-folder":
      handlers.importFolder();
      return true;
    case "menu-import-files":
      handlers.importFiles();
      return true;
    case "menu-export":
      handlers.exportToBatch();
      return true;
    case "menu-toggle-sidebar":
      handlers.toggleSidebar();
      return true;
    case "menu-toggle-inspector":
      handlers.toggleInspector();
      return true;
    case "menu-zoom-in":
      handlers.zoomIn();
      return true;
    case "menu-zoom-out":
      handlers.zoomOut();
      return true;
    case "menu-about":
      handlers.showAbout();
      return true;
    case "menu-check-updates":
      handlers.checkUpdates();
      return true;
    default:
      return false;
  }
}
