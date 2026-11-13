import type { RefObject } from "react";
import { useKeyboard } from "../../engine/hooks/useKeyboard";
import { useLibraryStore, useSlideshowStore, useViewerStore } from "../../engine/stores";
import type { Screen } from "../screen";
import { isExportShortcut } from "../shortcuts";
import { setScreen } from "../useNavigationStore";

export interface AppShortcutContext {
  screen: Screen;
  viewerOrigin: Screen;
  /** True while any modal owns the keyboard (dialogs handle Enter/Escape). */
  modalOpen: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  toggleShortcutsCheatSheet: () => void;
  importFolder: () => void;
  importFiles: () => void;
  exportToBatch: () => void;
  navigateViewer: (delta: number) => void;
  openViewer: (id: string) => void;
}

function isEditableTarget(target: HTMLElement) {
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * The app-wide keyboard shortcuts. `useKeyboard` keeps the latest handler,
 * so the context passed on each render is always current.
 */
export function useAppShortcuts(context: AppShortcutContext) {
  useKeyboard([(e) => handleAppShortcut(e, context)]);
}

function handleAppShortcut(e: KeyboardEvent, context: AppShortcutContext) {
  const { screen, viewerOrigin, modalOpen, searchInputRef } = context;
  const library = useLibraryStore.getState();
  const viewer = useViewerStore.getState();
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  // ⌘/ / Ctrl+/ toggles the keyboard shortcuts cheat sheet.
  if (mod && key === "/") {
    e.preventDefault();
    context.toggleShortcutsCheatSheet();
    return;
  }

  // A slideshow owns the keyboard while it is open: its overlay handles
  // Escape/arrows/Space itself, and nothing underneath should react.
  if (useSlideshowStore.getState().isOpen) return;

  // While a modal is open, every key belongs to it (the dialogs own Enter
  // and Escape) instead of the global shortcut map.
  if (modalOpen) return;

  if (mod && key === "o") {
    e.preventDefault();
    context.importFolder();
    return;
  }
  if (mod && key === "i") {
    e.preventDefault();
    context.importFiles();
    return;
  }
  if (isExportShortcut(e)) {
    e.preventDefault();
    context.exportToBatch();
    return;
  }
  if (mod && e.key === "\\") {
    e.preventDefault();
    library.toggleSidebar();
    return;
  }
  if (mod && e.altKey && key === "i") {
    e.preventDefault();
    library.toggleInspector();
    return;
  }
  if (mod && key === "a") {
    const target = e.target as HTMLElement;
    if (
      !isEditableTarget(target) &&
      (screen === "Library" || screen === "Hidden" || screen === "Albums")
    ) {
      e.preventDefault();
      const items = screen === "Hidden" ? library.hiddenItems : library.visibleItems;
      const selectedSet = new Set(library.selectedIds);
      const allSelected = items.length > 0 && items.every((item) => selectedSet.has(item.id));
      library.setSelectedIds(allSelected ? [] : items.map((item) => item.id));
      return;
    }
  }
  if (mod && key === "f") {
    const target = e.target as HTMLElement;
    if (!isEditableTarget(target)) {
      e.preventDefault();
      const findSearchInput = () =>
        searchInputRef.current ||
        (document.querySelector(".search-field input") as HTMLInputElement | null);
      // Both the Library and Hidden screens own a search field. Jump to
      // Library only when neither is on screen, then focus once mounted.
      if (screen !== "Library" && screen !== "Hidden" && screen !== "Video") {
        setScreen("Library");
        let attempts = 0;
        const tryFocus = () => {
          const input = findSearchInput();
          if (input) {
            input.focus();
            input.select();
            return;
          }
          if (attempts++ < 10) requestAnimationFrame(tryFocus);
        };
        requestAnimationFrame(tryFocus);
      } else {
        const input = findSearchInput();
        input?.focus();
        input?.select();
      }
    }
    return;
  }
  // Arrows stay on the video player (±5 s seek); the photo viewer keeps
  // ←/→ for navigating, so only that screen gets the global navigation.
  if (screen === "Viewer" && !e.defaultPrevented) {
    const editable = isEditableTarget(e.target as HTMLElement);
    if (!editable && e.key === "ArrowRight") {
      context.navigateViewer(1);
    }
    if (!editable && e.key === "ArrowLeft") {
      context.navigateViewer(-1);
    }
  }
  if (e.key === "Escape") {
    if (screen === "Viewer") {
      viewer.close();
      setScreen(viewerOrigin || "Library");
    } else if (screen === "Video") {
      setScreen(viewerOrigin || "Library");
    } else if (library.showInspector) {
      library.toggleInspector();
    }
  }
  if (e.key === "Enter" && mod && screen === "Hidden" && library.inspectedId) {
    // HiddenScreen owns the reveal confirmation, so route the shortcut
    // through it instead of opening the viewer directly.
    e.preventDefault();
    window.dispatchEvent(
      new CustomEvent("mac-gallery:open-hidden", {
        detail: { id: library.inspectedId },
      }),
    );
    return;
  }
  if (e.key === "Enter" && mod && screen === "Library" && library.inspectedId) {
    context.openViewer(library.inspectedId);
  }
}
