import React, { useEffect, useRef, useState } from "react";
import { FilterIcon } from "./icons";

interface FilterDropdownProps {
  minRating: number | null;
  colorLabelFilter: string | null;
  cameraFilter: string | null;
  lensFilter: string | null;
  onSetMinRating: (rating: number | null) => void;
  onSetColorLabelFilter: (colorLabel: string | null) => void;
  onSetCameraFilter: (camera: string | null) => void;
  onSetLensFilter: (lens: string | null) => void;
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
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

  const activeCount =
    (props.minRating ? 1 : 0) +
    (props.colorLabelFilter ? 1 : 0) +
    (props.cameraFilter ? 1 : 0) +
    (props.lensFilter ? 1 : 0);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        className={`quick-filter ${open ? "active" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-expanded={open}
      >
        <FilterIcon size={13} />
        <span>Filters</span>
        {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
      </button>

      {open && (
        <div
          className="filter-dropdown-panel"
          style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100000 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="filter-section">
            <span className="filter-section-label">Rating</span>
            <div className="filter-chip-row">
              {RATINGS.map((stars) => {
                const active = props.minRating === stars;
                return (
                  <button
                    key={stars}
                    type="button"
                    className={`quick-filter quick-filter-rating ${active ? "active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onSetMinRating(active ? null : stars);
                    }}
                  >
                    {Array.from({ length: stars }).map((_, i) => (
                      <span key={i} className="ctx-star">★</span>
                    ))}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="filter-section">
            <span className="filter-section-label">Color</span>
            <div className="filter-chip-row">
              {COLORS.map(([color, name]) => {
                const active = props.colorLabelFilter === color;
                return (
                  <button
                    key={color}
                    type="button"
                    className={`quick-filter quick-filter-color quick-filter-color-${color} ${active ? "active" : ""}`}
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

          <div className="filter-section">
            <span className="filter-section-label">Camera</span>
            <input
              type="text"
              className="filter-input"
              placeholder="Camera model"
              value={props.cameraFilter ?? ""}
              onChange={(e) => props.onSetCameraFilter(e.target.value.trim() || null)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>

          <div className="filter-section">
            <span className="filter-section-label">Lens</span>
            <input
              type="text"
              className="filter-input"
              placeholder="Lens model"
              value={props.lensFilter ?? ""}
              onChange={(e) => props.onSetLensFilter(e.target.value.trim() || null)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
