import { useCallback, useEffect, useState } from "react";
import type React from "react";
import type { ContextMenuItem } from "../../design/components/ContextMenu";

interface ContextMenuState {
  items: ContextMenuItem[];
  x: number;
  y: number;
}

/**
 * The app's single custom context menu, and suppression of the webview's
 * default one everywhere outside editable fields.
 */
export function useContextMenu() {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Opening our own menu has to cancel the event, otherwise the webview shows
  // its default menu (Reload / Copy / Open in new tab) on top of it.
  const openContextMenu = useCallback((items: ContextMenuItem[], e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ items, x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Suppress the webview's default menu everywhere else too, so the app never
  // exposes browser chrome. Editable fields keep it, for Paste / Select All.
  useEffect(() => {
    const suppress = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const editable =
        el.isContentEditable ||
        ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !el.hasAttribute("disabled"));
      if (!editable) e.preventDefault();
    };
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);

  return { contextMenu, openContextMenu, closeContextMenu };
}
