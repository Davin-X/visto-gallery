export type ScanMode = "media" | "bursts" | "files";

export function DuplicateModeTabs({
  mode,
  onModeChange,
}: {
  mode: ScanMode;
  onModeChange: (mode: ScanMode) => void;
}) {
  return (
    <div
      className="duplicate-filter-tabs duplicate-mode-tabs"
      role="group"
      aria-label="What to compare"
    >
      <button
        type="button"
        aria-pressed={mode === "media"}
        className={mode === "media" ? "is-active" : ""}
        onClick={() => onModeChange("media")}
      >
        Photos &amp; videos
      </button>
      <button
        type="button"
        aria-pressed={mode === "bursts"}
        className={mode === "bursts" ? "is-active" : ""}
        title="Find camera bursts and visually similar photos in your library"
        onClick={() => onModeChange("bursts")}
      >
        Bursts &amp; similar
      </button>
      <button
        type="button"
        aria-pressed={mode === "files"}
        className={mode === "files" ? "is-active" : ""}
        title="Compare file contents in a single folder"
        onClick={() => onModeChange("files")}
      >
        Any file type
      </button>
    </div>
  );
}
