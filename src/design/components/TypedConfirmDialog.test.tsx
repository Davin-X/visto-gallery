import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { TypedConfirmDialog } from "./TypedConfirmDialog";

const baseProps = {
  open: true,
  title: "Delete Library Database?",
  description: "This removes the catalog. Original files are not affected.",
  requiredPhrase: "DELETE",
  onClose: vi.fn(),
  onConfirm: vi.fn(),
};

test("confirm stays disabled until the exact phrase is typed", () => {
  const onConfirm = vi.fn();
  render(<TypedConfirmDialog {...baseProps} onConfirm={onConfirm} />);

  const confirm = screen.getByRole("button", { name: "Delete" });
  expect(confirm).toBeDisabled();

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "DELE" } });
  expect(confirm).toBeDisabled();

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "DELETE" } });
  expect(confirm).toBeEnabled();

  fireEvent.click(confirm);
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

test("phrase match is case-insensitive and trims outer whitespace", () => {
  const onConfirm = vi.fn();
  render(<TypedConfirmDialog {...baseProps} onConfirm={onConfirm} />);

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "  delete  " } });
  expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
});

test("Escape closes the dialog", () => {
  const onClose = vi.fn();
  render(<TypedConfirmDialog {...baseProps} onClose={onClose} />);

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("while busy the dialog cannot be confirmed or closed", () => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <TypedConfirmDialog
      {...baseProps}
      busy
      confirmLabel="Delete"
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "DELETE" } });
  expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
});
