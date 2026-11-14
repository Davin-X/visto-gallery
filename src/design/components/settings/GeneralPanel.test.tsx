/// <reference types="vitest/globals" />
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { GeneralPanel } from "./GeneralPanel";

function renderPanel(overrides: { startupView?: string; openLastFolder?: boolean } = {}) {
  const props = {
    appearance: "system",
    accentColor: "blue",
    sidebarWidth: 240,
    animateTransitions: true,
    showExtensions: true,
    startupView: "library",
    openLastFolder: true,
    restoreWindow: true,
    onChange: vi.fn(),
    onSidebarWidthChange: vi.fn(),
    renderRadioGroup: () => null,
    renderAccentPicker: () => null,
    ...overrides,
  };
  const ui = (next: typeof props) => <GeneralPanel {...next} />;
  const result = render(ui(props));
  return {
    ...result,
    rerender: (next: Partial<typeof props>) => result.rerender(ui({ ...props, ...next })),
  };
}

describe("GeneralPanel startup labels", () => {
  test("hides the last-folder toggle unless launch restores the last view", () => {
    const { rerender } = renderPanel();
    expect(screen.queryByRole("checkbox", { name: "Open last library folder" })).toBeNull();

    rerender({ startupView: "last" });
    expect(screen.getByRole("checkbox", { name: "Open last library folder" })).toBeInTheDocument();
  });

  test("uses sentence case for its labels", () => {
    renderPanel();

    for (const label of [
      "Accent color",
      "Sidebar width",
      "Show file extensions",
      "Animate transitions",
      "Open on launch",
      "Restore window state",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
