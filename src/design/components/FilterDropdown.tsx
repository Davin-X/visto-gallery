import React from "react";
import { FilterIcon } from "./icons";

export function FilterDropdown(props: any) {
  return (
    <div>
      <button type="button" onClick={() => alert('hi')}>
        <FilterIcon size={13} />
        Filters
      </button>
    </div>
  );
}
