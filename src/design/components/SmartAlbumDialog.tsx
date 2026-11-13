import { useCallback, useRef, useState, type FormEvent } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useKeyboard } from "../../engine/hooks/useKeyboard";
import { endOfLocalDay, startOfLocalDay, toDateInputValue } from "../../engine/utils/dateRange";
import type { SmartAlbumFilter } from "../../engine/types/commands";

/** Fields the dialog edits. Everything else in a saved definition (tags,
 *  camera, lens, colour label, source, sort) is carried through untouched, so
 *  editing a Smart Album from here never silently drops a clause it does not
 *  show. */
export type Editable = {
  kind: SmartAlbumFilter["kind"] | undefined;
  favorite: boolean;
  rating: number | null;
  query: string;
  dateFrom: number | null;
  dateTo: number | null;
};

const KINDS: Array<{ value: SmartAlbumFilter["kind"] | undefined; label: string }> = [
  { value: undefined, label: "Any type" },
  { value: "photo", label: "Photos" },
  { value: "video", label: "Videos" },
  { value: "raw", label: "RAW" },
];

const RATINGS = [1, 2, 3, 4, 5];

export function editableFrom(filter: SmartAlbumFilter): Editable {
  return {
    kind: filter.kind,
    favorite: filter.favorite === true,
    rating: filter.rating ?? null,
    query: filter.query ?? "",
    dateFrom: filter.dateFrom ?? null,
    dateTo: filter.dateTo ?? null,
  };
}

/** Rebuild a definition from the edited fields plus the clauses we do not
 *  expose, replacing rather than merging so a cleared field really clears. */
export function filterFrom(base: SmartAlbumFilter, draft: Editable): SmartAlbumFilter {
  return {
    ...base,
    kind: draft.kind,
    favorite: draft.favorite ? true : undefined,
    rating: draft.rating ?? undefined,
    query: draft.query.trim() || undefined,
    dateFrom: draft.dateFrom ?? undefined,
    dateTo: draft.dateTo ?? undefined,
  };
}

interface SmartAlbumDialogProps {
  mode: "create" | "edit";
  initialName?: string;
  initialFilter?: SmartAlbumFilter;
  onSubmit: (name: string, filter: SmartAlbumFilter) => Promise<boolean>;
  onClose: () => void;
}

