import React from "react";
import { FilterIcon } from "./icons";

export function FilterDropdown(props: any) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{ padding: "4px 8px", cursor: "pointer" }}
      >
        <FilterIcon size={13} />
        Filters
      </button>
      {open && <div style={{ position: "absolute", top: "100%", left: 0, background: "red", color: "white", padding: "10px", zIndex: 999999 }}>HELLO</div>}
    </div>
  );
}
