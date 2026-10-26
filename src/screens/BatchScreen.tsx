import React, { useState } from "react";
import { BatchIcon, CheckIcon, FolderIcon, SparkleIcon, StopIcon } from "../design/components/icons";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { useBatchStore } from "../engine/stores/useBatchStore";
import type { MediaItem } from "../engine/types/media";
import { formatBytesSimple } from "../engine/utils/mediaTypes";

const BATCH_FORMATS: Array<{ value: "source" | "jpeg" | "png" | "webp"; label: string; detail: string }> = [
  { value: "source", label: "Keep source", detail: "Copy, or re-encode in the same format" },
  { value: "jpeg", label: "JPEG", detail: "Smallest files · quality control" },
  { value: "png", label: "PNG", detail: "Lossless · larger files" },
  { value: "webp", label: "WebP", detail: "Lossless · modern and compact" },
];

const BATCH_MAX_DIMENSIONS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "Original size" },
  { value: 4096, label: "Longest edge 4096 px" },
  { value: 2560, label: "Longest edge 2560 px" },
  { value: 2048, label: "Longest edge 2048 px" },
  { value: 1600, label: "Longest edge 1600 px" },
  { value: 1080, label: "Longest edge 1080 px" },
];

function batchExtension(format: string, item: any) {
  if (format === "source") {
    const ext = String(item.extension || "jpg").toLowerCase();
    return ext === "jpeg" ? "jpg" : ext;
  }
  return format === "jpeg" ? "jpg" : format;
}

function sanitizeBatchPart(value: string) {
  const cleaned = value
    .replace(/[/\\:]/g, "-")
    .replace(/[\u0000-\u001f]/g, "-")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return cleaned || "export";
}

