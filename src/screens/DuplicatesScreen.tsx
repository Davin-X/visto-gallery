import React, { useState, useMemo, useEffect, useRef } from "react";
import { DuplicatesIcon } from "../design/components/icons";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { KindBadge } from "../design/components/KindBadge";
import { useDraftTransforms } from "../engine/stores/useEditStore";
import type { MediaItem, DuplicateGroup } from "../engine/types/media";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import { draftImageStyle } from "../engine/utils/draftImage";

interface DuplicatesScreenProps {
  groups: DuplicateGroup[];
  items: MediaItem[];
  onScan: () => void | Promise<void>;
  onClear: () => void;
  busy: boolean;
  progress: {
    phase?: string;
    processed?: number;
    total?: number;
    currentFile?: string;
    bytesProcessed?: number;
    bytesTotal?: number;
  } | null;
  assetUrl: (path: string) => string;
  onRequestDeleteItems: (ids: string[]) => void;
  onHideIds: (ids: string[]) => void | Promise<void>;
}

function DuplicatesScreen(props: DuplicatesScreenProps) {
  const draftTransforms = useDraftTransforms();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [renderLimit, setRenderLimit] = useState(50);
  const scrollRef = useRef<HTMLDivElement>(null);

  const groups = props.groups || [];
  const items = props.items || [];

  const totalGroups = groups.length;
  const totalCopies = useMemo(
    () => groups.reduce((sum: number, g: any) => sum + (g.items?.length || 0), 0),
    [groups],
  );
  const reclaimableBytes = useMemo(() => {
    let bytes = 0;
    groups.forEach((g: any) => {
      (g.items || []).slice(1).forEach((it: any) => {
        bytes += Number(it.size || 0);
      });
    });
    return bytes;
  }, [groups]);
  const selectedBytes = useMemo(() => {
    let bytes = 0;
    groups.forEach((g: any) => {
      (g.items || []).forEach((it: any) => {
        if (selected.has(it.id)) bytes += Number(it.size || 0);
      });
    });
    return bytes;
  }, [groups, selected]);

  const progress = props.progress;
  const isScanning = props.busy;
  const progressPercent =
    progress && progress.total ? Math.round((progress.processed! / progress.total) * 100) : 0;

  React.useEffect(() => {
    const ids = new Set<string>();
    groups.forEach((g: any) => {
      (g.items || []).forEach((it: any, i: number) => {
        if (i > 0) ids.add(it.id);
      });
    });
    setSelected(ids);
  }, [groups]);

  React.useEffect(() => {
    setRenderLimit(50);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [groups]);

  const toggleAllGroups = (expand: boolean) => {
    if (expand) {
      const all = new Set<string>();
      groups.forEach((g: any) => all.add(g.sha256));
      setExpandedGroups(all);
    } else {
      setExpandedGroups(new Set());
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroupSelect = (itemIds: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = itemIds.every((id) => next.has(id));
      if (allSelected) {
        itemIds.forEach((id) => next.delete(id));
      } else {
        itemIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const groupSelectedIds = (group: any) =>
    (group.items || []).filter((it: any) => selected.has(it.id)).map((it: any) => it.id);

  const isGroupFullySelected = (group: any) =>
    (group.items || []).slice(1).length > 0 &&
    (group.items || []).slice(1).every((it: any) => selected.has(it.id));

  const isGroupPartiallySelected = (group: any) => {
    const copies = (group.items || []).slice(1);
    return (
      copies.length > 0 &&
      copies.some((it: any) => selected.has(it.id)) &&
      !isGroupFullySelected(group)
    );
  };

  const toggleGroupExpand = (sha256: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sha256)) next.delete(sha256);
      else next.add(sha256);
      return next;
    });
  };

  const isGroupExpanded = (sha256: string) => expandedGroups.has(sha256);
  const shortHash = (sha: string | undefined) => (sha || "").slice(0, 16);

  const toggleSelectAll = () => {
    const allCopyIds = new Set<string>();
    groups.forEach((g: any) =>
      (g.items || []).slice(1).forEach((it: any) => allCopyIds.add(it.id)),
    );
    if (selected.size === allCopyIds.size) {
      setSelected(new Set());
    } else {
      setSelected(allCopyIds);
    }
  };

  const toggleGroup = (group: any) => {
    const copyIds = (group.items || []).slice(1).map((it: any) => it.id);
    toggleGroupSelect(copyIds);
  };

  const handleScan = async () => {
    if (props.onScan) await props.onScan();
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || renderLimit >= groups.length) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) {
      setRenderLimit((n) => Math.min(n + 50, groups.length));
    }
  };

  const handleHideSelected = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    if (props.onHideIds) await props.onHideIds(ids);
    setSelected(new Set());
  };

  const handleDeleteSelected = async () => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    if (props.onRequestDeleteItems) props.onRequestDeleteItems(ids);
    setSelected(new Set());
  };

  return (
    <div className="feature-page duplicates-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Duplicates</p>
          <h1>Duplicate Files</h1>
          <p className="page-subtitle">
            {groups.length === 0
              ? "Duplicate scans compare file content (SHA-256), not just names or sizes."
              : `${groups.length} group${groups.length === 1 ? "" : "s"} · ${totalCopies} copy${groups.length === 1 ? "" : "s"} · ${formatBytesSimple(reclaimableBytes)} reclaimable`}
          </p>
        </div>
        <div className="page-actions">
          {!props.busy && (
            <button className="primary-button" type="button" onClick={handleScan}>
              <DuplicatesIcon size={16} />
              Scan for Duplicates
            </button>
          )}
          {props.busy && (
            <button className="danger-button" type="button" disabled={props.busy}>
              Scanning…
            </button>
          )}
        </div>
      </div>

      {props.busy && props.progress && (
        <div className="duplicate-progress-bar">
          <div className="duplicate-progress-header">
            <span className="duplicate-progress-title">Scanning for Duplicates</span>
            <span className="duplicate-progress-percent">{progressPercent}%</span>
          </div>
          <div className="duplicate-progress-track">
            <div className="duplicate-progress-fill" style={{ width: `${progressPercent}%` }}></div>
          </div>
          <div className="duplicate-progress-meta">
            <span className="duplicate-progress-count">
              {progress?.processed ?? 0} / {progress?.total ?? 0} files
            </span>
            <span className="duplicate-progress-current">{progress?.currentFile || ""}</span>
          </div>
        </div>
      )}

      {groups.length === 0 && !props.busy && (
        <div className="empty-state duplicate-empty">
          <span>
            <DuplicatesIcon size={48} />
          </span>
          <b>No Duplicate Files</b>
          <p>
            Duplicate scans compare file content (SHA-256), not just names or sizes.
            <br />
            Scanning will find identical files across your entire library.
          </p>
          <button
            className="primary-button"
            type="button"
            onClick={handleScan}
            disabled={props.busy}
          >
            <DuplicatesIcon size={18} />
            Scan Library for Duplicates
          </button>
        </div>
      )}

      {groups.length > 0 && (
        <>
          <div className="duplicate-summary-row">
            <div className="duplicate-summary-card">
              <span className="duplicate-summary-value">{groups.length}</span>
              <span className="duplicate-summary-label">Duplicate Groups</span>
            </div>
            <div className="duplicate-summary-card">
              <span className="duplicate-summary-value">{totalCopies}</span>
              <span className="duplicate-summary-label">Duplicate Copies</span>
            </div>
            <div className="duplicate-summary-card">
              <span className="duplicate-summary-value">{formatBytesSimple(reclaimableBytes)}</span>
              <span className="duplicate-summary-label">Reclaimable Space</span>
            </div>
            <div className="duplicate-summary-card duplicate-summary-card-selected">
              <span className="duplicate-summary-value">{selected.size}</span>
              <span className="duplicate-summary-label">Copies Selected</span>
            </div>
          </div>

          <div className="duplicate-batch-bar">
            <div className="duplicate-batch-summary">
              <span>
                {selected.size} of {totalCopies} copies selected
              </span>
              {selected.size > 0 && (
                <span className="duplicate-batch-stats">
                  {formatBytesSimple(selectedBytes)} selected ·{" "}
                  {formatBytesSimple(selectedBytes > 0 ? selectedBytes : reclaimableBytes)}{" "}
                  reclaimable
                </span>
              )}
            </div>
            <div className="duplicate-batch-actions">
              <button
                type="button"
                className="quiet-button"
                disabled={props.busy || selected.size === 0}
                onClick={toggleSelectAll}
              >
                Select All Copies
              </button>
              <button
                type="button"
                className="quiet-button"
                disabled={props.busy || selected.size === 0}
                onClick={() => setSelected(new Set())}
              >
                Clear Selection
              </button>
              <button
                type="button"
                className="quiet-button"
                disabled={props.busy || selected.size === 0}
                onClick={handleHideSelected}
              >
                Hide Selected
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={props.busy || selected.size === 0}
                onClick={handleDeleteSelected}
              >
                Move Selected to Trash
              </button>
            </div>
          </div>

          <div className="duplicate-scroll-container" ref={scrollRef} onScroll={handleScroll}>
            {groups.slice(0, renderLimit).map((group: any) => (
              <section
                key={String(group.sha256)}
                className={`duplicate-group ${isGroupExpanded(group.sha256) ? "duplicate-group-expanded" : ""}`}
              >
                <div className="duplicate-group-head">
                  <div className="duplicate-group-info">
                    <div className="duplicate-group-actions">
                      <button
                        type="button"
                        className={`duplicate-group-select ${isGroupFullySelected(group) ? "duplicate-group-select-selected" : ""} ${isGroupPartiallySelected(group) ? "duplicate-group-select-partial" : ""}`}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          toggleGroup(group);
                        }}
                      >
                        {isGroupFullySelected(group)
                          ? "✓"
                          : isGroupPartiallySelected(group)
                            ? "−"
                            : "○"}
                      </button>
                    </div>
                    <div className="duplicate-group-meta">
                      <span className="duplicate-group-title">
                        {group.items?.length || 0} Identical Copies
                      </span>
                      <span className="duplicate-group-hash">
                        <span className="duplicate-group-hash-label">SHA-256:</span>
                        {shortHash(group.sha256)}
                      </span>
                    </div>
                    <div className="duplicate-group-toggle">
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          toggleGroupExpand(group.sha256);
                        }}
                      >
                        {isGroupExpanded(group.sha256)
                          ? "Collapse"
                          : `Show ${group.items?.length || 0} Files`}
                      </button>
                    </div>
                  </div>
                  <div className="duplicate-group-actions">
                    <button
                      type="button"
                      className="quiet-button"
                      disabled={props.busy || groupSelectedIds(group).length === 0}
                      onClick={() => props.onHideIds?.(groupSelectedIds(group))}
                    >
                      Hide Selected
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={props.busy || groupSelectedIds(group).length === 0}
                      onClick={() => props.onRequestDeleteItems?.(groupSelectedIds(group))}
                    >
                      Move to Trash
                    </button>
                  </div>
                </div>
                <div className="duplicate-grid">
                  {(() => {
                    const items = group.items || [];
                    const expanded = isGroupExpanded(group.sha256);
                    const visible = expanded ? items : items.slice(0, 3);
                    const showMore = !expanded && items.length > 3;
                    return (
                      <>
                        {visible.map((item: any, i: number) => {
                          const isOriginal = i === 0;
                          return (
                            <div
                              key={item.id}
                              className={`duplicate-card${selected.has(item.id) ? " duplicate-card-selected" : ""} ${isOriginal ? " duplicate-card-original" : ""}`}
                              onClick={(e: React.MouseEvent) => {
                                if (e.target instanceof HTMLInputElement) return;
                                toggleSelected(item.id);
                              }}
                            >
                              <input
                                type="checkbox"
                                className="duplicate-check"
                                checked={selected.has(item.id)}
                                aria-label={i === 0 ? "Keep Original" : `Select Copy ${i + 1}`}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                  e.stopPropagation();
                                  toggleSelected(item.id);
                                }}
                              />
                              {isOriginal && (
                                <span className="duplicate-keep-badge" title="Original File">
                                  Keep Original
                                </span>
                              )}
                              <div className="duplicate-thumbnail">
                                {item.kind === "photo" ? (
                                  <CachedThumbnail
                                    itemId={item.id}
                                    name={item.name}
                                    size={128}
                                    style={draftImageStyle(draftTransforms, item.id)}
                                  />
                                ) : item.kind === "video" ? (
                                  <div className="duplicate-media video-thumb">
                                    <div className="duplicate-media-icon">🎬</div>
                                    <div className="duplicate-media-label">Video</div>
                                  </div>
                                ) : item.kind === "raw" ? (
                                  <div className="duplicate-media raw-thumb">
                                    <div className="duplicate-media-icon">📷</div>
                                    <div className="duplicate-media-label">RAW</div>
                                  </div>
                                ) : (
                                  <div className="duplicate-media generic-thumb">
                                    <div className="duplicate-media-icon">📄</div>
                                    <div className="duplicate-media-label">{item.kind}</div>
                                  </div>
                                )}
                              </div>
                              <div className="duplicate-card-body">
                                <div className="duplicate-card-name">{item.name}</div>
                                <div className="duplicate-card-meta">
                                  <span>{item.kind}</span>
                                  <span>•</span>
                                  <span title={item.path}>{formatBytesSimple(item.size)}</span>
                                  <span>•</span>
                                  <span>{item.extension?.toUpperCase()}</span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                        {showMore && (
                          <div
                            className="duplicate-card duplicate-card-showmore"
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              toggleGroupExpand(group.sha256);
                            }}
                          >
                            <div className="duplicate-card-body">
                              <span className="duplicate-card-label">Show All</span>
                              <div className="duplicate-card-meta">
                                <span>{items.length - 3} more items</span>
                              </div>
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </section>
            ))}
            {renderLimit < groups.length && (
              <div className="duplicate-load-more">
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => setRenderLimit((n) => Math.min(n + 50, groups.length))}
                >
                  Show {Math.min(50, groups.length - renderLimit)} More Groups
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default DuplicatesScreen;
