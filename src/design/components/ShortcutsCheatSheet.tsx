import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts cheat sheet modal. Triggered with ⌘/ (Mac) or Ctrl+/ (Win/Linux).
 * Renders a grouped list of all global keyboard shortcuts.
 */
export function ShortcutsCheatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const shortcuts = [
    {
      group: "Navigation",
      items: [
        { key: "⌘/Ctrl + \\", label: "Toggle sidebar" },
        { key: "⌘/Ctrl + Alt + I", label: "Toggle inspector" },
        { key: "⌘/Ctrl + F", label: "Focus search" },
        { key: "→ / ←", label: "Next / previous item (viewer)" },
        { key: "⌘/Ctrl + Enter", label: "Open inspected item in viewer" },
      ],
    },
    {
      group: "Viewer",
      items: [
        { key: "↑ / ↓", label: "Zoom in / out" },
        { key: "0", label: "Zoom to 100%" },
        { key: "1", label: "Zoom to 200%" },
        { key: "R", label: "Rotate 90°" },
        { key: "X", label: "Flip horizontally" },
        { key: "F", label: "Favorite the current item" },
      ],
    },
    {
      group: "Selection",
      items: [{ key: "⌘/Ctrl + A", label: "Select all / deselect all" }],
    },
    {
      group: "Import / Export",
      items: [
        { key: "⌘/Ctrl + O", label: "Import folder" },
        { key: "⌘/Ctrl + I", label: "Import files" },
        { key: "⌘/Ctrl + E", label: "Export to batch" },
      ],
    },
    {
      group: "Playback",
      items: [
        { key: "Escape", label: "Close viewer / inspector / dialogs" },
        { key: "Space", label: "Play / pause (video)" },
      ],
    },
    {
      group: "Help",
      items: [{ key: "⌘/Ctrl + /", label: "Show this cheat sheet" }],
    },
  ];

  const cheatSheetRef = useRef<HTMLDivElement | null>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Focus the close button on mount for keyboard users
  useEffect(() => {
    if (!open) return;
    const btn = cheatSheetRef.current?.querySelector(
      'button[aria-label="Close"]',
    ) as HTMLElement | null;
    btn?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop shortcuts-cheat-sheet-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="album-dialog shortcuts-cheat-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-cheat-sheet-title"
      >
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">KEYBOARD SHORTCUTS</p>
            <h2 id="shortcuts-cheat-sheet-title">Keyboard shortcuts</h2>
          </div>
          <button type="button" className="dialog-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="shortcuts-cheat-sheet-body">
          {shortcuts.map((group) => (
            <div key={group.group} className="shortcuts-group">
              <h3 className="shortcuts-group-title">{group.group}</h3>
              <table className="shortcuts-table">
                <tbody>
                  {group.items.map((item) => (
                    <tr key={item.key}>
                      <td className="shortcuts-key">{item.key}</td>
                      <td className="shortcuts-label">{item.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
