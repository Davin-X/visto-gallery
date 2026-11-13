import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { usePopoverFocus } from "./usePopoverFocus";

function MenuDemo() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  usePopoverFocus(open, panelRef, triggerRef, { menu: true });
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen((v) => !v)}>
        More
      </button>
      {open && (
        <div ref={panelRef} role="menu">
          <button role="menuitem" type="button">
            First
          </button>
          <button role="menuitem" type="button">
            Second
          </button>
          <button role="menuitem" type="button" onClick={() => setOpen(false)}>
            Close it
          </button>
        </div>
      )}
    </>
  );
}

describe("usePopoverFocus", () => {
  it("moves focus into the popover and back to the trigger when it closes", async () => {
    render(<MenuDemo />);
    fireEvent.click(screen.getByText("More"));
    await waitFor(() => expect(screen.getByText("First")).toHaveFocus());

    fireEvent.click(screen.getByText("Close it"));
    await waitFor(() => expect(screen.getByText("More")).toHaveFocus());
  });

  it("moves between menu items with the arrow keys", async () => {
    render(<MenuDemo />);
    fireEvent.click(screen.getByText("More"));
    await waitFor(() => expect(screen.getByText("First")).toHaveFocus());

    fireEvent.keyDown(screen.getByText("First"), { key: "ArrowDown" });
    expect(screen.getByText("Second")).toHaveFocus();
    fireEvent.keyDown(screen.getByText("Second"), { key: "End" });
    expect(screen.getByText("Close it")).toHaveFocus();
    fireEvent.keyDown(screen.getByText("Close it"), { key: "ArrowDown" });
    expect(screen.getByText("First")).toHaveFocus();
  });

  it("focuses a read-only panel itself when it has no controls", async () => {
    function ReadOnlyDemo() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      const panelRef = useRef<HTMLDivElement>(null);
      usePopoverFocus(open, panelRef, triggerRef);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen((v) => !v)}>
            Stats
          </button>
          {open && (
            <div ref={panelRef} role="dialog" aria-label="Library stats" tabIndex={-1}>
              Photos 12
            </div>
          )}
        </>
      );
    }
    render(<ReadOnlyDemo />);
    fireEvent.click(screen.getByText("Stats"));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
  });
});
