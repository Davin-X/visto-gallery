import { useEffect, useRef } from "react";
import {
  dispatchNativeMenuEvent,
  type NativeMenuEvent,
  type NativeMenuHandlers,
} from "../nativeMenu";

const NATIVE_MENU_EVENTS: NativeMenuEvent[] = [
  "menu-open-folder",
  "menu-import-files",
  "menu-export",
  "menu-toggle-sidebar",
  "menu-toggle-inspector",
  "menu-zoom-in",
  "menu-zoom-out",
  "menu-about",
  "menu-check-updates",
  "menu-settings",
  "menu-shortcuts",
];

/**
 * Subscribe once to the native menu events emitted by the Rust side and route
 * each to the latest handler. The listeners are registered on mount only, so
 * handlers are read through a ref and never go stale.
 */
export function useNativeMenu(handlers: NativeMenuHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    // Each entry forwards to whatever handler is current when the event fires.
    const latest: NativeMenuHandlers = {
      importFolder: () => handlersRef.current.importFolder(),
      importFiles: () => handlersRef.current.importFiles(),
      exportToBatch: () => handlersRef.current.exportToBatch(),
      toggleSidebar: () => handlersRef.current.toggleSidebar(),
      toggleInspector: () => handlersRef.current.toggleInspector(),
      zoomIn: () => handlersRef.current.zoomIn(),
      zoomOut: () => handlersRef.current.zoomOut(),
      showAbout: () => handlersRef.current.showAbout(),
      checkUpdates: () => handlersRef.current.checkUpdates(),
      showSettings: () => handlersRef.current.showSettings(),
      showShortcuts: () => handlersRef.current.showShortcuts(),
    };

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      for (const event of NATIVE_MENU_EVENTS) {
        const unlisten = await listen(event, () => dispatchNativeMenuEvent(event, latest));
        if (cancelled) unlisten();
        else unlisteners.push(unlisten);
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, []);
}
