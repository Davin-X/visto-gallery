import React, { useState } from "react";
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

  const activeCount =
    (props.minRating ? 1 : 0) +
    (props.colorLabelFilter ? 1 : 0) +
    (props.cameraFilter ? 1 : 0) +
    (props.lensFilter ? 1 : 0);

  return (
    <div className="filter-dropdown" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`filter-dropdown-button ${open ? "active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Filters"
      >
        <FilterIcon size={13} />
        <span>Filters</span>
        {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
      </button>

      {open && (
        <div className="filter-dropdown-panel">
          <div className="filter-section">
            <span className="filter-section-label">Rating</span>
            <div className="filter-chip-row">
              {RATINGS.map((stars) => {
                const active = props.minRating === stars;
                return (
                  <button
                    key={stars}
                    type="button"
                    className={`filter-chip ${active ? "active" : ""}`}
                    onClick={() =>
                      props.onSetMinRating(active ? null : stars)
                    }
                    title={`Show ${stars}+ star${stars > 1 ? "s" : ""}`}
                  >
                    {Array.from({ length: stars }).map(() => (
                      <span key="star">★</span>
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
                    className={`filter-chip color-chip ${active ? "active" : ""}`}
                    onClick={() =>
                      props.onSetColorLabelFilter(active ? null : color)
                    }
                    title={`Filter by ${name} label`}
                    aria-label={name}
                  >
                    <span className="color-dot" style={{ backgroundColor: getColorHex(color) }} />
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
              onChange={(e) =>
                props.onSetCameraFilter(e.target.value.trim() || null)
              }
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
            />
          </div>
        </div>
      )}
    </div>
  );
}

function getColorHex(color: string): string {
  const map: Record<string, string> = {
    red: "#ef4444",
    yellow: "#eab308",
    green: "#22c55e",
    blue: "#3b82f6",
    purple: "#a855f7",
  };
  return map[color] ?? "#94a3b8";
}

