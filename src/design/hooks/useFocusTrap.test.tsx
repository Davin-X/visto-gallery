/// <reference types="vitest/globals" />

import { render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { useFocusTrap } from "../../design/hooks/useFocusTrap";

function Demo() {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(open, ref);
  return open ? (
    <div ref={ref} tabIndex={-1}>
      <button onClick={() => setOpen(false)}>Close</button>
      <button>Other</button>
    </div>
  ) : null;
}

test("focus trap moves focus into container", async () => {
  render(<Demo />);
  await waitFor(() => expect(screen.getByText("Close")).toHaveFocus());
});