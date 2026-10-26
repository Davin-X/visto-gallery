import React, { useState, useMemo, useEffect, useRef } from "react";
import { DuplicatesIcon } from "../design/components/icons";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import { KindBadge } from "../design/components/KindBadge";
import {
  useDraftTransforms,
  draftTransformStyle,
} from "../engine/stores/useEditStore";
import type { MediaItem, DuplicateGroup } from "../engine/types/media";
import { formatBytesSimple } from "../engine/utils/mediaTypes";

function draftImageStyle(
  transforms: Map<string, any> | undefined,
  itemId: string,
) {
  const transform = draftTransformStyle(transforms?.get(itemId));
  return transform ? { transform } : undefined;
}

interface DuplicatesScreenProps {
  groups: DuplicateGroup[];
  items: MediaItem[];
  onScan: () => void | Promise<void>;
  onClear: () => void;
  busy: boolean;
  assetUrl: (path: string) => string;
  onRequestDeleteItems: (ids: string[]) => void;
  onHideIds: (ids: string[]) => void | Promise<void>;
}

function DuplicatesScreen(props: DuplicatesScreenProps) {
  const draftTransforms = useDraftTransforms();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Progressive rendering for large duplicate result sets
  const [renderLimit, setRenderLimit] = useState(50);
  const scrollRef = useRef<HTMLDivElement>(null);

  const groups = props.groups || [];
  const totalCopies = useMemo(
    () =>
      groups.reduce((sum: number, g: any) => sum + (g.items?.length || 0), 0),
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

  React.useEffect(() => {
    const ids = new Set<string>();
    groups.forEach((g: any) => {
      (g.items || []).forEach((it: any, i: number) => {
        if (i > 0) ids.add(it.id);
      });
    });
    setSelected(ids);
  }, [groups]);

  useEffect(() => {
    setRenderLimit(50);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [groups]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || renderLimit >= groups.length) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) {
      setRenderLimit((n) => Math.min(n + 50, groups.length));
    }
  };

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

  const groupSelectedIds = (group: any) =>
    (group.items || [])
      .filter((it: any) => selected.has(it.id))
      .map((it: any) => it.id);

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

  const groupItemsSelected = (group: any) =>
    (group.items || []).slice(1).every((it: any) => selected.has(it.id));

  const renderDuplicates = () => {
    if (groups.length === 0) {
      return (
        <div className="empty-state duplicate-empty">
          <span>
            <DuplicatesIcon size={34} />
          </span>
          <b>No duplicates found</b>
          <p>
            Duplicate scans compare file content (SHA-256), not just names or
            sizes.
          </p>
          <button
            className="primary-button"
            type="button"
            onClick={props.onScan}
            disabled={props.busy}
          >
            Scan {props.items?.length || 0} files
          </button>
        </div>
      );
    }

    return (
      <>
        <div className="duplicate-batch-bar">
          <div className="duplicate-batch-summary">
            <span>
              {selected.size} of {totalCopies} copies selected
            </span>
            {selected.size > 0 && (
              <small>
                {formatBytesSimple(selectedBytes)} selected ·{" "}
                {formatBytesSimple(reclaimableBytes)} can be reclaimed
              </small>
            )}
          </div>
          <div className="duplicate-batch-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={props.busy || selected.size === 0}
              onClick={() => props.onHideIds?.([...selected])}
            >
              Hide selected
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={props.busy || selected.size === 0}
              onClick={() => props.onRequestDeleteItems?.([...selected])}
            >
              Move selected to Trash
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={props.busy}
              onClick={() => {
                const ids = new Set<string>();
                groups.forEach((g: any) =>
                  (g.items || []).forEach((it: any, i: number) => {
                    if (i > 0) ids.add(it.id);
                  }),
                );
                setSelected(ids);
              }}
            >
              Select all copies
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={props.busy}
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={props.busy || expandedGroups.size === 0}
              onClick={() => toggleAllGroups(false)}
            >
              Collapse all
            </button>
            <button
              className="quiet-button"
              type="button"
              disabled={props.busy || expandedGroups.size === groups.length}
              onClick={() => toggleAllGroups(true)}
            >
              Expand all
            </button>
          </div>
        </div>
        <div
          className="duplicate-scroll-container"
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {groups.slice(0, renderLimit).map((group: any) => (
            <section className="duplicate-result" key={String(group.sha256)}>
              <div className="duplicate-group-head">
                <div className="duplicate-group-title">
                  <b>Identical files</b>
                  <span>{group.items?.length || 0} copies · SHA-256 match</span>
                  <span className="duplicate-group-hash">
                    {shortHash(group.sha256)}
                  </span>
                </div>
                <div className="duplicate-group-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={
                      props.busy || groupSelectedIds(group).length === 0
                    }
                    onClick={() => props.onHideIds?.(groupSelectedIds(group))}
                  >
                    Hide selected
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={
                      props.busy || groupSelectedIds(group).length === 0
                    }
                    onClick={() =>
                      props.onRequestDeleteItems?.(groupSelectedIds(group))
                    }
                  >
                    Move to Trash
                  </button>
                  {group.items.length > 5 && (
                    <button
                      className="quiet-button"
                      type="button"
                      onClick={() => toggleGroupExpand(group.sha256)}
                    >
                      {isGroupExpanded(group.sha256)
                        ? "Show fewer"
                        : `Show all ${group.items.length}`}
                    </button>
                  )}
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
                      {visible.map((item: any, i: number) => (
                        <div
                          className={`duplicate-card${selected.has(item.id) ? " duplicate-card-selected" : ""}${
                            i === 0 ? " duplicate-card-keep" : ""
                          }`}
                          key={item.id}
                          onClick={(e: React.MouseEvent) => {
                            if (e.target instanceof HTMLInputElement) return;
                            toggleSelected(item.id);
                          }}
                        >
                          <input
                            type="checkbox"
                            className="duplicate-check"
                            checked={selected.has(item.id)}
                            aria-label={
                              i === 0 ? "Keep original" : "Select copy"
                            }
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>,
                            ) => {
                              e.stopPropagation();
                              toggleSelected(item.id);
                            }}
                          />
                          {i === 0 && (
                            <span
                              className="duplicate-keep-badge"
                              title="Original copy"
                            >
                              Original
                            </span>
                          )}
                          <div className="duplicate-thumb">
                            {item.kind === "photo" ? (
                              <CachedThumbnail
                                itemId={item.id}
                                name={item.name}
                                size={256}
                                style={draftImageStyle(
                                  draftTransforms,
                                  item.id,
                                )}
                              />
                            ) : (
                              <div className="duplicate-nonimage">
                                <KindBadge kind={item.kind} />
                              </div>
                            )}
                          </div>
                          <div className="duplicate-card-body">
                            <span className="duplicate-card-label">
                              {i === 0
                                ? "Keep original"
                                : selected.has(item.id)
                                  ? "Selected copy"
                                  : "Copy"}
                            </span>
                            <div className="duplicate-card-meta">
                              <span title={item.name}>{item.name}</span>
                              <small title={item.path}>
                                {formatBytesSimple(item.size)} · {item.path}
                              </small>
                            </div>
                          </div>
                        </div>
                      ))}
                      {showMore && (
                        <div
                          className={`duplicate-card duplicate-card-showmore${selected.size > 0 && groupItemsSelected(group) ? " duplicate-card-selected" : ""}`}
                          key="show-all"
                          onClick={(e: React.MouseEvent) => {
                            if (e.target instanceof HTMLInputElement) return;
                            toggleGroupExpand(group.sha256);
                          }}
                        >
                          <input
                            type="checkbox"
                            className="duplicate-check"
                            checked={groupItemsSelected(group)}
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>,
                            ) => {
                              e.stopPropagation();
                              const ids = new Set<string>();
                              (items || [])
                                .slice(1)
                                .forEach((it: any) => ids.add(it.id));
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (groupItemsSelected(group)) {
                                  ids.forEach((id) => next.delete(id));
                                } else {
                                  ids.forEach((id) => next.add(id));
                                }
                                return next;
                              });
                            }}
                          />
                          <span className="duplicate-showmore-label">
                            Show all {items.length - 3}
                          </span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </section>
          ))}
          {renderLimit < groups.length && (
            <div className="grid-more">
              <button
                type="button"
                className="quiet-button"
                onClick={() =>
                  setRenderLimit((n) => Math.min(n + 50, groups.length))
                }
              >
                Show {Math.min(50, groups.length - renderLimit)} more groups
              </button>
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <div className="feature-page duplicates-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Duplicates</p>
          <h1>Duplicate files</h1>
          <p className="page-subtitle">
            {groups.length === 0
              ? "Duplicate scans compare file content (SHA-256), not just names or sizes."
              : `${groups.length} group${groups.length === 1 ? "" : "s"} · ${totalCopies} copies · ${formatBytesSimple(reclaimableBytes)} reclaimable (includes hidden items)`}
          </p>
        </div>
        {!props.busy && groups.length > 0 && (
          <button className="quiet-button" type="button" onClick={props.onScan}>
            Rescan
          </button>
        )}
      </div>
      {renderDuplicates()}
    </div>
  );
}

// Browser-based media item creation (temporary until the Tauri backend is
// wired). Items are normalized to the same shape as the native catalog so the
// browser prototype and the Rust store agree on a single MediaItem layout.

export default DuplicatesScreen;