function batchDateLabel(ms?: number) {
  const date = new Date(ms || Date.now());
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Mirrors `render_batch_filename` in src-tauri so the preview matches reality. */
function batchPreviewName(item: any, pattern: string, index: number, format: string) {
  const extension = batchExtension(format, item);
  const stem = String(item.name || "export").replace(/\.[^.]+$/, "");
  const template = pattern.trim() || "{name}_{number}";
  const rendered = sanitizeBatchPart(
    template
      .replace(/\{name\}/g, sanitizeBatchPart(stem))
      .replace(/\{number\}/g, String(index + 1).padStart(3, "0"))
      .replace(/\{date\}/g, batchDateLabel(item.capturedAt ?? item.modifiedAt))
      .replace(/\{ext\}/g, extension),
  );
  const dot = rendered.lastIndexOf(".");
  const existing = dot > -1 ? rendered.slice(dot + 1).toLowerCase() : "";
  if (!existing) return `${rendered}.${extension}`;
  if (existing === extension || (extension === "jpg" && existing === "jpeg")) return rendered;
  return `${rendered.slice(0, dot)}.${extension}`;
}

function folderDisplayName(path: string) {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

interface BatchScreenProps {
  items: MediaItem[];
  selectedIds: string[];
  config: ReturnType<typeof useBatchStore.getState>;
  state: ReturnType<typeof useBatchStore.getState>;
  busy: boolean;
  cancelRequested: boolean;
  progress: ReturnType<typeof useBatchStore.getState>["progress"];
  result: ReturnType<typeof useBatchStore.getState>["result"];
  error: ReturnType<typeof useBatchStore.getState>["error"];
  assetUrl: (path: string) => string;
  onSetPattern: ReturnType<typeof useBatchStore.getState>["setPattern"];
  onSetFormat: ReturnType<typeof useBatchStore.getState>["setFormat"];
  onSetQuality: ReturnType<typeof useBatchStore.getState>["setQuality"];
  onSetStripMetadata: ReturnType<typeof useBatchStore.getState>["setStripMetadata"];
  onSetMaxDimension: ReturnType<typeof useBatchStore.getState>["setMaxDimension"];
  onSetStep: ReturnType<typeof useBatchStore.getState>["setStep"];
  onChooseFolder: () => void | Promise<void>;
  onOpenFolder: () => void;
  onExportBatch: () => void | Promise<void>;
  onCancelBatch: () => void | Promise<void>;
  onReset: () => void;
  onOpenLibrary: () => void;
  onClearSelection: () => void;
  onSelectAll: () => void;
  onSetSelection: (ids: string[]) => void;
  onRemoveItem: (id: string) => void;
}

function BatchScreen(props: BatchScreenProps) {
  const [showAllFailures, setShowAllFailures] = React.useState(false);
  const items: any[] = props.items || [];
  const total = items.length;
  const busy = Boolean(props.state.busy);
  const result = props.state.result;
  const progress = props.state.progress;
  const error = props.state.error;
  const cancelRequested = Boolean(props.cancelRequested);
  const stalled = Boolean(props.state.stalled);
  const config = props.config;
  const outputFolder = String(config.outputFolder || "");
  const step = result ? 3 : busy ? 3 : total > 0 ? 2 : 1;

  const folders = items.filter((item) => item.kind === "photo").length;
  const videos = items.filter((item) => item.kind === "video").length;
  const raws = items.filter((item) => item.kind === "raw").length;
  const totalSize = items.reduce((sum, item) => sum + (item.size || 0), 0);
  const converting = config.format !== "source";
  const resizing = Boolean(config.maxDimension);
  const cannotConvert = converting || resizing || config.stripMetadata;
  const unsupportedItems = cannotConvert
    ? items.filter((item) => item.kind === "video" || item.kind === "raw")
    : [];
  const unsupported = unsupportedItems.length;
  const disabledReason = !total
    ? "Select at least one file in the Library."
    : !outputFolder.trim()
      ? "Choose an output folder to enable export."
      : busy
        ? "An export is already running."
        : "";

  const summaryStats = [
    { label: "Files", value: total.toLocaleString() },
    { label: "Source size", value: formatBytesSimple(totalSize) },
    { label: "Format", value: config.format === "source" ? "Keep source" : config.format.toUpperCase() },
    { label: "Resize", value: config.maxDimension ? `≤ ${config.maxDimension} px` : "Original" },
    { label: "Metadata", value: config.stripMetadata ? "Stripped" : "Kept when copied" },
  ];

  const failed = result?.failed || [];
  const cancelled = Boolean(result?.cancelled);
  const skipped = cancelled && result ? Math.max(0, total - result.exported - failed.length) : 0;
  const failedName = (itemId: string) => items.find((item) => item.id === itemId)?.name || "Export";

  const addToken = (token: string) => {
    const pattern = String(config.pattern || "");
    const separator = !pattern || /[_\-. ]$/.test(pattern) ? "" : "_";
    props.onSetPattern(`${pattern}${separator}${token}`);
  };

  const removeUnsupported = () => {
    props.onSetSelection?.(items.filter((item) => item.kind !== "video" && item.kind !== "raw").map((item) => item.id));
  };

  return (
    <div className="feature-page batch-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">BATCH EXPORT</p>
          <h1>Prepare a batch export.</h1>
          <p className="page-subtitle">Rename, convert, resize, or strip metadata. Originals are never modified.</p>
        </div>
        {total > 0 && !busy && (
          <button className="quiet-button" type="button" onClick={props.onOpenLibrary}>
            Change selection
          </button>
        )}
      </div>

      <div className="batch-stepper" aria-label={`Step ${step} of 3`}>
        <span className={step === 1 ? "current" : step > 1 ? "done" : ""}><i>1</i>Select files</span>
        <b />
        <span className={step === 2 ? "current" : step > 2 ? "done" : ""}><i>2</i>Choose actions</span>
        <b />
        <span className={step === 3 ? "current" : ""}><i>3</i>Export copies</span>
      </div>

      {busy ? (
        <div className="batch-progress-panel">
          <div className="batch-progress-head">
            <span className="batch-spinner" aria-hidden="true" />
            <div>
              <b>Exporting copies…</b>
              <small>{progress?.currentFile || "Preparing the first file"}</small>
            </div>
            <span className="batch-progress-count">
              {Math.min(progress?.current || 0, progress?.total || total)} / {progress?.total || total}
            </span>
          </div>
          <div className="batch-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.total ? Math.round(((progress.current || 0) / progress.total) * 100) : 0}>
            <span style={{ width: `${progress?.total ? Math.max(3, Math.round(((progress.current || 0) / progress.total) * 100)) : 4}%` }} />
          </div>
          <div className="batch-progress-actions">
            <button className="quiet-button batch-cancel" type="button" onClick={props.onCancelBatch} disabled={cancelRequested}>
              <StopIcon size={13} /> {cancelRequested ? "Cancelling…" : "Cancel export"}
            </button>
            <span>{cancelRequested ? "Finishing the current file, then stopping." : "Finished copies are kept. The current file finishes before the export stops."}</span>
          </div>
          <p className="batch-note">Files are written one at a time. Keep this window open until the export finishes.</p>
          {stalled && <p className="batch-error">No progress for 15s — export may be stalled. You can cancel and retry.</p>}
        </div>
      ) : result ? (
        <div className="batch-result">
          <div className={`batch-result-hero${failed.length ? " has-failures" : ""}${cancelled ? " is-cancelled" : ""}`}>
            <span className="batch-result-icon">{cancelled ? <StopIcon size={22} /> : <CheckIcon size={24} />}</span>
            <div>
              <p className="eyebrow">{cancelled ? "EXPORT CANCELLED" : result.exported > 0 ? "BATCH COMPLETE" : "EXPORT STOPPED"}</p>
              <h2>
                {cancelled
                  ? `${result.exported.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? "copy" : "copies"} exported before cancelling`
                  : `${result.exported.toLocaleString()} ${result.exported === 1 ? "copy" : "copies"} exported`}
                {failed.length > 0 && <span> · {failed.length} failed</span>}
              </h2>
              <p>{cancelled ? "Stopped before the remaining files were written." : outputFolder || "Output folder"}</p>
            </div>
            <button className="quiet-button" type="button" onClick={props.onOpenFolder} disabled={!outputFolder}>
              <FolderIcon size={14} /> Open folder
            </button>
          </div>

          <div className="batch-result-stats">
            <div><span>Exported</span><b>{result.exported.toLocaleString()}</b></div>
            <div><span>Failed</span><b>{failed.length.toLocaleString()}</b></div>
            {cancelled && <div><span>Skipped</span><b>{skipped.toLocaleString()}</b></div>}
            <div><span>Destination</span><b>{folderDisplayName(outputFolder) || "—"}</b></div>
          </div>

          {result.outputs?.length > 0 && (
            <div className="batch-result-section">
              <div className="batch-preview-head"><b>Written files</b><small>originals untouched</small></div>
              <div className="batch-result-files">
                {result.outputs.slice(0, 8).map((path: string) => (
                  <div key={path} className="batch-result-file">
                    <CheckIcon size={12} />
                    <span title={path}>{path.split("/").pop()}</span>
                  </div>
                ))}
                {result.outputs.length > 8 && <small className="batch-result-more">+{result.outputs.length - 8} more</small>}
              </div>
            </div>
          )}

          {failed.length > 0 && (
            <div className="batch-result-section">
              <div className="batch-preview-head"><b>Couldn’t export</b><small>{failed.length} {failed.length === 1 ? "file" : "files"}</small></div>
              <div className="batch-failure-list">
                {(showAllFailures ? failed : failed.slice(0, 5)).map((failure: any, index: number) => (
                  <div key={`${failure.itemId}-${index}`} className="batch-failure">
                    <b>{failure.itemId ? failedName(failure.itemId) : "Export"}</b>
                    <small>{failure.error}</small>
                  </div>
                ))}
                {failed.length > 5 && (
                  <button className="batch-link-button" type="button" onClick={() => setShowAllFailures((value) => !value)}>
                    {showAllFailures ? "Show fewer" : `Show all ${failed.length} failures`}
                  </button>
                )}
              </div>
            </div>
          )}

          {error && <p className="batch-error">{error}</p>}

          <div className="batch-result-actions">
            <button className="primary-button" type="button" onClick={props.onReset}>{cancelled ? "Review settings" : "Export another batch"}</button>
            <button className="quiet-button" type="button" onClick={props.onOpenLibrary}>Back to Library</button>
          </div>
        </div>
      ) : (
        <div className="batch-layout">
          <div className="batch-main">
            <section className="batch-panel">
              <div className="batch-panel-head">
                <span className="batch-step-badge">1</span>
                <div>
                  <h2>Files in this batch</h2>
                  <p>Pick items in the Library, then return here. Removing a file only removes it from this batch.</p>
                </div>
                {total > 0 && <span className="batch-count-pill">{total.toLocaleString()} selected</span>}
              </div>

              {total === 0 ? (
                <div className="batch-empty">
                  <span className="batch-empty-icon"><BatchIcon size={22} /></span>
                  <b>No files in this batch yet</b>
                  <p>Select items in the Library grid and choose <strong>Batch</strong> from the selection bar, or select everything visible.</p>
                  <div className="batch-empty-actions">
                    <button className="primary-button" type="button" onClick={props.onOpenLibrary}>Go to Library</button>
                    <button className="quiet-button" type="button" onClick={props.onSelectAll}>Select all visible</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="batch-tray">
                    {items.slice(0, 10).map((item, index) => (
                      <button
                        key={item.id}
                        type="button"
                        className="batch-thumb"
                        onClick={() => props.onRemoveItem?.(item.id)}
                        title={`Remove ${item.name} from this batch`}
                      >
                        {item.kind === "photo" ? (
                          <CachedThumbnail itemId={item.id} name={item.name} size={128} />
                        ) : (
                          <span className={`batch-thumb-kind ${item.kind}`}>{item.kind === "raw" ? "RAW" : "VID"}</span>
                        )}
                        <span className="batch-thumb-remove" aria-hidden="true">×</span>
                        <span className="batch-thumb-number">{index + 1}</span>
                      </button>
                    ))}
                    {items.length > 10 && <span className="batch-thumb-more">+{items.length - 10}</span>}
                  </div>
                  <div className="batch-tray-actions">
                    <button className="quiet-button" type="button" onClick={props.onOpenLibrary}>Add more</button>
                    <button className="quiet-button" type="button" onClick={props.onSelectAll}>Select all visible</button>
                    <button className="quiet-button" type="button" onClick={props.onClearSelection}>Clear batch</button>
                  </div>
                  <div className="batch-tray-meta">
                    <span>{folders} photo{folders === 1 ? "" : "s"}</span>
                    {videos > 0 && <span>{videos} video{videos === 1 ? "" : "s"}</span>}
                    {raws > 0 && <span>{raws} RAW</span>}
                    <span>{formatBytesSimple(totalSize)}</span>
                    {unsupported > 0 && (
                      <button type="button" className="batch-tray-unsupported" onClick={removeUnsupported}>
                        {unsupported} unsupported · remove
                      </button>
                    )}
                    <span className="batch-tray-order">Exported in this order</span>
                  </div>
                </>
              )}
            </section>

            <section className="batch-panel">
              <div className="batch-panel-head">
                <span className="batch-step-badge">2</span>
                <div>
                  <h2>Output settings</h2>
                  <p>Choose where copies go, how they are named, and how they are encoded.</p>
                </div>
              </div>

              <div className={`batch-destination${outputFolder ? "" : " is-empty"}`}>
                <span className="batch-destination-icon"><FolderIcon size={17} /></span>
                <div className="batch-destination-copy">
                  <b>{outputFolder ? folderDisplayName(outputFolder) : "No destination chosen"}</b>
                  <small title={outputFolder}>{outputFolder || "Choose a folder for the exported copies."}</small>
                </div>
                <div className="batch-destination-actions">
                  <button className="quiet-button" type="button" onClick={props.onChooseFolder}>Choose…</button>
                  {outputFolder && <button className="quiet-button" type="button" onClick={props.onOpenFolder}>Open</button>}
                </div>
              </div>

              <div className="batch-field">
                <span className="batch-field-label"><span>Filename pattern</span></span>
                <input
                  className="batch-input"
                  value={config.pattern}
                  onChange={(event) => props.onSetPattern(event.target.value)}
                  spellCheck={false}
                  placeholder="{name}_{number}"
                  aria-label="Filename pattern"
                />
                <div className="batch-tokens">
                  <span className="batch-token-label">Insert</span>
                  {["{name}", "{number}", "{date}", "{ext}"].map((token) => (
                    <button key={token} type="button" className="batch-token" onClick={() => addToken(token)}>{token}</button>
                  ))}
                  <button type="button" className="batch-token batch-token-reset" onClick={() => props.onSetPattern("{name}_{number}")}>Reset</button>
                </div>
                <small className="batch-help">Live preview is on the right. Existing files are never overwritten — duplicates get a numeric suffix.</small>
              </div>

              <div className="batch-field">
                <span className="batch-field-label"><span>Output format</span></span>
                <div className="batch-format-grid" role="radiogroup" aria-label="Output format">
                  {BATCH_FORMATS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={config.format === option.value}
                      className={`batch-format-card${config.format === option.value ? " is-selected" : ""}`}
                      onClick={() => props.onSetFormat(option.value)}
                    >
                      <span className="batch-format-name">{option.label}</span>
                      <span className="batch-format-detail">{option.detail}</span>
                    </button>
                  ))}
                </div>
              </div>

              {config.format === "jpeg" ? (
                <div className="batch-field">
                  <span className="batch-field-label"><span>JPEG quality</span><b>{config.quality}%</b></span>
                  <input
                    className="batch-range"
                    type="range"
                    min={40}
                    max={100}
                    value={config.quality}
                    onChange={(event) => props.onSetQuality(Number(event.target.value))}
                    aria-label="JPEG quality"
                  />
                  <small className="batch-help">85–90 is a good balance between file size and detail. PNG and WebP export losslessly.</small>
                </div>
              ) : (
                <p className="batch-note">
                  {config.format === "source"
                    ? "Files that need no changes are copied byte-for-byte. If resizing or metadata stripping is on, they are re-encoded in their original format."
                    : config.format === "webp"
                      ? "WebP exports losslessly here, so the quality slider does not apply."
                      : "PNG exports losslessly, so the quality slider does not apply."}
                </p>
              )}

              <div className="batch-field">
                <span className="batch-field-label"><span>Maximum size</span></span>
                <select
                  className="batch-select"
                  value={config.maxDimension ?? "original"}
                  onChange={(event) => props.onSetMaxDimension(event.target.value === "original" ? null : Number(event.target.value))}
                  aria-label="Maximum image size"
                >
                  {BATCH_MAX_DIMENSIONS.map((option) => (
                    <option key={String(option.value)} value={option.value ?? "original"}>{option.label}</option>
                  ))}
                </select>
                <small className="batch-help">Images are scaled down proportionally; smaller images are never enlarged.</small>
              </div>

              <label className="batch-toggle">
                <input
                  type="checkbox"
                  checked={config.stripMetadata}
                  onChange={(event) => props.onSetStripMetadata(event.target.checked)}
                />
                <span className="batch-switch" aria-hidden="true"><span /></span>
                <span className="batch-toggle-copy">
                  <b>Strip metadata</b>
                  <small>Removes EXIF, GPS, and camera information when a file is re-encoded. Copies that need no changes keep their metadata.</small>
                </span>
              </label>

              <p className="batch-note batch-note-honest">
                <SparkleIcon size={14} />
                <span>Converting, resizing, or stripping always re-encodes the image. RAW and video files can only be copied unchanged in “Keep source” mode.</span>
              </p>

              {(videos > 0 || raws > 0) && unsupported > 0 && (
                <div className="batch-warning">
                  <span>
                    {unsupported} selected {unsupported === 1 ? "file needs" : "files need"} native macOS image support and will be reported as failed unless you choose “Keep source”, turn off resizing, and turn off metadata stripping.
                  </span>
                  <button
                    type="button"
                    className="batch-warning-action"
                    onClick={removeUnsupported}
                  >
                    Remove {unsupported} unsupported
                  </button>
                </div>
              )}
            </section>
          </div>

          <aside className="batch-summary">
            <div className="batch-summary-head">
              <b>Summary</b>
              <span>{total.toLocaleString()} {total === 1 ? "file" : "files"}</span>
            </div>

            <div className="batch-summary-stats">
              {summaryStats.map((stat) => (
                <div key={stat.label}><span>{stat.label}</span><b>{stat.value}</b></div>
              ))}
            </div>

            <div className="batch-summary-preview">
              <div className="batch-preview-head">
                <b>File names</b>
                <small>{total > 6 ? `first 6 of ${total}` : "in order"}</small>
              </div>
              {items.length === 0 ? (
                <div className="batch-preview-empty">
                  <b>Nothing to preview</b>
                  <small>Select files in the Library to see their new names.</small>
                </div>
              ) : (
                items.slice(0, 6).map((item, index) => (
                  <div key={item.id} className="batch-preview-row">
                    <span className="batch-preview-thumb">
                      {item.kind === "photo"
                        ? <CachedThumbnail itemId={item.id} name={item.name} size={128} />
                        : <span>{item.kind === "raw" ? "RAW" : "VID"}</span>}
                    </span>
                    <span className="batch-preview-name">
                      <small title={item.name}>{item.name}</small>
                      <b title={batchPreviewName(item, config.pattern, index, config.format)}>{batchPreviewName(item, config.pattern, index, config.format)}</b>
                    </span>
                  </div>
                ))
              )}
            </div>

            {error && <p className="batch-error">{error}</p>}
            {disabledReason && <p className="batch-hint">{disabledReason}</p>}

            <button
              className="primary-button batch-export"
              type="button"
              onClick={props.onExportBatch}
              disabled={Boolean(disabledReason) || busy}
            >
              <BatchIcon size={15} />
              {total > 0 ? `Export ${total.toLocaleString()} ${total === 1 ? "copy" : "copies"}` : "Export batch"}
            </button>
            <p className="batch-footnote">Originals are never modified, moved, or deleted.</p>
          </aside>
        </div>
      )}
    </div>
  );
}

/** Fan out up to three album photos like a loose stack of prints. */

export default BatchScreen;
