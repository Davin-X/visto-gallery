import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  /** Divider entries have no label; every real entry does. */
  label?: string | React.ReactNode;
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
  onEscape,
}: {
  items: ContextMenuItem[];
  onClose: () => void;
  /** What Escape does when no submenu of this level is open. Defaults to onClose. */
  onEscape?: () => void;
}) {
  const [submenuOpen, setSubmenuOpen] = useState<{
    index: number;
    items: ContextMenuItem[];
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Child-first registration: this level's handler runs before any parent
  // menu level's, so Escape consumes itself here via stopImmediatePropagation.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (submenuOpen) {
          setSubmenuOpen(null);
        } else {
          (onEscape ?? onClose)();
        }
        return;
      }
      if (e.key === "ArrowRight" && submenuOpen) {
        // The open submenu mounts inline (not portaled), so it is a
        // descendant of this level's menu root.
        (
          menuRef.current?.querySelector(
            '.context-menu-submenu.open [role="menuitem"]:not([disabled])',
          ) as HTMLElement | null
        )?.focus();
      }
      if (e.key === "ArrowLeft" && submenuOpen) {
        setSubmenuOpen(null);
        (
          menuRef.current?.querySelector(`[data-index="${submenuOpen.index}"]`) as HTMLElement
        )?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [submenuOpen, onClose, onEscape]);

  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.onClick) item.onClick();
    if (!item.submenu) onClose();
  };

  // Hover-only submenus: a row opens its panel, and leaving the row or the
  // panel closes it again. The short grace period covers the seam between the
  // two, so moving the pointer towards the panel does not dismiss it, while a
  // pointer that leaves still takes the panel away.
  const closeTimerRef = useRef<number | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setSubmenuOpen(null);
    }, 160);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={(e) => {
        const items = menuRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])');
        const current = Array.from(items || []).findIndex((el) => el === document.activeElement);
        const last = (items?.length || 0) - 1;

        if (current === -1) {
          if (e.key === "ArrowDown" && last >= 0) {
            (items as any)?.[0]?.focus();
            e.preventDefault();
          } else if (e.key === "ArrowUp" && last >= 0) {
            (items as any)?.[last]?.focus();
            e.preventDefault();
          } else if (e.key === "Home" && last >= 0) {
            (items as any)?.[0]?.focus();
            e.preventDefault();
          } else if (e.key === "End" && last >= 0) {
            (items as any)?.[last]?.focus();
            e.preventDefault();
          }
          return;
        }
        if (last < 0) return;

        let next = current;
        if (e.key === "ArrowDown") next = current === last ? 0 : current + 1;
        if (e.key === "ArrowUp") next = current === 0 ? last : current - 1;
        if (e.key === "Home") next = 0;
        if (e.key === "End") next = last;

        if (next !== current) {
          (items as any)?.[next]?.focus();
          e.preventDefault();
        }
      }}
    >
      {(items || []).map((item, index) => {
        if (item.divider) {
          return <div key={index} className="context-menu-separator" role="separator" />;
        }

        if (item.submenu) {
          return (
            <div
              key={index}
              className={`context-menu-submenu${submenuOpen?.index === index ? " open" : ""}`}
              role="none"
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              <button
                role="menuitem"
                aria-haspopup="true"
                aria-expanded={submenuOpen?.index === index}
                data-index={index}
                className={`context-menu-item ${item.disabled ? "disabled" : ""}`}
                disabled={item.disabled}
                onMouseEnter={() => {
                  if (item.disabled) return;
                  cancelClose();
                  setSubmenuOpen({ index, items: item.submenu! });
                }}
                onKeyDown={(e) => {
                  // Hover is the pointer's path; this keeps the keyboard working.
                  if ((e.key === "ArrowRight" || e.key === "Enter") && !item.disabled) {
                    setSubmenuOpen({ index, items: item.submenu! });
                    e.preventDefault();
                  }
                }}
              >
                <span className="context-menu-icon">{item.icon || ""}</span>
                <span>{item.label}</span>
                {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
                <span className="context-menu-submenu-indicator" aria-hidden="true">
                  ›
                </span>
              </button>
              {submenuOpen?.index === index && (
                <ContextMenuContent
                  items={item.submenu}
                  onClose={() => {
                    setSubmenuOpen(null);
                    onClose();
                  }}
                  onEscape={() => setSubmenuOpen(null)}
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
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span>{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
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
  const root = typeof window !== "undefined" ? getPortalRoot() : null;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleClickOutside = (e: MouseEvent) => {
      if (!root!.contains(e.target as Node)) onClose();
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose, root]);

  if (typeof window === "undefined") return null;

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

  const content = <ContextMenuContent items={items} onClose={onClose} />;

  return createPortal(
    <div
      style={{
        position: "fixed",
        left: adjustedX,
        top: adjustedY,
        zIndex: "var(--z-context-menu)",
        pointerEvents: "none",
      }}
    >
      <div style={{ pointerEvents: "auto" }}>{content}</div>
    </div>,
    root!,
  );
}
