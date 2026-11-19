interface CleanupTabsProps {
  /** Which of the two cleanup screens is showing. */
  screen: "Duplicates" | "Cleanup";
  /** Omit on the Duplicates screen; only the other tab needs a destination. */
  onOpenDuplicates?: () => void;
  onOpenCleanup?: () => void;
}

/**
 * One "Clean up" destination in the sidebar, two views. Duplicates and
 * Cleanup stay separate screens so Back/Forward and the saved last view keep
 * working; this is just the switch between them.
 */
export function CleanupTabs({ screen, onOpenDuplicates, onOpenCleanup }: CleanupTabsProps) {
  return (
    <nav className="cleanup-tabs" aria-label="Cleanup">
      <button
        type="button"
        aria-current={screen === "Duplicates" ? "page" : undefined}
        onClick={onOpenDuplicates}
      >
        Duplicate media
      </button>
      <button
        type="button"
        aria-current={screen === "Cleanup" ? "page" : undefined}
        onClick={onOpenCleanup}
      >
        Mac storage
      </button>
    </nav>
  );
}
