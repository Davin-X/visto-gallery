import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "./icons";

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
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const portalRoot =
    typeof document === "undefined"
      ? null
      : (document.querySelector<HTMLElement>(".app-frame") ?? document.body);

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

  const toggle = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: Math.max(8, rect.right - 210) });
    }
    setOpen((value) => !value);
  };

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
        onClick={toggle}
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
            style={{ position: "fixed", top: position.top, left: position.left, zIndex: 100 }}
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
