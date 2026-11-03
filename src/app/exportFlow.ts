export interface BatchExportNavigation {
  selectedIds: string[];
  setScreen: (screen: "Batch") => void;
  setSelection?: (ids: string[]) => void;
  showNotice?: (text: string) => void;
}

/**
 * One navigation action behind File > Export… and Cmd/Ctrl+E.
 *
 * Batch Export already owns the empty state, so an empty selection still opens
 * it with an actionable prompt instead of an error-shaped notice. A non-empty
 * selection is passed through unchanged so the export covers exactly what the
 * user had selected.
 */
export function navigateToBatchExport(context: BatchExportNavigation): void {
  const selection = [...context.selectedIds];
  if (selection.length > 0 && context.setSelection) {
    context.setSelection(selection);
  }
  context.setScreen("Batch");
  if (selection.length === 0) {
    context.showNotice?.(
      "Select photos or videos in Library, then choose Export again.",
    );
  }
}
