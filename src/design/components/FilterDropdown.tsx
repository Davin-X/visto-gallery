import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FilterIcon } from "./icons";

interface FilterDropdownProps {
  minRating: number | null;
  colorLabelFilter: string | null;
  onSetMinRating: (rating: number | null) => void;
  onSetColorLabelFilter: (colorLabel: string | null) => void;
}

const RATINGS = [1, 2, 3, 4, 5];
const COLORS: [string, string][] = [
  ["red", "Red"],
  ["yellow", "Yellow"],
  ["green", "Green"],
  ["blue", "Blue"],
  ["purple", "Purple"],
];

export function FilterDropdown(props: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const portalRoot =
    typeof document === "undefined"
      ? null
      : (document.querySelector<HTMLElement>(".app-frame") ?? document.body);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return;

    const positionPanel = () => {
      const button = buttonRef.current;
      const panel = panelRef.current;
      if (!button || !panel) return;

      const buttonRect = button.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const padding = 8;
      const gap = 6;
      const left = Math.max(
        padding,
        Math.min(buttonRect.left, window.innerWidth - panelRect.width - padding),
      );
      let top = buttonRect.bottom + gap;
      if (
        top + panelRect.height > window.innerHeight - padding &&
        buttonRect.top - panelRect.height - gap >= padding
      ) {
        top = buttonRect.top - panelRect.height - gap;
      }

      setPosition({ top, left });
    };

    positionPanel();
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [open]);

  const activeCount =
    (props.minRating ? 1 : 0) +
    (props.colorLabelFilter ? 1 : 0);

  return (
    <div style={{ display: "inline-block" }}>
      <button
        ref={buttonRef}
        type="button"
        className={`quick-filter ${open ? "active" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) {
            const rect = buttonRef.current?.getBoundingClientRect();
            if (rect) setPosition({ top: rect.bottom + 6, left: rect.left });
          }
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <FilterIcon size={13} />
        <span>Filters</span>
        {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
      </button>

      {open &&
        portalRoot &&
        createPortal(
          <div
            ref={panelRef}
            className="filter-dropdown-panel"
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              zIndex: 100000,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="filter-dropdown-heading">
              <div>
                <span className="filter-dropdown-kicker">YOUR LIBRARY</span>
                <h2>Refine your view</h2>
              </div>
              {activeCount > 0 && (
                <button
                  type="button"
                  className="filter-clear-button"
                  onClick={() => {
                    props.onSetMinRating(null);
                    props.onSetColorLabelFilter(null);
                  }}
                >
                  Clear all
                </button>
              )}
            </div>

            <div className="filter-section">
              <div className="filter-section-heading">
                <span className="filter-section-label">Rating</span>
                <span className="filter-section-hint">AT LEAST</span>
              </div>
              <div className="filter-chip-row">
                {RATINGS.map((stars) => {
                  const active = props.minRating === stars;
                  return (
                    <button
                      key={stars}
                      type="button"
                      className={`quick-filter quick-filter-rating ${active ? "active" : ""}`}
                      aria-label={`${stars} star${stars === 1 ? "" : "s"} and up`}
                      aria-pressed={active}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSetMinRating(active ? null : stars);
                      }}
                    >
                      {Array.from({ length: stars }).map((_, i) => (
                        <span key={i} className="ctx-star">
                          ★
                        </span>
                      ))}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="filter-section">
              <div className="filter-section-heading">
                <span className="filter-section-label">Color label</span>
                {props.colorLabelFilter && (
                  <span className="filter-current-value">
                    {props.colorLabelFilter}
                  </span>
                )}
              </div>
              <div className="filter-chip-row">
                {COLORS.map(([color, name]) => {
                  const active = props.colorLabelFilter === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      className={`quick-filter quick-filter-color quick-filter-color-${color} ${active ? "active" : ""}`}
                      aria-label={`${name} color`}
                      aria-pressed={active}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSetColorLabelFilter(active ? null : color);
                      }}
                      title={name}
                    >
                      <span className="color-dot-small" />
                    </button>
                  );
                })}
              </div>
            </div>

          </div>,
          portalRoot,
        )}
    </div>
  );
}
