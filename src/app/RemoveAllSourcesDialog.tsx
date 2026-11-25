import { TypedConfirmDialog } from "../design/components/TypedConfirmDialog";

export function RemoveAllSourcesDialog({
  open,
  onClose,
  onConfirm,
  busy,
  sourceCount,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  /** While a removal pass is running the dialog stays up and pinned. */
  busy: boolean;
  sourceCount: number;
}) {
  return (
    <TypedConfirmDialog
      open={open}
      eyebrow="LIBRARY"
      title="Remove all sources?"
      description={
        <>
          Unlinks all{" "}
          <b>
            {sourceCount} source {sourceCount === 1 ? "folder" : "folders"}
          </b>{" "}
          from the library and drops their indexed entries — items, albums, tags, Smart Albums and
          duplicates. <b>Original files on disk are not affected.</b>
        </>
      }
      requiredPhrase="DELETE"
      confirmLabel="Remove all"
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
      titleId="remove-all-sources-title"
    />
  );
}
