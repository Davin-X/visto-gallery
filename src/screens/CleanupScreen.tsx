import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../design/hooks/useFocusTrap";
import { useKeyboard } from "../engine/hooks/useKeyboard";
import {
  CheckIcon,
  ChevronDownIcon,
  DuplicatesIcon,
  InfoIcon,
  ShieldIcon,
  SparkleIcon,
  TrashIcon,
} from "../design/components/icons";
import { MiddleTruncate } from "../design/components/MiddleTruncate";
import { tauri } from "../engine/commands/tauri";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import {
  JUNK_CATEGORY_COPY,
  JUNK_CATEGORY_ORDER,
  JUNK_TIER_COPY,
  SKIP_REASON_LABEL,
  allItems,
  allSkips,
  allSelected,
  isInUse,
  junkSplit,
  lastUsedLabel,
  percent,
  pruneSelection,
  recentlyUsed,
  regenerableIds,
  reportOf,
  runDateLabel,
  selectedBytes,
  someSelected,
  sumBytes,
  totalBytes,
  type CategoryScan,
} from "../engine/utils/junk";
import type {
  CleanupOverview,
  ErrorCode,
  JunkCategory,
  JunkCleanResult,
  JunkIgnoredItem,
  JunkItem,
  JunkSkip,
} from "../engine/types/commands";

interface CleanupScreenProps {
  showNotice: (text: string, code?: ErrorCode) => void;
  showErrorNotice: (error: unknown, prefix?: string) => void;
  /** Jump to the Duplicates screen from the library card. */
  onOpenDuplicates?: () => void;
}

type Scans = Record<JunkCategory, CategoryScan>;

const IDLE: Scans = {
  xcode: { state: "idle" },
  packages: { state: "idle" },
  projects: { state: "idle" },
  downloads: { state: "idle" },
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** "+32%", or "<1%" for a gain too small to round up. */
function growthLabel(gain: number, free: number): string {
  const share = (gain / free) * 100;
  return share < 1 ? "+<1%" : `+${Math.round(share)}%`;
}

/** Rows shown per category before "Show more"; the largest come first. */
const ROW_LIMIT = 8;

function MoreRowsButton({
  hidden,
  open,
  selected,
  onToggle,
}: {
  hidden: JunkItem[];
  open: boolean;
  selected: ReadonlySet<string>;
  onToggle: () => void;
}) {
  const hiddenSelected = hidden.filter((item) => selected.has(item.id)).length;
  return (
    <button type="button" className="cleanup-more" onClick={onToggle} aria-expanded={open}>
      <ChevronDownIcon size={12} className={open ? "is-open" : ""} />
      {open
        ? "Show fewer"
        : `Show ${plural(hidden.length, "more item", "more items")} · ${formatBytesSimple(
            totalBytes(hidden),
          )}`}
      {!open && hiddenSelected > 0 && (
        <span className="cleanup-more-selected">{hiddenSelected} selected</span>
      )}
    </button>
  );
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return typeof error === "string" ? error : "The scan failed.";
}

/** A checkbox that can show the mixed state for a partly selected group. */
function GroupCheckbox({
  checked,
  mixed,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed && !checked;
  }, [checked, mixed]);
  return (
    <label className="cleanup-check">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
      />
    </label>
  );
}

/**
 * System and developer cleanup. Scans run per category in parallel and the
 * screen fills in as each one returns. The scan and the deletion both live
 * in Rust: this screen only ever sends back the ids of rows it was given,
 * and the backend re-validates each one before trashing it.
 */
