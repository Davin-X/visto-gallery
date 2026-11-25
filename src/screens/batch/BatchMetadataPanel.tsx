import React from "react";
import { tauri } from "../../engine/commands/tauri";
import type { BatchMetadataResult, MediaItem } from "../../engine/types/media";
import { formatCapturedDateTime } from "../../engine/utils/mediaDate";

interface BatchMetadataPanelProps {
  items: MediaItem[];
  onReloadLibrary: () => Promise<void> | void;
  onOpenLibrary: () => void;
}

/** Parse `<input type="datetime-local">` as wall-clock UTC ms to match EXIF storage. */
export function parseLocalDateTimeAsUtcMs(value: string): number | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match;
  const ms = Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss ?? "0"),
  );
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function BatchMetadataPanel({
  items,
  onReloadLibrary,
  onOpenLibrary,
}: BatchMetadataPanelProps) {
  const [dateInput, setDateInput] = React.useState("");
  const [titleInput, setTitleInput] = React.useState("");
  const [clearTitle, setClearTitle] = React.useState(false);
  const [keywordsInput, setKeywordsInput] = React.useState("");
  const [keywordsMode, setKeywordsMode] = React.useState<"add" | "replace" | "remove" | "clear">(
    "add",
  );
  const [latInput, setLatInput] = React.useState("");
  const [lonInput, setLonInput] = React.useState("");
  const [clearLocation, setClearLocation] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<BatchMetadataResult | null>(null);

  const parsedKeywords = keywordsInput
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const hasDateChange = Boolean(dateInput.trim());
  const hasTitleChange = clearTitle || Boolean(titleInput.trim());
  const clearKeywords = keywordsMode === "clear";
  const hasKeywordsChange = clearKeywords || parsedKeywords.length > 0;
  const hasLocationInput = Boolean(latInput.trim() || lonInput.trim());
  const hasLocationChange = clearLocation || hasLocationInput;
  const hasAnyChange = hasDateChange || hasTitleChange || hasKeywordsChange || hasLocationChange;

  const existingTags = React.useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      for (const tag of item.tags ?? []) set.add(tag);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (items.length === 0 || busy || !hasAnyChange) return;

    let capturedAt: number | null = null;
    if (hasDateChange) {
      capturedAt = parseLocalDateTimeAsUtcMs(dateInput);
      if (capturedAt === null) {
        setError("Enter a valid capture date and time.");
        return;
      }
    }

    let latitude: number | null = null;
    let longitude: number | null = null;
    if (!clearLocation && hasLocationInput) {
      const lat = Number(latInput.trim());
      const lon = Number(lonInput.trim());
      if (
        !latInput.trim() ||
        !lonInput.trim() ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      ) {
        setError("Latitude must be between -90 and 90, and longitude between -180 and 180.");
        return;
      }
      if (lat === 0 && lon === 0) {
        setError("Coordinates (0, 0) are treated as missing GPS fix.");
        return;
      }
      latitude = lat;
      longitude = lon;
    }

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await tauri.batch.editMetadata({
        itemIds: items.map((item) => item.id),
        capturedAt,
        title: clearTitle ? "" : titleInput.trim() ? titleInput.trim() : null,
        keywords: clearKeywords ? [] : parsedKeywords,
        keywordsMode: clearKeywords ? "replace" : hasKeywordsChange ? keywordsMode : null,
        latitude,
        longitude,
        clearLocation,
      });
      setResult(res);
      await onReloadLibrary();
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setError(message || "Could not update metadata.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="batch-layout" onSubmit={handleApply}>
      <div className="batch-main">
        <section className="batch-panel">
          <div className="batch-panel-head">
            <span className="batch-step-badge">XMP</span>
            <div>
              <h2>Edit metadata</h2>
              <p>
                Written to <code>.xmp</code> sidecar files next to each file. Originals are never
                modified.
              </p>
            </div>
            <span className="batch-count-pill">{items.length.toLocaleString()} selected</span>
          </div>

          <div className="batch-metadata-grid">
            <label className="batch-field">
              <span>Capture date &amp; time</span>
              <div className="batch-field-row">
                <input
                  type="datetime-local"
                  step={1}
                  aria-label="Capture date and time"
                  value={dateInput}
                  onChange={(e) => setDateInput(e.target.value)}
                  disabled={busy}
                />
                {dateInput && (
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => setDateInput("")}
                    disabled={busy}
                  >
                    Reset
                  </button>
                )}
              </div>
              <small>Leave blank to keep each item’s existing capture date.</small>
            </label>

            <label className="batch-field">
              <span>Title</span>
              <input
                type="text"
                aria-label="Title"
                placeholder="Leave blank to keep existing title"
                value={clearTitle ? "" : titleInput}
                onChange={(e) => {
                  setClearTitle(false);
                  setTitleInput(e.target.value);
                }}
                disabled={busy || clearTitle}
              />
              <label className="batch-inline-check">
                <input
                  type="checkbox"
                  checked={clearTitle}
                  onChange={(e) => setClearTitle(e.target.checked)}
                  disabled={busy}
                />
                <span>Clear existing title</span>
              </label>
            </label>

            <div className="batch-field">
              <span>Keywords</span>
              <div className="batch-field-row">
                <select
                  aria-label="Keywords action"
                  value={keywordsMode}
                  onChange={(e) =>
                    setKeywordsMode(e.target.value as "add" | "replace" | "remove" | "clear")
                  }
                  disabled={busy}
                >
                  <option value="add">Add</option>
                  <option value="replace">Replace</option>
                  <option value="remove">Remove</option>
                  <option value="clear">Clear all keywords</option>
                </select>
                <input
                  type="text"
                  aria-label="Keywords"
                  placeholder="travel, sunset, japan"
                  value={clearKeywords ? "" : keywordsInput}
                  onChange={(e) => setKeywordsInput(e.target.value)}
                  disabled={busy || clearKeywords}
                />
              </div>
              <small>
                Comma-separated.
                {existingTags.length > 0
                  ? ` Current tags in selection: ${existingTags.slice(0, 8).join(", ")}${existingTags.length > 8 ? "…" : ""}`
                  : " No tags on selected items yet."}
              </small>
            </div>

            <div className="batch-field">
              <span>Location (GPS)</span>
              <div className="batch-field-row">
                <input
                  type="number"
                  step="any"
                  aria-label="Latitude"
                  placeholder="Latitude (e.g. 35.6762)"
                  value={clearLocation ? "" : latInput}
                  onChange={(e) => {
                    setClearLocation(false);
                    setLatInput(e.target.value);
                  }}
                  disabled={busy || clearLocation}
                />
                <input
                  type="number"
                  step="any"
                  aria-label="Longitude"
                  placeholder="Longitude (e.g. 139.6503)"
                  value={clearLocation ? "" : lonInput}
                  onChange={(e) => {
                    setClearLocation(false);
                    setLonInput(e.target.value);
                  }}
                  disabled={busy || clearLocation}
                />
              </div>
              <label className="batch-inline-check">
                <input
                  type="checkbox"
                  checked={clearLocation}
                  onChange={(e) => setClearLocation(e.target.checked)}
                  disabled={busy}
                />
                <span>Clear existing location</span>
              </label>
            </div>
          </div>

          {error && <p className="batch-error">{error}</p>}

          {result && (
            <div className="batch-result-inline" role="status">
              <strong>
                Updated {result.updated} {result.updated === 1 ? "item" : "items"} (
                {result.sidecarsWritten} XMP {result.sidecarsWritten === 1 ? "sidecar" : "sidecars"}{" "}
                written)
              </strong>
              {result.failed.length > 0 && (
                <p className="batch-error">
                  {result.failed.length} failed: {result.failed[0].error}
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      <aside className="batch-summary">
        <div className="batch-panel">
          <h2>Summary</h2>
          <dl className="batch-summary-list">
            <div>
              <dt>Items</dt>
              <dd>{items.length.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>XMP sidecars + catalog</dd>
            </div>
            {clearKeywords && (
              <div>
                <dt>Keywords</dt>
                <dd>
                  Clear all keywords from {items.length} {items.length === 1 ? "file" : "files"}
                </dd>
              </div>
            )}
            {items[0]?.capturedAt && (
              <div>
                <dt>First item date</dt>
                <dd>{formatCapturedDateTime(items[0].capturedAt)}</dd>
              </div>
            )}
          </dl>

          <button
            className="primary-button"
            type="submit"
            disabled={busy || items.length === 0 || !hasAnyChange}
          >
            {busy
              ? "Writing sidecars…"
              : `Apply to ${items.length} ${items.length === 1 ? "file" : "files"}`}
          </button>
          <button className="quiet-button" type="button" onClick={onOpenLibrary} disabled={busy}>
            Back to Library
          </button>
          <p className="batch-note">Only fields you fill in or mark to clear will be changed.</p>
        </div>
      </aside>
    </form>
  );
}
