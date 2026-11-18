/// <reference types="vitest/globals" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppTopBar } from "./AppNavigation";

function renderTopBar(overrides: Partial<React.ComponentProps<typeof AppTopBar>> = {}) {
  const onGoBack = vi.fn();
  const onGoForward = vi.fn();
  const props: React.ComponentProps<typeof AppTopBar> = {
    screen: "Library",
    activeAlbumName: null,
    busy: false,
    progressPhase: null,
    sidebarOpen: true,
    showInspector: false,
    dark: false,
    accentColor: "blue",
    onToggleSidebar: vi.fn(),
    onToggleInspector: vi.fn(),
    onToggleAppearance: vi.fn(),
    appearance: "light",
    onCycleAccent: vi.fn(),
    onOpenSettings: vi.fn(),
    canGoBack: false,
    canGoForward: false,
    onGoBack,
    onGoForward,
    onMouseDown: vi.fn(),
    onDoubleClick: vi.fn(),
    ...overrides,
  };
  render(<AppTopBar {...props} />);
  return { onGoBack, onGoForward };
}

afterEach(cleanup);

describe("AppTopBar history controls", () => {
  test("keeps both controls visible but disabled when there is no history", () => {
    renderTopBar();

    expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled();
  });

  test("enabled controls walk the navigation history", () => {
    const { onGoBack, onGoForward } = renderTopBar({
      canGoBack: true,
      canGoForward: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    fireEvent.click(screen.getByRole("button", { name: "Go forward" }));

    expect(onGoBack).toHaveBeenCalledTimes(1);
    expect(onGoForward).toHaveBeenCalledTimes(1);
  });

  test("the video player keeps its own back arrow", () => {
    renderTopBar({ screen: "Video", canGoBack: true, canGoForward: true });

    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Go forward" })).toBeNull();
  });

  test("still names the current screen in the middle of the bar", () => {
    renderTopBar({ screen: "Cleanup" });

    expect(screen.getByText("Cleanup")).toBeInTheDocument();
  });
});
