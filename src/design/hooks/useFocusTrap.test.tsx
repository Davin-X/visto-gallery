/// <reference types="vitest/globals" />

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { useFocusTrap } from "../../design/hooks/useFocusTrap";

function Demo() {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(open, ref);
  return open ? (
    <div ref={ref} role="dialog" tabIndex={-1}>
      <button onClick={() => setOpen(false)}>Close</button>
      <button>Other</button>
    </div>
  ) : null;
}

test("focus trap moves focus into container", async () => {
  render(<Demo />);
  await waitFor(() => expect(screen.getByText("Close")).toHaveFocus());
});

function RestorableDemo() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(open, ref);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      {open && (
        <div ref={ref} role="dialog" tabIndex={-1} aria-modal="true">
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
          <button type="button">Other</button>
        </div>
      )}
    </>
  );
}

test("focus trap wraps Tab and Shift+Tab inside the dialog and returns focus to the trigger", async () => {
  render(<RestorableDemo />);

  const trigger = screen.getByRole("button", { name: "Open dialog" });
  trigger.focus();
  fireEvent.click(trigger);

  const close = await screen.findByRole("button", { name: "Close" });
  await waitFor(() => expect(close).toHaveFocus());

  const other = screen.getByRole("button", { name: "Other" });
  other.focus();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
  expect(close).toHaveFocus();

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
  expect(other).toHaveFocus();

  fireEvent.click(close);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
