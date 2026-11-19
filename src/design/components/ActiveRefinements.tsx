import React from "react";

export interface ActiveRefinementsProps {
  /** Tag names currently narrowing the grid. */
  tags: string[];
  minRating: number | null;
  colorLabel: string | null;
  camera: string | null;
  lens: string | null;
  /** Human-readable date range; empty when no date refinement is active. */
  dateLabel: string;
  onRemoveTag: (tag: string) => void;
  onClearRating: () => void;
  onClearColor: () => void;
  onClearCamera: () => void;
  onClearLens: () => void;
  onClearDate: () => void;
}

function RefinementChip({
  label,
  ariaLabel,
  title,
  onRemove,
}: {
  label: React.ReactNode;
  ariaLabel: string;
  title: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      className="quick-filter active refinement-chip"
      onClick={onRemove}
      aria-label={ariaLabel}
      title={title}
    >
      <span className="refinement-chip-label">{label}</span>
      <span className="refinement-chip-x" aria-hidden="true">
        ×
      </span>
    </button>
  );
}

/**
 * Removable chips for every refinement that can survive outside the Filters
 * panel: Smart Album tags, rating, colour, a camera or lens picked from a
 * context menu, and the capture-date range. Without these, the only way to
 * discover or undo one was the Filters badge and Clear all.
 */
export function ActiveRefinements(props: ActiveRefinementsProps) {
  const hasAny =
    props.tags.length > 0 ||
    props.minRating !== null ||
    props.colorLabel !== null ||
    props.camera !== null ||
    props.lens !== null ||
    props.dateLabel !== "";

  if (!hasAny) return null;

  return (
    <>
      {props.tags.map((tag) => (
        <RefinementChip
          key={`tag-${tag}`}
          label={`#${tag}`}
          ariaLabel={`Remove tag filter ${tag}`}
          title={`Remove tag filter "${tag}"`}
          onRemove={() => props.onRemoveTag(tag)}
        />
      ))}
      {props.minRating !== null && (
        <RefinementChip
          label={`★ ${props.minRating}+`}
          ariaLabel={`Remove rating filter: ${props.minRating} stars and up`}
          title="Remove rating filter"
          onRemove={props.onClearRating}
        />
      )}
      {props.colorLabel && (
        <RefinementChip
          label={props.colorLabel[0].toUpperCase() + props.colorLabel.slice(1)}
          ariaLabel={`Remove ${props.colorLabel} colour filter`}
          title="Remove colour filter"
          onRemove={props.onClearColor}
        />
      )}
      {props.camera && (
        <RefinementChip
          label={`Camera: ${props.camera}`}
          ariaLabel={`Remove camera filter ${props.camera}`}
          title={props.camera}
          onRemove={props.onClearCamera}
        />
      )}
      {props.lens && (
        <RefinementChip
          label={`Lens: ${props.lens}`}
          ariaLabel={`Remove lens filter ${props.lens}`}
          title={props.lens}
          onRemove={props.onClearLens}
        />
      )}
      {props.dateLabel && (
        <RefinementChip
          label={props.dateLabel}
          ariaLabel={`Remove date filter ${props.dateLabel}`}
          title="Remove date filter"
          onRemove={props.onClearDate}
        />
      )}
    </>
  );
}
