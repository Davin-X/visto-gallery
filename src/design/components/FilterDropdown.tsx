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
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="quick-filter"
        onClick={() => {
          console.log("click");
          setOpen(!open);
        }}
      >
        <FilterIcon size={13} />
        <span>Filters</span>
        {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
      </button>
      {open && (
        <div className="filter-dropdown-panel" style={{ position: "absolute", top: 30, left: 0, zIndex: 9999 }}>
          <div style={{ padding: 10 }}>test</div>
        </div>
      )}
    </div>
  );
}
