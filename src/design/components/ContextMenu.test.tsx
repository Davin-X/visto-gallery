/// <reference types="vitest/globals" />
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu } from "./ContextMenu";

test("keyboard focus enters the menu and moves with arrows, Home and End", () => {
  render(
    <div className="app-frame">
      <ContextMenu
        x={20}
        y={20}
        onClose={vi.fn()}
        items={[{ label: "Open" }, { label: "Delete", danger: true }]}
      />
    </div>,
  );

  const menu = document.querySelector(".context-menu") as HTMLElement;
  expect(menu).toHaveFocus();

  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "Open" })).toHaveFocus();

  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();

  fireEvent.keyDown(menu, { key: "End" });
  expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();

  fireEvent.keyDown(menu, { key: "Home" });
  expect(screen.getByRole("menuitem", { name: "Open" })).toHaveFocus();
});

test("Escape closes the menu", () => {
  const onClose = vi.fn();
  render(
    <div className="app-frame">
      <ContextMenu x={20} y={20} onClose={onClose} items={[{ label: "Open" }]} />
    </div>,
  );

  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

test("a submenu opens on hover and closes once the pointer leaves", () => {
  vi.useFakeTimers();
  render(
    <div className="app-frame">
      <ContextMenu
        x={20}
        y={20}
        onClose={vi.fn()}
        items={[{ label: "Rating", submenu: [{ label: "3 stars" }] }]}
      />
    </div>,
  );

  const row = screen.getByRole("menuitem", { name: "Rating" });
  fireEvent.mouseEnter(row);
  expect(screen.getByRole("menuitem", { name: "3 stars" })).toBeInTheDocument();

  const wrapper = row.closest(".context-menu-submenu") as HTMLElement;
  fireEvent.mouseLeave(wrapper);
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(screen.queryByRole("menuitem", { name: "3 stars" })).toBeNull();

  vi.useRealTimers();
});
