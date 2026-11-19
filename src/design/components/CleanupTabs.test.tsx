/// <reference types="vitest/globals" />
import { fireEvent, render, screen } from "@testing-library/react";
import { CleanupTabs } from "./CleanupTabs";

test("marks the showing view as current and leaves the other tab open", () => {
  const onOpenDuplicates = vi.fn();

  render(<CleanupTabs screen="Cleanup" onOpenDuplicates={onOpenDuplicates} />);

  expect(screen.getByRole("button", { name: "Duplicate media" })).not.toHaveAttribute(
    "aria-current",
  );
  expect(screen.getByRole("button", { name: "Mac storage" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  fireEvent.click(screen.getByRole("button", { name: "Duplicate media" }));
  expect(onOpenDuplicates).toHaveBeenCalledTimes(1);
});

test("opens Mac storage from the Duplicates view", () => {
  const onOpenCleanup = vi.fn();

  render(<CleanupTabs screen="Duplicates" onOpenCleanup={onOpenCleanup} />);

  expect(screen.getByRole("button", { name: "Duplicate media" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  fireEvent.click(screen.getByRole("button", { name: "Mac storage" }));
  expect(onOpenCleanup).toHaveBeenCalledTimes(1);
});

test("is a labelled navigation landmark", () => {
  render(<CleanupTabs screen="Duplicates" />);

  expect(screen.getByRole("navigation", { name: "Cleanup" })).toBeInTheDocument();
});
