import { useCallback, useRef, useState, type FormEvent } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useKeyboard } from "../../engine/hooks/useKeyboard";
import { endOfLocalDay, startOfLocalDay, toDateInputValue } from "../../engine/utils/dateRange";
import type { SmartAlbumFilter } from "../../engine/types/commands";

/** Fields the dialog edits. Everything else in a saved definition (camera,
 *  lens, colour label, source, sort) is carried through untouched, so editing
 *  a Smart Album from here never silently drops a clause it does not show. */
export type Editable = {
  kind: SmartAlbumFilter["kind"] | undefined;
  favorite: boolean;
  rating: number | null;
  query: string;
  tags: string;
  tagMatch: "any" | "all";
  sizeMinMb: number | null;
  sizeMaxMb: number | null;
  extension: string;
  animated: boolean | null;
  /** `null` = either way, `true` = must have GPS, `false` = must not. */
  hasLocation: boolean | null;
  orientation: "landscape" | "portrait" | "square" | undefined;
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

const ORIENTATIONS: Array<{
  value: Editable["orientation"];
  label: string;
}> = [
  { value: undefined, label: "Any shape" },
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
  { value: "square", label: "Square" },
];

const BYTES_IN_MB = 1024 * 1024;

/** Sizes are stored in bytes but typed in MB, where a library is readable. */
function bytesToMb(bytes: number | null | undefined): number | null {
  if (bytes === undefined || bytes === null) return null;
  return Math.round((bytes / BYTES_IN_MB) * 100) / 100;
}

function mbToBytes(mb: number | null): number | undefined {
  if (mb === null || !Number.isFinite(mb) || mb < 0) return undefined;
  return Math.round(mb * BYTES_IN_MB);
}

/** Split the comma-separated field, trimming and dropping duplicates so the
 *  `all` match cannot require the same tag twice. */
export function parseTags(value: string): string[] {
  const seen = new Set<string>();
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .forEach((tag) => seen.add(tag));
  return [...seen];
}

export function editableFrom(filter: SmartAlbumFilter): Editable {
  return {
    kind: filter.kind,
    favorite: filter.favorite === true,
    rating: filter.rating ?? null,
    query: filter.query ?? "",
    tags: (filter.tags ?? []).join(", "),
    tagMatch: filter.tagMatch === "all" ? "all" : "any",
    sizeMinMb: bytesToMb(filter.sizeMin),
    sizeMaxMb: bytesToMb(filter.sizeMax),
    extension: filter.extension ?? "",
    animated: filter.animated ?? null,
    hasLocation: filter.hasLocation ?? null,
    orientation: filter.orientation,
    dateFrom: filter.dateFrom ?? null,
    dateTo: filter.dateTo ?? null,
  };
}

/** Rebuild a definition from the edited fields plus the clauses we do not
 *  expose, replacing rather than merging so a cleared field really clears. */
export function filterFrom(base: SmartAlbumFilter, draft: Editable): SmartAlbumFilter {
  const tags = parseTags(draft.tags);
  return {
    ...base,
    kind: draft.kind,
    favorite: draft.favorite ? true : undefined,
    rating: draft.rating ?? undefined,
    query: draft.query.trim() || undefined,
    tags: tags.length > 0 ? tags : undefined,
    tagMatch: tags.length > 1 && draft.tagMatch === "all" ? "all" : undefined,
    sizeMin: mbToBytes(draft.sizeMinMb),
    sizeMax: mbToBytes(draft.sizeMaxMb),
    extension: draft.extension.trim().replace(/^\./, "").toLowerCase() || undefined,
    animated: draft.animated ?? undefined,
    hasLocation: draft.hasLocation ?? undefined,
    orientation: draft.orientation,
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
    else
      setError(
        "Could not save this Smart Album. Check the filter values and that the name is not already in use.",
      );
  };

  const sizeNegative =
    (draft.sizeMinMb !== null && draft.sizeMinMb < 0) ||
    (draft.sizeMaxMb !== null && draft.sizeMaxMb < 0);
  const sizeRangeInvalid =
    draft.sizeMinMb !== null && draft.sizeMaxMb !== null && draft.sizeMinMb > draft.sizeMaxMb;
  const sizeError = sizeNegative
    ? "File size cannot be negative."
    : sizeRangeInvalid
      ? "Minimum size cannot be larger than maximum size."
      : null;
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
            <button
              type="button"
              className={`quick-filter${draft.animated === true ? " active" : ""}`}
              aria-pressed={draft.animated === true}
              onClick={() => patch({ animated: draft.animated === true ? null : true })}
              disabled={busy}
            >
              Animated
            </button>
            <button
              type="button"
              className={`quick-filter${draft.animated === false ? " active" : ""}`}
              aria-pressed={draft.animated === false}
              onClick={() => patch({ animated: draft.animated === false ? null : false })}
              disabled={busy}
            >
              Stills
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
            <span className="filter-section-label">Tags</span>
            <span className="filter-section-hint">MATCH</span>
          </div>
          <input
            type="text"
            className="smart-album-text"
            value={draft.tags}
            onChange={(e) => patch({ tags: e.target.value })}
            placeholder="Comma-separated, e.g. beach, family"
            aria-label="Tags"
            disabled={busy}
          />
          <div className="filter-chip-row" role="group" aria-label="Tag matching">
            <button
              type="button"
              className={`quick-filter${draft.tagMatch === "any" ? " active" : ""}`}
              aria-pressed={draft.tagMatch === "any"}
              onClick={() => patch({ tagMatch: "any" })}
              disabled={busy}
            >
              Any tag
            </button>
            <button
              type="button"
              className={`quick-filter${draft.tagMatch === "all" ? " active" : ""}`}
              aria-pressed={draft.tagMatch === "all"}
              onClick={() => patch({ tagMatch: "all" })}
              disabled={busy}
            >
              All tags
            </button>
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-section-heading">
            <span className="filter-section-label">File size</span>
            <span className="filter-section-hint">MB</span>
          </div>
          <div className="filter-date-range">
            <label>
              <span>From</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={draft.sizeMinMb ?? ""}
                onChange={(e) =>
                  patch({
                    sizeMinMb:
                      e.target.value === "" || Number.isNaN(e.target.valueAsNumber)
                        ? null
                        : e.target.valueAsNumber,
                  })
                }
                aria-label="Minimum size in megabytes"
                disabled={busy}
              />
            </label>
            <label>
              <span>To</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={draft.sizeMaxMb ?? ""}
                onChange={(e) =>
                  patch({
                    sizeMaxMb:
                      e.target.value === "" || Number.isNaN(e.target.valueAsNumber)
                        ? null
                        : e.target.valueAsNumber,
                  })
                }
                aria-label="Maximum size in megabytes"
                disabled={busy}
              />
            </label>
          </div>
          {sizeError && (
            <span className="dialog-hint" role="alert">
              {sizeError}
            </span>
          )}
        </div>

        <div className="filter-section">
          <div className="filter-section-heading">
            <span className="filter-section-label">File extension</span>
          </div>
          <input
            type="text"
            className="smart-album-text"
            value={draft.extension}
            onChange={(e) => patch({ extension: e.target.value })}
            placeholder="e.g. jpg"
            aria-label="File extension"
            autoComplete="off"
            disabled={busy}
          />
        </div>

        <div className="filter-section">
          <div className="filter-section-heading">
            <span className="filter-section-label">Location &amp; shape</span>
          </div>
          <div className="filter-chip-row">
            <button
              type="button"
              className={`quick-filter${draft.hasLocation === true ? " active" : ""}`}
              aria-pressed={draft.hasLocation === true}
              onClick={() => patch({ hasLocation: draft.hasLocation === true ? null : true })}
              disabled={busy}
            >
              Has location
            </button>
            <button
              type="button"
              className={`quick-filter${draft.hasLocation === false ? " active" : ""}`}
              aria-pressed={draft.hasLocation === false}
              onClick={() => patch({ hasLocation: draft.hasLocation === false ? null : false })}
              disabled={busy}
            >
              No location
            </button>
            {ORIENTATIONS.map((orientation) => {
              const active = draft.orientation === orientation.value;
              return (
                <button
                  key={orientation.label}
                  type="button"
                  className={`quick-filter${active ? " active" : ""}`}
                  aria-pressed={active}
                  onClick={() => patch({ orientation: orientation.value })}
                  disabled={busy}
                >
                  {orientation.label}
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
          <button
            type="submit"
            className="primary-button"
            disabled={!name.trim() || busy || sizeError !== null}
          >
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

function formatMb(mb: number): string {
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
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
  if (draft.animated === true) parts.push("animated");
  if (draft.animated === false) parts.push("not animated");
  if (draft.rating !== null) parts.push(`rated ${draft.rating}★ or higher`);
  const tags = parseTags(draft.tags);
  if (tags.length > 0) {
    const quoted = tags.map((tag) => `“${tag}”`).join(", ");
    parts.push(
      draft.tagMatch === "all" && tags.length > 1
        ? `tagged with all of ${quoted}`
        : `tagged with any of ${quoted}`,
    );
  }
  if (draft.sizeMinMb !== null || draft.sizeMaxMb !== null) {
    if (draft.sizeMinMb !== null && draft.sizeMaxMb !== null) {
      parts.push(`between ${formatMb(draft.sizeMinMb)} and ${formatMb(draft.sizeMaxMb)} MB`);
    } else if (draft.sizeMinMb !== null) {
      parts.push(`at least ${formatMb(draft.sizeMinMb)} MB`);
    } else if (draft.sizeMaxMb !== null) {
      parts.push(`at most ${formatMb(draft.sizeMaxMb)} MB`);
    }
  }
  if (draft.extension.trim()) {
    parts.push(`extension “${draft.extension.trim().replace(/^\./, "").toLowerCase()}”`);
  }
  if (draft.hasLocation === true) parts.push("with a location");
  if (draft.hasLocation === false) parts.push("without a location");
  if (draft.orientation) parts.push(draft.orientation);
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
