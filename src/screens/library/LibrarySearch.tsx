import { SearchIcon } from "../../design/components/icons";
import { searchShortcutLabel } from "../../engine/utils/shortcut";
import type { LibraryScreenProps } from "./types";

export function LibrarySearch({
  hiddenView,
  searchInputRef,
  query,
  onChangeQuery,
}: Pick<LibraryScreenProps, "hiddenView" | "searchInputRef" | "query" | "onChangeQuery">) {
  return (
    <div className="search-field">
      <span className="search-icon">
        <SearchIcon size={15} />
      </span>
      <input
        ref={searchInputRef}
        value={query}
        onChange={(e) => onChangeQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) onChangeQuery("");
        }}
        placeholder={hiddenView ? "Search hidden items…" : "Search filenames, tags, camera, lens…"}
        aria-label={hiddenView ? "Search hidden items" : "Search library"}
      />
      {query ? (
        <button
          type="button"
          className="clear-btn visible"
          onClick={() => {
            onChangeQuery("");
          }}
          aria-label="Clear search"
          title="Clear (Esc)"
        >
          ×
        </button>
      ) : (
        <kbd title="Focus search">{searchShortcutLabel()}</kbd>
      )}
    </div>
  );
}
