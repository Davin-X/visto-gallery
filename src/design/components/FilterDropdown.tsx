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

export function FilterDropdown(props: FilterDropdownProps) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        className="quick-filter"
        onClick={(e) => {
          console.log("clicked");
          e.stopPropagation();
          setOpen(!open);
        }}
        style={{ cursor: "pointer" }}
      >
        <FilterIcon size={13} />
        <span>Filters</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "30px",
            left: "0",
            background: "red",
            padding: "20px",
            zIndex: 100000,
            color: "white",
          }}
        >
          TEST DROPDOWN
        </div>
      )}
    </div>
  );
}
