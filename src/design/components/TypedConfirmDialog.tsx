import React, { useEffect, useId, useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useKeyboard } from "../../engine/hooks/useKeyboard";

interface TypedConfirmDialogProps {
  open: boolean;
  /** Eyebrow shown above the title, e.g. "DELETE". */
  eyebrow?: string;
  title: string;
  /** What is deleted, exactly — keep it to the scope of the action. */
  description: React.ReactNode;
  /** The phrase the user must type to enable the confirm button. */
  requiredPhrase: string;
  confirmLabel?: string;
  busy?: boolean;
  dialogRef?: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onConfirm: () => void;
  titleId?: string;
}

/**
 * Type-to-confirm for destructive actions. The confirm button stays disabled
 * until the typed phrase matches exactly (case-insensitive, trimmed), so a
 * habitual click can never land on a destructive path.
 */
export function TypedConfirmDialog({
  open,
  eyebrow,
  title,
  description,
  requiredPhrase,
  confirmLabel,
  busy,
  dialogRef,
  onClose,
  onConfirm,
  titleId,
}: TypedConfirmDialogProps) {
  const generatedId = useId();
  const labelId = titleId ?? generatedId;
  const [phrase, setPhrase] = React.useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const localRef = useRef<HTMLDivElement | null>(null);
  const containerRef = dialogRef ?? localRef;

  useFocusTrap(open && !busy, containerRef);
  useKeyboard([
    (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    },
  ]);

  // Reset and focus whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPhrase("");
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  const ready = phrase.trim().toLowerCase() === requiredPhrase.toLowerCase();

  return (
    <div
      className="dialog-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={containerRef}
        className="album-dialog delete-album-dialog confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={labelId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2 id={labelId}>{title}</h2>
          </div>
        </div>
        <div className="dialog-body">{description}</div>
        <div className="dialog-field">
          <label htmlFor={`${labelId}-input`}>
            Type <b>{requiredPhrase}</b> to confirm
          </label>
          <input
            id={`${labelId}-input`}
            ref={inputRef}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={phrase}
            disabled={busy}
            onChange={(event) => setPhrase(event.target.value)}
            placeholder={requiredPhrase}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={!ready || busy}
            onClick={() => {
              if (ready && !busy) onConfirm();
            }}
          >
            {busy ? "Working…" : (confirmLabel ?? "Delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
