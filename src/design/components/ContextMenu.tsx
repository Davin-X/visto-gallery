import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  submenu?: ContextMenuItem[];
  divider?: boolean;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

function ContextMenuContent({
  items,
  onClose,
}: {
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const [submenuOpen, setSubmenuOpen] = useState<{
    index: number;
    items: ContextMenuItem[];
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (submenuOpen) {
          setSubmenuOpen(null);
          e.preventDefault();
        } else {
          onClose();
        }
      }
      if (e.key === "ArrowRight" && submenuOpen) {
        submenuRef.current?.querySelector("button")?.focus();
      }
      if (e.key === "ArrowLeft" && submenuOpen) {
        setSubmenuOpen(null);
        (
          menuRef.current?.querySelector(
            `[data-index="${submenuOpen.index}"]`,
          ) as HTMLElement
        )?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [submenuOpen, onClose]);

  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.onClick) item.onClick();
    if (!item.submenu) onClose();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={(e) => {
        const items = menuRef.current?.querySelectorAll(
          '[role="menuitem"]:not([disabled])',
        );
        const current = Array.from(items || []).findIndex(
          (el) => el === document.activeElement,
        );
        if (current === -1) return;

        let next = current;
        if (e.key === "ArrowDown") next = (current + 1) % (items?.length || 1);
        if (e.key === "ArrowUp")
          next = (current - 1 + (items?.length || 1)) % (items?.length || 1);

        if (next !== current) {
          (items as any)?.[next]?.focus();
          e.preventDefault();
        }
      }}
    >
      {(items || []).map((item, index) => {
        if (item.divider) {
          return (
            <div
              key={index}
              className="context-menu-separator"
              role="separator"
            />
          );
        }

        if (item.submenu) {
          return (
            <div key={index} className="context-menu-submenu" role="none">
              <button
                ref={submenuRef as any}
                role="menuitem"
                aria-haspopup="true"
                aria-expanded={submenuOpen?.index === index}
                data-index={index}
                className={`context-menu-item ${item.disabled ? "disabled" : ""}`}
                disabled={item.disabled}
                onClick={() =>
                  !item.disabled &&
                  setSubmenuOpen({ index, items: item.submenu! })
                }
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" && !item.disabled) {
                    setSubmenuOpen({ index, items: item.submenu! });
                    e.preventDefault();
                  }
                }}
              >
                <span className="context-menu-icon">{item.icon || ""}</span>
                <span>{item.label}</span>
                {item.shortcut && (
                  <span className="context-menu-shortcut">{item.shortcut}</span>
                )}
                <span className="context-menu-submenu-indicator">›</span>
              </button>
              {submenuOpen?.index === index && (
                <ContextMenuContent
                  items={item.submenu}
                  onClose={() => setSubmenuOpen(null)}
                />
              )}
            </div>
          );
        }

        return (
          <button
            key={index}
            role="menuitem"
            data-index={index}
            className={`context-menu-item ${item.disabled ? "disabled" : ""} ${item.danger ? "danger" : ""}`}
            disabled={item.disabled}
            onClick={() => handleItemClick(item)}
          >
            {item.icon && (
              <span className="context-menu-icon">{item.icon}</span>
            )}
            <span>{item.label}</span>
            {item.shortcut && (
              <span className="context-menu-shortcut">{item.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

let portalRoot: HTMLElement | null = null;
let portalHost: HTMLElement | null = null;

/**
 * The menu has to mount inside `.app-frame`, because that is where the theme
 * custom properties (--surface, --line, --ink, …) are declared. Appending to
 * <body> instead leaves the panel with no background, so it renders invisible.
 */
function getPortalRoot(): HTMLElement {
  const frame = document.querySelector<HTMLElement>(".app-frame");
  const host = frame ?? document.body;
  if (!portalRoot || portalHost !== host || !portalRoot.isConnected) {
    portalRoot?.remove();
    portalRoot = document.createElement("div");
    portalRoot.id = "context-menu-portal";
    host.appendChild(portalRoot);
    portalHost = host;
  }
  return portalRoot;
}

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  if (typeof window === "undefined") return null;

  const root = getPortalRoot();

  // Compute adjusted position BEFORE render to avoid clipping
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const padding = 8;

  // We need menu dimensions - estimate from items count
  const itemHeight = 36;
  const menuHeight = items.length * itemHeight + 12; // padding
  const menuWidth = 240; // typical width

  let adjustedX = x;
  let adjustedY = y;

  if (x + menuWidth > vw - padding) adjustedX = vw - menuWidth - padding;
  if (y + menuHeight > vh - padding) adjustedY = vh - menuHeight - padding;
  if (adjustedX < padding) adjustedX = padding;
  if (adjustedY < padding) adjustedY = padding;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!root.contains(e.target as Node)) onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, root]);

  const content = <ContextMenuContent items={items} onClose={onClose} />;

  return createPortal(
    <div
      style={{
        position: "fixed",
        left: adjustedX,
        top: adjustedY,
        zIndex: 1000,
        pointerEvents: "none",
      }}
      onClick={onClose}
    >
      <div style={{ pointerEvents: "auto" }}>{content}</div>
    </div>,
    root,
  );
}

// Hook for using context menu in components
export function useContextMenu() {
  const [menu, setMenu] = useState<{
    items: ContextMenuItem[];
    x: number;
    y: number;
  } | null>(null);

  const open = (items: ContextMenuItem[], e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ items, x: e.clientX, y: e.clientY });
  };

  const close = () => setMenu(null);

  return {
    menu,
    open,
    close,
    ContextMenu: menu && (
      <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={close} />
    ),
  };
}
