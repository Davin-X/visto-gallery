import React, { type RefObject } from "react";
import { InfoIcon } from "../../design/components/icons";

export function ViewerShortcutsPopover({
  helpRef,
  helpTrigger,
  helpPanel,
  helpOpen,
  onToggle,
  hints,
}: {
  helpRef: RefObject<HTMLDivElement | null>;
  helpTrigger: RefObject<HTMLButtonElement | null>;
  helpPanel: RefObject<HTMLDivElement | null>;
  helpOpen: boolean;
  onToggle: () => void;
  hints: Array<{ keys: string[]; label: string }>;
}) {
  return (
    <div className="media-anchor" ref={helpRef}>
      <button
        type="button"
        ref={helpTrigger}
        aria-haspopup="dialog"
        aria-expanded={helpOpen}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        className={helpOpen ? "active" : ""}
        onClick={onToggle}
      >
        <InfoIcon size={15} />
        <span className="viewer-bar-label">Keys</span>
      </button>
      {helpOpen && (
        <div
          ref={helpPanel}
          tabIndex={-1}
          className="media-popover media-shortcuts"
          role="dialog"
          aria-label="Keyboard shortcuts"
        >
          {hints.map((hint) => (
            <React.Fragment key={hint.label}>
              <span className="media-shortcut-keys">
                {hint.keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
              <span className="media-shortcut-label">{hint.label}</span>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