export default function CleanupScreen({
  showNotice,
  showErrorNotice,
  onOpenDuplicates,
}: CleanupScreenProps) {
  const [scans, setScans] = useState<Scans>(IDLE);
  const [overview, setOverview] = useState<CleanupOverview | null>(null);
  const [ignored, setIgnored] = useState<JunkIgnoredItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [cleaning, setCleaning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [lastResult, setLastResult] = useState<JunkCleanResult | null>(null);
  const [expanded, setExpanded] = useState<Set<JunkCategory>>(() => new Set());
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const generation = useRef(0);
  const startedRef = useRef(false);
  useFocusTrap(confirming, confirmRef);

  const items = useMemo(() => allItems(scans), [scans]);
  const skips = useMemo(() => allSkips(scans), [scans]);
  const split = useMemo(() => junkSplit(items, skips), [items, skips]);
  const scanning = JUNK_CATEGORY_ORDER.some((category) => scans[category].state === "scanning");
  const scannedOnce = JUNK_CATEGORY_ORDER.some(
    (category) => scans[category].state === "done" || scans[category].state === "failed",
  );
  const total = useMemo(() => totalBytes(items), [items]);
  // "In use" is jargon; say the actual reason on the summary line.
  const inUseSkips = useMemo(() => skips.filter(isInUse), [skips]);
  const inUseReason = (() => {
    const running = inUseSkips.some((skip) => skip.reason === "appRunning");
    const recent = inUseSkips.some((skip) => skip.reason === "recentActivity");
    if (running && recent) return "a tool is running or just changed";
    if (running) return "a tool is running";
    return "it just changed";
  })();
  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  );
  // Skipped rows can be included by name, but only the ones that are merely
  // in use: a Git-tracked or sensitive row is never selectable.
  const selectedSkips = useMemo(
    () => skips.filter((skip) => selected.has(skip.id)),
    [skips, selected],
  );
  const selectedCount = selectedItems.length + selectedSkips.length;
  const pendingBytes = useMemo(
    () => selectedBytes(items, selected) + sumBytes(selectedSkips),
    [items, selected, selectedSkips],
  );
  const forcedIds = useMemo(
    () => selectedSkips.filter(isInUse).map((skip) => skip.id),
    [selectedSkips],
  );
  const rebuildSelected = selectedItems.filter((item) => item.tier === "rebuildable");
  const regenerable = useMemo(() => regenerableIds(items), [items]);
  const busy = scanning || cleaning;

  const refreshSideData = useCallback(() => {
    void tauri.junk
      .overview()
      .then(setOverview)
      .catch(() => setOverview(null));
    void tauri.junk
      .listIgnored()
      .then(setIgnored)
      .catch(() => setIgnored([]));
  }, []);

  const scanAll = useCallback(async () => {
    const run = ++generation.current;
    setScans((current) => {
      const next = { ...current };
      for (const category of JUNK_CATEGORY_ORDER) {
        next[category] = { state: "scanning", previous: reportOf(current[category]) };
      }
      return next;
    });
    refreshSideData();
    await Promise.all(
      JUNK_CATEGORY_ORDER.map(async (category) => {
        let result: CategoryScan;
        try {
          result = { state: "done", report: await tauri.junk.scan(category) };
        } catch (error) {
          result = { state: "failed", message: errorText(error) };
        }
        if (generation.current !== run) return;
        setScans((current) => ({ ...current, [category]: result }));
      }),
    );
  }, [refreshSideData]);

  // Once a scan settles, forget selected ids that are no longer listed, and
  // any skipped row that is no longer merely in use.
  useEffect(() => {
    if (scanning) return;
    setSelected((current) => {
      const next = pruneSelection(current, [...items, ...skips.filter(isInUse)]);
      return next.size === current.size ? current : next;
    });
  }, [items, scanning, skips]);

  // One read-only scan when the screen first opens; Rescan is explicit after.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void scanAll();
  }, [scanAll]);

  useKeyboard([
    useCallback(
      (event: KeyboardEvent) => {
        if (event.key !== "Escape" || !confirming) return;
        event.preventDefault();
        setConfirming(false);
      },
      [confirming],
    ),
  ]);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((groupItems: JunkItem[]) => {
    setSelected((current) => {
      const next = new Set(current);
      const everySelected = groupItems.every((item) => next.has(item.id));
      for (const item of groupItems) {
        if (everySelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  }, []);

  const selectRegenerable = useCallback(() => {
    setSelected(new Set(regenerable));
  }, [regenerable]);

  const runClean = useCallback(async () => {
    setConfirming(false);
    setCleaning(true);
    try {
      // `forcedIds` is the explicit "clean it anyway" list; Rust waives only
      // the busy and recent-activity checks for those ids.
      const result = await tauri.junk.clean([...selected], forcedIds);
      setLastResult(result);
      setSelected(new Set());
      // Success is reported by the banner on the page; a toast only adds
      // something when part of the cleanup was refused.
      if (result.removedItems === 0) {
        showNotice(result.failed[0]?.message ?? "Nothing could be moved to the Trash.");
      } else if (result.failed.length > 0) {
        showNotice(`${plural(result.failed.length, "item")} could not be moved to the Trash.`);
      }
      await scanAll();
    } catch (error) {
      showErrorNotice(error, "Could not clean the selected items");
    } finally {
      setCleaning(false);
    }
  }, [forcedIds, scanAll, selected, showErrorNotice, showNotice]);

  const reveal = useCallback(
    (id: string) => {
      void tauri.junk.reveal(id).catch((error: unknown) => {
        showErrorNotice(error, "Could not show the item in Finder");
      });
    },
    [showErrorNotice],
  );

  const setNeverClean = useCallback(
    async (id: string, label: string, never: boolean) => {
      try {
        await tauri.junk.setIgnored(id, label, never);
        if (never) {
          setSelected((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
          showNotice(`${label} will never be offered for cleaning.`);
        } else {
          showNotice(`${label} can be cleaned again.`);
        }
        await scanAll();
      } catch (error) {
        showErrorNotice(error, "Could not update the Never clean list");
      }
    },
    [scanAll, showErrorNotice, showNotice],
  );

  const setPersonalFolders = useCallback(
    async (enabled: boolean) => {
      try {
        await tauri.junk.setPersonalFolders(enabled);
        setOverview((current) => (current ? { ...current, personalFolders: enabled } : current));
        await scanAll();
      } catch (error) {
        showErrorNotice(error, "Could not change which folders are scanned");
      }
    },
    [scanAll, showErrorNotice],
  );

  const openTrash = useCallback(() => {
    void tauri.junk.openTrash().catch((error: unknown) => {
      showErrorNotice(error, "Could not open the Trash");
    });
  }, [showErrorNotice]);

  // A category that could not be fully read can hide junk, so an empty
  // result is only "tidy" when every scan was complete (or turned off).
  const incomplete = JUNK_CATEGORY_ORDER.some((category) => {
    const scan = scans[category];
    if (scan.state === "failed") return true;
    const status = reportOf(scan)?.status;
    return status === "partial" || status === "unavailable";
  });
  const emptyResult = items.length === 0 && scannedOnce && !scanning;

  const headingSubtitle = (() => {
    if (!scannedOnce) return "Looking through Xcode, developer caches and your projects…";
    if (emptyResult) {
      return incomplete
        ? "Nothing found in what could be read — some folders could not be scanned."
        : "Nothing to clean — your Mac is already tidy.";
    }
    return `${plural(items.length, "item")} across ${
      JUNK_CATEGORY_ORDER.filter((category) => (reportOf(scans[category])?.items.length ?? 0) > 0)
        .length
    } of ${JUNK_CATEGORY_ORDER.length} areas · everything goes to the Trash first`;
  })();

  const disk = overview?.disk ?? null;
  const personalFolders = overview?.personalFolders ?? false;
  // The free-space preview follows the selection, or everything when nothing
  // is selected yet.
  const gainEntries =
    selectedCount > 0
      ? [
          ...selectedItems.map((item) => ({ category: item.category, bytes: item.bytes })),
          ...selectedSkips.map((skip) => ({ category: skip.category, bytes: skip.bytes })),
        ]
      : items.map((item) => ({ category: item.category, bytes: item.bytes }));
  const gainByCategory = JUNK_CATEGORY_ORDER.map((category) => ({
    category,
    bytes: sumBytes(gainEntries.filter((entry) => entry.category === category)),
  }));
  const gain = sumBytes(gainEntries);
  const freeAfter = disk ? Math.min(disk.totalBytes, disk.availableBytes + gain) : 0;
  const library = overview?.library ?? null;
  const history = overview?.history ?? [];

  return (
    <div className="feature-page cleanup-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">STORAGE</p>
          <h1>Clean up your Mac</h1>
          <p className="page-subtitle">{headingSubtitle}</p>
        </div>
        <div className="cleanup-heading-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => void scanAll()}
            disabled={busy}
          >
            {scanning ? (
              <>
                <span className="spinner cleanup-button-spinner" aria-hidden="true" /> Scanning…
              </>
            ) : (
              "Rescan"
            )}
          </button>
        </div>
      </div>

      {/* Hero: how much, and where it sits on the disk ---------------- */}
      <section className="cleanup-hero" aria-label="Cleanup summary">
        <div className="cleanup-hero-figure">
          <p className="cleanup-hero-label">
            {scanning
              ? "Found so far"
              : emptyResult
                ? incomplete
                  ? "Nothing found"
                  : "All tidy"
                : "Junk found"}
          </p>
          <p className="cleanup-hero-number" aria-live="polite">
            {emptyResult && !incomplete ? (
              <span className="cleanup-hero-tidy">
                <CheckIcon size={26} /> 0 B
              </span>
            ) : (
              formatBytesSimple(split.total)
            )}
          </p>
          {split.total > 0 && (
            <p className="cleanup-hero-split">
              <span className="is-ready">
                <i aria-hidden="true" /> {formatBytesSimple(split.ready)} ready to clean
              </span>
              {split.inUse > 0 && (
                <span
                  className="is-in-use"
                  title="A tool is running or the folder changed in the last few minutes, so cleaning it could break something. Choose it on its row to clean it anyway."
                >
                  <i aria-hidden="true" /> {formatBytesSimple(split.inUse)} skipped — {inUseReason}
                </span>
              )}
              {split.heldBack > 0 && (
                <span
                  className="is-held-back"
                  title="A safety rule keeps this out: Git-tracked files, a private key, a folder that cannot be read, or Never clean."
                >
                  <i aria-hidden="true" /> {formatBytesSimple(split.heldBack)} held back for safety
                </span>
              )}
            </p>
          )}
          {regenerable.length > 0 && (
            <button
              type="button"
              className="quiet-button cleanup-hero-select"
              onClick={selectRegenerable}
              disabled={busy}
              title="Only items tagged Regenerates: caches and build output that come back on their own. Nothing that would need a rebuild."
            >
              <SparkleIcon size={14} /> Select everything that regenerates
            </button>
          )}
        </div>

        {disk && disk.totalBytes > 0 && (
          <div className="cleanup-disk">
            <div className="cleanup-disk-head">
              <span className="cleanup-disk-label">Free space</span>
              <span className="cleanup-disk-change">
                <b>{formatBytesSimple(disk.availableBytes)}</b>
                <span className="cleanup-disk-arrow" aria-hidden="true">
                  →
                </span>
                <b className="is-after">{formatBytesSimple(freeAfter)}</b>
                {gain > 0 && disk.availableBytes > 0 && (
                  <em>{growthLabel(gain, disk.availableBytes)}</em>
                )}
              </span>
            </div>
            <div
              className="cleanup-disk-bar"
              role="img"
              aria-label={`Free space goes from ${formatBytesSimple(
                disk.availableBytes,
              )} to ${formatBytesSimple(freeAfter)}`}
            >
              <span
                className="cleanup-disk-seg is-free-now"
                style={{ width: percent(disk.availableBytes, freeAfter) }}
              />
              {gainByCategory.map(({ category, bytes }) =>
                bytes > 0 ? (
                  <span
                    key={category}
                    className={`cleanup-disk-seg is-gain is-${category}`}
                    style={{ width: percent(bytes, freeAfter) }}
                    title={`${JUNK_CATEGORY_COPY[category].title}: +${formatBytesSimple(bytes)}`}
                  />
                ) : null,
              )}
            </div>
            <ul className="cleanup-disk-legend">
              <li>
                <i className="is-free-now" /> Free now
              </li>
              {gainByCategory.map(({ category, bytes }) =>
                bytes > 0 ? (
                  <li key={category}>
                    <i className={`is-${category}`} /> {JUNK_CATEGORY_COPY[category].short}{" "}
                    <b>+{formatBytesSimple(bytes)}</b>
                  </li>
                ) : null,
              )}
            </ul>
            <p className="cleanup-disk-note">
              {selectedCount > 0 ? "With your selection" : "If you clean everything listed"}, once
              the Trash is emptied · {formatBytesSimple(disk.totalBytes)} disk, counted like Finder
            </p>
          </div>
        )}
      </section>

      {/* One card per category --------------------------------------- */}
      <div className="cleanup-cards">
        {JUNK_CATEGORY_ORDER.map((category) => {
          const scan = scans[category];
          const report = reportOf(scan);
          const count = report?.items.length ?? 0;
          const skipped = report?.skips.length ?? 0;
          const bytes = report?.totalBytes ?? 0;
          let status: React.ReactNode;
          if (scan.state === "scanning" || scan.state === "idle") {
            status = (
              <>
                <span className="spinner" aria-hidden="true" /> Scanning…
              </>
            );
          } else if (scan.state === "failed") {
            status = <span className="is-warning">Couldn’t scan</span>;
          } else if (report?.status === "off") {
            status = "Off · turn on below";
          } else if (report?.status === "unavailable") {
            status = <span className="is-warning">No access</span>;
          } else if (count === 0) {
            status = skipped > 0 ? `${skipped} skipped` : "Nothing to clean";
          } else {
            status = (
              <>
                {plural(count, "item")}
                {skipped > 0 && <span className="cleanup-card-dim"> · {skipped} skipped</span>}
                {report?.status === "partial" && <span className="is-warning"> · partial</span>}
              </>
            );
          }
          return (
            <button
              type="button"
              key={category}
              className={`cleanup-card is-${category}`}
              onClick={() =>
                document
                  .getElementById(`cleanup-${category}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              disabled={
                (count === 0 && skipped === 0 && !report?.statusMessage) || report?.status === "off"
              }
            >
              <span className="cleanup-card-title">
                <i className={`cleanup-dot is-${category}`} />
                {JUNK_CATEGORY_COPY[category].title}
              </span>
              <span className="cleanup-card-bytes">{formatBytesSimple(bytes)}</span>
              <span className="cleanup-card-meter" aria-hidden="true">
                <span style={{ width: percent(bytes, total) }} />
              </span>
              <span className="cleanup-card-status">{status}</span>
            </button>
          );
        })}
      </div>

      {overview && (
        <label className="cleanup-scope">
          <input
            type="checkbox"
            role="switch"
            checked={personalFolders}
            disabled={busy}
            onChange={(event) => void setPersonalFolders(event.target.checked)}
          />
          <span className="cleanup-switch" aria-hidden="true" />
          <span className="cleanup-scope-copy">
            <b>Also scan Documents, Desktop and Downloads</b>
            <span>
              Finds projects there and installers older than 30 days. macOS asks once for access to
              each folder.
            </span>
          </span>
        </label>
      )}

      {lastResult && (lastResult.removedItems > 0 || lastResult.failed.length > 0) && (
        <div
          className={`cleanup-result${lastResult.removedItems === 0 ? " is-failed" : ""}`}
          role="status"
        >
          <span className="cleanup-result-icon">
            {lastResult.removedItems > 0 ? <CheckIcon size={16} /> : <InfoIcon size={16} />}
          </span>
          <div className="cleanup-result-copy">
            {lastResult.removedItems > 0 ? (
              <>
                <b>
                  Moved {plural(lastResult.removedItems, "item")} ·{" "}
                  {formatBytesSimple(lastResult.movedBytes)} to the Trash
                </b>
                <span>
                  The disk gets the space back when you empty the Trash. Until then, Put Back
                  restores anything.
                </span>
              </>
            ) : (
              <b>Nothing was moved.</b>
            )}
            {lastResult.failed.length > 0 && (
              <ul className="cleanup-result-failures">
                {lastResult.failed.slice(0, 4).map((failure) => (
                  <li key={failure.id}>{failure.message}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="cleanup-result-actions">
            {lastResult.removedItems > 0 && (
              <button type="button" className="quiet-button" onClick={openTrash}>
                Open Trash
              </button>
            )}
            <button
              type="button"
              className="dialog-close"
              aria-label="Dismiss"
              onClick={() => setLastResult(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Category sections ------------------------------------------- */}
      {JUNK_CATEGORY_ORDER.map((category) => {
        const scan = scans[category];
        const report = reportOf(scan);
        const groupItems = report?.items ?? [];
        const skips = report?.skips ?? [];
        const statusMessage =
          scan.state === "failed" ? scan.message : (report?.statusMessage ?? null);
        if (report?.status === "off") return null;
        if (groupItems.length === 0 && skips.length === 0 && !statusMessage) return null;
        const every = allSelected(groupItems, selected);
        const copy = JUNK_CATEGORY_COPY[category];
        return (
          <section
            className={`cleanup-group is-${category}`}
            key={category}
            id={`cleanup-${category}`}
            aria-labelledby={`cleanup-${category}-title`}
          >
            <header className="cleanup-group-head">
              {groupItems.length > 0 ? (
                <GroupCheckbox
                  checked={every}
                  mixed={someSelected(groupItems, selected)}
                  disabled={cleaning}
                  label={`Select all ${copy.title}`}
                  onChange={() => toggleGroup(groupItems)}
                />
              ) : (
                <span className="cleanup-check" />
              )}
              <i className={`cleanup-dot is-${category}`} />
              <div className="cleanup-group-copy">
                <h2 id={`cleanup-${category}-title`}>{copy.title}</h2>
                <p>{copy.blurb}</p>
              </div>
              <span className="cleanup-group-bytes">
                {formatBytesSimple(report?.totalBytes ?? 0)}
              </span>
            </header>

            {statusMessage && (
              <p className="cleanup-group-status">
                <InfoIcon size={13} /> {statusMessage}
              </p>
            )}

            {report?.note && <p className="cleanup-group-note">{report.note}</p>}

            {groupItems.length > 0 && (
              <ul className="cleanup-list">
                {(expanded.has(category) ? groupItems : groupItems.slice(0, ROW_LIMIT)).map(
                  (item) => (
                    <CleanupRow
                      key={item.id}
                      item={item}
                      selected={selected.has(item.id)}
                      disabled={cleaning}
                      onToggle={toggle}
                      onReveal={reveal}
                      onNeverClean={(row) => void setNeverClean(row.id, row.label, true)}
                    />
                  ),
                )}
              </ul>
            )}

            {groupItems.length > ROW_LIMIT && (
              <MoreRowsButton
                hidden={groupItems.slice(ROW_LIMIT)}
                open={expanded.has(category)}
                selected={selected}
                onToggle={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(category)) next.delete(category);
                    else next.add(category);
                    return next;
                  })
                }
              />
            )}

            {skips.length > 0 && (
              <SkippedList
                skips={skips}
                selected={selected}
                onReveal={reveal}
                onForce={toggle}
                onAllow={(skip) => void setNeverClean(skip.id, skip.label, false)}
              />
            )}
          </section>
        );
      })}

      {/* Library, history and exclusions ----------------------------- */}
      <div className="cleanup-insights">
        {library && library.totalItems > 0 && (
          <section className="cleanup-panel" aria-labelledby="cleanup-library-title">
            <h2 id="cleanup-library-title">Your photo library</h2>
            <p className="cleanup-panel-lede">
              Caches grow back. The space you keep is usually in large originals.
            </p>
            <p className="cleanup-panel-number">{formatBytesSimple(library.totalBytes)}</p>
            <div className="cleanup-library-bar" aria-hidden="true">
              <span
                className="is-photo"
                style={{ width: percent(library.photoBytes, library.totalBytes) }}
              />
              <span
                className="is-video"
                style={{ width: percent(library.videoBytes, library.totalBytes) }}
              />
              <span
                className="is-raw"
                style={{ width: percent(library.rawBytes, library.totalBytes) }}
              />
            </div>
            <ul className="cleanup-library-legend">
              <li>
                <i className="is-photo" /> Photos {formatBytesSimple(library.photoBytes)}
              </li>
              <li>
                <i className="is-video" /> Videos {formatBytesSimple(library.videoBytes)}
              </li>
              {library.rawBytes > 0 && (
                <li>
                  <i className="is-raw" /> RAW {formatBytesSimple(library.rawBytes)}
                </li>
              )}
            </ul>
            {library.largeVideoCount > 0 && (
              <p className="cleanup-panel-note">
                {plural(library.largeVideoCount, "video")} over 1 GB take{" "}
                {formatBytesSimple(library.largeVideoBytes)}.
              </p>
            )}
            {onOpenDuplicates && (
              <button type="button" className="quiet-button" onClick={onOpenDuplicates}>
                <DuplicatesIcon size={14} /> Find duplicates
              </button>
            )}
          </section>
        )}

        <section className="cleanup-panel" aria-labelledby="cleanup-history-title">
          <h2 id="cleanup-history-title">Recent cleanups</h2>
          {history.length === 0 ? (
            <p className="cleanup-panel-lede">Cleanups you run appear here with what they moved.</p>
          ) : (
            <ul className="cleanup-history">
              {history.map((run) => (
                <li key={`${run.finishedAt}-${run.movedBytes}`}>
                  <span>{runDateLabel(run.finishedAt)}</span>
                  <span>{plural(run.removedItems, "item")}</span>
                  <b>{formatBytesSimple(run.movedBytes)}</b>
                </li>
              ))}
            </ul>
          )}
          {ignored.length > 0 && (
            <details className="cleanup-ignored">
              <summary>
                <ShieldIcon size={13} /> Never clean · {ignored.length}
                <ChevronDownIcon size={12} />
              </summary>
              <ul>
                {ignored.map((entry) => (
                  <li key={entry.id}>
                    <span>{entry.label}</span>
                    <button
                      type="button"
                      className="cleanup-link-button"
                      onClick={() => void setNeverClean(entry.id, entry.label, false)}
                    >
                      Allow
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="cleanup-promise">
            <ShieldIcon size={13} /> Items go to the Trash, never straight to deletion. Every row is
            checked again when you clean, and nothing inside a library folder is ever offered.
          </p>
        </section>
      </div>

      {selectedCount > 0 && (
        <div className="cleanup-selection-bar" role="region" aria-label="Cleanup selection">
          <div className="cleanup-selection-copy">
            <b>{plural(selectedCount, "item")}</b>
            <span>{formatBytesSimple(pendingBytes)} to the Trash</span>
            {rebuildSelected.length > 0 && <em>{rebuildSelected.length} need a rebuild</em>}
            {selectedSkips.length > 0 && (
              <em className="is-in-use">{selectedSkips.length} in use</em>
            )}
          </div>
          <div className="cleanup-selection-actions">
            <button
              type="button"
              className="quiet-button"
              onClick={() => setSelected(new Set())}
              disabled={cleaning}
            >
              Clear
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              <TrashIcon size={14} /> {cleaning ? "Moving…" : "Move to Trash"}
            </button>
          </div>
        </div>
      )}

      {confirming &&
        createPortal(
          <div
            className="dialog-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setConfirming(false);
            }}
          >
            <div
              ref={confirmRef}
              className="album-dialog cleanup-confirm"
              role="dialog"
              aria-modal="true"
              aria-labelledby="cleanup-confirm-title"
            >
              <div className="dialog-heading">
                <div>
                  <p className="eyebrow">CLEANUP</p>
                  <h2 id="cleanup-confirm-title">
                    Move {plural(selectedCount, "item")} to the Trash?
                  </h2>
                </div>
                <button
                  type="button"
                  className="dialog-close"
                  aria-label="Close"
                  onClick={() => setConfirming(false)}
                >
                  ×
                </button>
              </div>
              <p className="dialog-hint">
                This moves {formatBytesSimple(pendingBytes)} to the Trash. The disk gets the space
                back when you empty it; until then Put Back restores everything.
              </p>
              {selectedSkips.length > 0 && (
                <div className="cleanup-confirm-caution is-in-use">
                  <p>
                    {plural(selectedSkips.length, "item")} looked in use when the folder was
                    scanned, and you chose to clean {selectedSkips.length === 1 ? "it" : "them"}{" "}
                    anyway:
                  </p>
                  <ul>
                    {selectedSkips.slice(0, 4).map((skip) => (
                      <li key={skip.id}>
                        {skip.label} — {SKIP_REASON_LABEL[skip.reason]}
                      </li>
                    ))}
                    {selectedSkips.length > 4 && <li>and {selectedSkips.length - 4} more</li>}
                  </ul>
                </div>
              )}
              {rebuildSelected.length > 0 && (
                <div className="cleanup-confirm-caution">
                  <p>{rebuildSelected.length} of these will need rebuilding or re-downloading:</p>
                  <ul>
                    {rebuildSelected.slice(0, 4).map((item) => (
                      <li key={item.id}>{item.label}</li>
                    ))}
                    {rebuildSelected.length > 4 && <li>and {rebuildSelected.length - 4} more</li>}
                  </ul>
                </div>
              )}
              <div className="dialog-actions">
                <button type="button" className="quiet-button" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void runClean()}
                  autoFocus
                >
                  Move to Trash
                </button>
              </div>
            </div>
          </div>,
          // Inside .app-frame, where the theme tokens live; outside it the
          // dialog renders without its background and text colours.
          document.querySelector<HTMLElement>(".app-frame") ?? document.body,
        )}
    </div>
  );
}

function CleanupRow({
  item,
  selected,
  disabled,
  onToggle,
  onReveal,
  onNeverClean,
}: {
  item: JunkItem;
  selected: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
  onReveal: (id: string) => void;
  onNeverClean: (item: JunkItem) => void;
}) {
  const tier = JUNK_TIER_COPY[item.tier];
  return (
    <li className={`cleanup-row${selected ? " is-selected" : ""}`}>
      <label className="cleanup-check">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={() => onToggle(item.id)}
          aria-label={`Select ${item.label}`}
        />
      </label>
      <div className="cleanup-row-main">
        <div className="cleanup-row-title">
          <span className="cleanup-row-name">{item.label}</span>
          {item.extraPaths.length > 0 && (
            <span className="cleanup-row-folders">· {item.extraPaths.length + 1} folders</span>
          )}
          <span className={`cleanup-tier-chip is-${item.tier}`} title={tier.hint}>
            {tier.label}
          </span>
          {item.category === "projects" && recentlyUsed(item) && (
            <span className="cleanup-tier-chip is-active" title="Used in the last week">
              Active this week
            </span>
          )}
        </div>
        <p className="cleanup-row-detail">{item.detail}</p>
        <MiddleTruncate text={item.path} className="cleanup-row-path" />
        {item.extraPaths.map((extra) => (
          <MiddleTruncate key={extra} text={extra} className="cleanup-row-path" />
        ))}
      </div>
      <div className="cleanup-row-side">
        <span className="cleanup-row-size">{formatBytesSimple(item.bytes)}</span>
        <span className="cleanup-row-meta">
          {plural(item.fileCount, "file")} · {lastUsedLabel(item.lastUsedAt)}
        </span>
        {item.sharedBytes > 0 && (
          <span
            className="cleanup-row-meta"
            title="Hard-linked from elsewhere: removing this copy does not free it"
          >
            +{formatBytesSimple(item.sharedBytes)} shared
          </span>
        )}
        <span className="cleanup-row-actions">
          <button
            type="button"
            className="cleanup-link-button"
            onClick={() => onReveal(item.id)}
            title={`Show ${item.label} in Finder`}
          >
            Show
          </button>
          <button
            type="button"
            className="cleanup-link-button"
            onClick={() => onNeverClean(item)}
            title="Never offer this item again"
          >
            Never clean
          </button>
        </span>
      </div>
    </li>
  );
}

function SkippedList({
  skips,
  selected,
  onReveal,
  onForce,
  onAllow,
}: {
  skips: JunkSkip[];
  selected: ReadonlySet<string>;
  onReveal: (id: string) => void;
  onForce: (id: string) => void;
  onAllow: (skip: JunkSkip) => void;
}) {
  const reasons = [...new Set(skips.map((skip) => SKIP_REASON_LABEL[skip.reason]))];
  const anyOverridable = skips.some(isInUse);
  return (
    <details className="cleanup-skips">
      <summary>
        <ChevronDownIcon size={12} />
        <span>
          {plural(skips.length, "item")} skipped
          <span className="cleanup-skips-why"> · {reasons.join(", ")}</span>
        </span>
        {anyOverridable && (
          <span className="cleanup-skips-hint">Tick a row to include it anyway</span>
        )}
        <span className="cleanup-skips-bytes">{formatBytesSimple(sumBytes(skips))} held back</span>
      </summary>
      <ul>
        {skips.map((skip) => {
          const included = selected.has(skip.id);
          const overridable = isInUse(skip);
          // A skipped row is the same row as a cleanable one. The checkbox is
          // the only "include it anyway" control: ticking it is the override,
          // and it is dead for a structural reason so one click cannot undo a
          // safety rule or a Never clean decision.
          return (
            <li
              key={skip.id}
              className={`cleanup-row cleanup-row-skip${included ? " is-included" : ""}`}
            >
              <label
                className="cleanup-check"
                title={
                  overridable
                    ? "Tick to include it in the next cleanup anyway"
                    : skip.reason === "neverClean"
                      ? "Marked Never clean — press Allow first"
                      : "A safety rule keeps this out of cleaning"
                }
              >
                <input
                  type="checkbox"
                  checked={included}
                  disabled={!overridable}
                  onChange={() => onForce(skip.id)}
                  aria-label={
                    overridable ? `Include ${skip.label} anyway` : `${skip.label} is held back`
                  }
                />
              </label>
              <div className="cleanup-row-main">
                <div className="cleanup-row-title">
                  <span className="cleanup-row-name">{skip.label}</span>
                  <span className={`cleanup-tier-chip is-${skip.reason}`}>
                    {SKIP_REASON_LABEL[skip.reason]}
                  </span>
                </div>
                <p className="cleanup-row-detail">{skip.message}</p>
              </div>
              <div className="cleanup-row-side">
                <span className="cleanup-row-size">{formatBytesSimple(skip.bytes)}</span>
                <span className="cleanup-row-actions">
                  <button
                    type="button"
                    className="cleanup-link-button"
                    onClick={() => onReveal(skip.id)}
                    title={`Show ${skip.label} in Finder`}
                  >
                    Show
                  </button>
                  {skip.reason === "neverClean" && (
                    <button
                      type="button"
                      className="cleanup-link-button"
                      onClick={() => onAllow(skip)}
                      title="Allow this to be offered for cleaning again"
                    >
                      Allow
                    </button>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