export function SmartAlbumDialog({
  mode,
  initialName = "",
  initialFilter,
  onSubmit,
  onClose,
}: SmartAlbumDialogProps) {
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState<Editable>(() => editableFrom(initialFilter ?? {}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusTrap(true, dialogRef);

  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  useKeyboard([
    useCallback(
      (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      },
      [close],
    ),
  ]);

  const patch = (next: Partial<Editable>) => {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const ok = await onSubmit(trimmed, filterFrom(initialFilter ?? {}, draft));
    setBusy(false);
    if (ok) onClose();
    else setError("Could not save this Smart Album. Check that the name is not already in use.");
  };

  const summary = describeFilter(draft);

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <form
        ref={dialogRef}
        className="album-dialog smart-album-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-album-dialog-title"
        onSubmit={handleSubmit}
      >
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">SMART ALBUM</p>
            <h2 id="smart-album-dialog-title">
              {mode === "edit" ? "Edit Smart Album" : "New Smart Album"}
            </h2>
          </div>
          <button
            type="button"
            className="dialog-close"
            aria-label="Close"
            onClick={close}
            disabled={busy}
          >
            ×
          </button>
        </div>

        <div className="dialog-field">
          <label htmlFor="smart-album-name">Name</label>
          <input
            id="smart-album-name"
            data-autofocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="e.g. Blue-rated 2026"
            maxLength={80}
            autoComplete="off"
            disabled={busy}
          />
        </div>

        <div className="filter-section">
          <div className="filter-section-heading">
            <span className="filter-section-label">Media type</span>
          </div>
          <div className="filter-chip-row">
            {KINDS.map((kind) => {
              const active = draft.kind === kind.value;
              return (
                <button
                  key={kind.label}
                  type="button"
                  className={`quick-filter${active ? " active" : ""}`}
                  aria-pressed={active}
                  onClick={() => patch({ kind: kind.value })}
                  disabled={busy}
                >
                  {kind.label}
                </button>
              );
            })}
            <button
              type="button"
              className={`quick-filter${draft.favorite ? " active" : ""}`}
              aria-pressed={draft.favorite}
              onClick={() => patch({ favorite: !draft.favorite })}
              disabled={busy}
            >
              Favorites
            </button>
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-section-heading">
            <span className="filter-section-label">Rating</span>
            <span className="filter-section-hint">AT LEAST</span>
          </div>
          <div className="filter-chip-row">
            <button
              type="button"
              className={`quick-filter${draft.rating === null ? " active" : ""}`}
              aria-pressed={draft.rating === null}
              onClick={() => patch({ rating: null })}
              disabled={busy}
            >
              Any
            </button>
            {RATINGS.map((stars) => {
              const active = draft.rating === stars;
              return (
                <button
                  key={stars}
                  type="button"
                  className={`quick-filter quick-filter-rating${active ? " active" : ""}`}
                  aria-label={`${stars} star${stars === 1 ? "" : "s"} and up`}
                  aria-pressed={active}
                  onClick={() => patch({ rating: stars })}
                  disabled={busy}
                >
                  <span className="ctx-star">★</span>
                  {stars}
                </button>
              );
            })}
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-section-heading">
            <span className="filter-section-label">Contains text</span>
          </div>
          <input
            type="search"
            className="smart-album-text"
            value={draft.query}
            onChange={(e) => patch({ query: e.target.value })}
            placeholder="Name, tag, camera or lens"
            aria-label="Contains text"
            disabled={busy}
          />
        </div>

        <div className="filter-section">
          <div className="filter-section-heading">
            <span className="filter-section-label">Capture date</span>
            <span className="filter-section-hint">INCLUSIVE</span>
          </div>
          <div className="filter-date-range">
            <label>
              <span>From</span>
              <input
                type="date"
                value={toDateInputValue(draft.dateFrom)}
                max={toDateInputValue(draft.dateTo) || undefined}
                onChange={(e) =>
                  patch({ dateFrom: startOfLocalDay(e.target.value), dateTo: draft.dateTo })
                }
                disabled={busy}
              />
            </label>
            <label>
              <span>To</span>
              <input
                type="date"
                value={toDateInputValue(draft.dateTo)}
                min={toDateInputValue(draft.dateFrom) || undefined}
                onChange={(e) =>
                  patch({ dateFrom: draft.dateFrom, dateTo: endOfLocalDay(e.target.value) })
                }
                disabled={busy}
              />
            </label>
          </div>
          <span className="settings-row-desc">
            Items without a capture date use their file modification date.
          </span>
        </div>

        <p className="dialog-hint smart-album-summary">{summary}</p>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={!name.trim() || busy}>
            {busy
              ? mode === "edit"
                ? "Saving…"
                : "Creating…"
              : mode === "edit"
                ? "Save changes"
                : "Create Smart Album"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** One line that says exactly what the album will contain. Smart albums are
 *  invisible logic, so the dialog states the rule back to the user as a rule
 *  readout rather than a sentence with a stray relative comma. */
function describeFilter(draft: Editable): string {
  const parts: string[] = [];
  const kind =
    draft.kind === "photo"
      ? "photos"
      : draft.kind === "video"
        ? "videos"
        : draft.kind === "raw"
          ? "RAW files"
          : "items";
  parts.push(`Matches all ${kind}`);
  if (draft.favorite) parts.push("marked favorite");
  if (draft.rating !== null) parts.push(`rated ${draft.rating}★ or higher`);
  if (draft.query.trim()) parts.push(`text contains “${draft.query.trim()}”`);
  if (draft.dateFrom !== null || draft.dateTo !== null) {
    const from = toDateInputValue(draft.dateFrom);
    const to = toDateInputValue(draft.dateTo);
    if (from && to) parts.push(`captured between ${from} and ${to}`);
    else if (from) parts.push(`captured on or after ${from}`);
    else if (to) parts.push(`captured on or before ${to}`);
  }
  return `${parts.join(" · ")}. Updates automatically as the library changes.`;
}
