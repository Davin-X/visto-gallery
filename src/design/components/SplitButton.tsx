import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "./icons";
import { usePopoverFocus } from "../hooks/usePopoverFocus";

interface SplitButtonItem {
  key: string;
  label: string;
  icon?: React.ComponentType<{ size?: number }>;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
}

interface SplitButtonProps {
  label: string;
  icon: React.ComponentType<{ size?: number }>;
  onClick: () => void;
  items: SplitButtonItem[];
  disabled?: boolean;
  menuLabel: string;
  className?: string;
}

/**
 * One primary action with a chevron button beside it for the less-common
 * variants (e.g. "Add folder" with "Add files…" behind the chevron). Avoids a
 * row of near-duplicate add buttons while keeping the common action one
 * click away.
 */
export default function SplitButton({
  label,
  icon: Icon,
  onClick,
  items,
  disabled,
  menuLabel,
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    maxHeight: undefined as number | undefined,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const portalRoot =
    typeof document === "undefined"
      ? null
      : (document.querySelector<HTMLElement>(".app-frame") ?? document.body);

  usePopoverFocus(open, panelRef, buttonRef, { menu: true });

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = buttonRef.current?.getBoundingClientRect();
      const menu = panelRef.current;
      if (!trigger || !menu) return;
      const padding = 8;
      const gap = 6;
      const below = window.innerHeight - trigger.bottom - gap - padding;
      const above = trigger.top - gap - padding;
      const height = menu.scrollHeight + 2;
      const openAbove = height > below && above > below;
      const maxHeight = Math.max(0, openAbove ? above : below);
      setPosition({
        top: openAbove ? trigger.top - gap - Math.min(height, maxHeight) : trigger.bottom + gap,
        left: Math.max(
          padding,
          Math.min(
            trigger.right - menu.offsetWidth,
            window.innerWidth - menu.offsetWidth - padding,
          ),
        ),
        maxHeight,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, items.length]);

  return (
    <div className="split-button">
      <button
        className="primary-button split-button-main"
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={label}
      >
        <Icon size={15} />
        <span className="btn-label">{label}</span>
      </button>
      <button
        ref={buttonRef}
        className="primary-button split-button-toggle"
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={menuLabel}
        title={menuLabel}
      >
        <ChevronDownIcon size={15} />
      </button>
      {open &&
        portalRoot &&
        createPortal(
          <div
            ref={panelRef}
            className="split-button-panel"
            role="menu"
            aria-label={menuLabel}
            style={{ position: "fixed", ...position, zIndex: 100 }}
          >
            {items.map((item) => {
              const ItemIcon = item.icon;
              return (
                <button
                  key={item.key}
                  className="split-button-item"
                  role="menuitem"
                  type="button"
                  title={item.title}
                  disabled={item.disabled}
                  onClick={() => {
                    item.onClick();
                    setOpen(false);
                  }}
                >
                  {ItemIcon ? <ItemIcon size={14} /> : null}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>,
          portalRoot,
        )}
    </div>
  );
}
