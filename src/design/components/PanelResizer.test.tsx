/// <reference types="vitest/globals" />
import { fireEvent, render, screen } from "@testing-library/react";
import { PanelResizer } from "./PanelResizer";

function setup(side: "left" | "right" = "left", width = 240) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const onCommit = vi.fn();

  render(
    <PanelResizer
      side={side}
      width={width}
      min={180}
      max={360}
      cssVar="--sidebar-width"
      targetRef={{ current: target }}
      onCommit={onCommit}
      defaultWidth={300}
      label="Resize panel"
    />,
  );

  return { target, onCommit, handle: screen.getByRole("separator", { name: "Resize panel" }) };
}

afterEach(() => {
  document.body.innerHTML = "";
});

test("exposes the current width as an accessible separator", () => {
  setup("left", 240);
  const handle = screen.getByRole("separator", { name: "Resize panel" });

  expect(handle).toHaveAttribute("aria-orientation", "vertical");
  expect(handle).toHaveAttribute("aria-valuenow", "240");
  expect(handle).toHaveAttribute("aria-valuemin", "180");
  expect(handle).toHaveAttribute("aria-valuemax", "360");
});

test("resizes from the keyboard and clamps to the bounds", () => {
  const { target, onCommit, handle } = setup("left", 240);

  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(onCommit).toHaveBeenLastCalledWith(252);
  expect(target.style.getPropertyValue("--sidebar-width")).toBe("252px");

  fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
  expect(onCommit).toHaveBeenLastCalledWith(204);

  fireEvent.keyDown(handle, { key: "End" });
  expect(onCommit).toHaveBeenLastCalledWith(360);

  fireEvent.keyDown(handle, { key: "Home" });
  expect(onCommit).toHaveBeenLastCalledWith(180);
});

test("maps arrow keys to width for a right-hand panel", () => {
  const { onCommit, handle } = setup("right", 300);

  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(onCommit).toHaveBeenLastCalledWith(312);

  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(onCommit).toHaveBeenLastCalledWith(300);
});

test("drags with pointer events and commits once on release", () => {
  const { target, onCommit, handle } = setup("left", 240);

  fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
  expect(document.body).toHaveClass("is-resizing");

  fireEvent.pointerMove(document, { clientX: 150, pointerId: 1 });
  fireEvent.pointerUp(document, { clientX: 150, pointerId: 1 });

  expect(target.style.getPropertyValue("--sidebar-width")).toBe("290px");
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onCommit).toHaveBeenCalledWith(290);
  expect(document.body).not.toHaveClass("is-resizing");
});

test("double-click restores the default width", () => {
  const { target, onCommit, handle } = setup("left", 240);

  fireEvent.doubleClick(handle);

  expect(target.style.getPropertyValue("--sidebar-width")).toBe("300px");
  expect(onCommit).toHaveBeenCalledWith(300);
});
