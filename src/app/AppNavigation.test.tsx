/// <reference types="vitest/globals" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppSidebar, AppTopBar } from "./AppNavigation";

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

  test("names the shared Clean up destination instead of the tab", () => {
    renderTopBar({ screen: "Cleanup" });
    expect(screen.getByText("Clean up")).toBeInTheDocument();

    cleanup();
    renderTopBar({ screen: "Duplicates" });
    expect(screen.getByText("Clean up")).toBeInTheDocument();
  });
});

const zeroStats = {
  photos: 0,
  videos: 0,
  raws: 0,
  animations: 0,
  animationsSize: 0,
  uncategorized: 0,
  favorites: 0,
  hidden: 0,
  photoSize: 0,
  videoSize: 0,
  rawSize: 0,
  uncategorizedSize: 0,
  favoriteSize: 0,
  hiddenSize: 0,
  totalSize: 0,
};

function renderSidebar(overrides: Partial<React.ComponentProps<typeof AppSidebar>> = {}) {
  const onOpenScreen = vi.fn();
  render(
    <AppSidebar
      screen="Library"
      cleanupTab="Duplicates"
      folders={[]}
      sourcesSheetOpen={false}
      stats={zeroStats}
      updateAvailable={false}
      updateVersion={null}
      appVersion="0.5.0"
      sidebarCollapsed={false}
      onToggleCollapse={vi.fn()}
      onOpenScreen={onOpenScreen}
      onOpenSources={vi.fn()}
      onOpenUpdate={vi.fn()}
      {...overrides}
    />,
  );
  return { onOpenScreen };
}

describe("Clean up sidebar entry", () => {
  test("does not crash while a partial stats response is loading", () => {
    // Old catalogs and the browser harness can briefly omit newly added
    // counters. Rendering navigation must remain safe so the app can recover.
    const partialStats = {
      photos: 2,
    } as unknown as React.ComponentProps<typeof AppSidebar>["stats"];

    expect(() => renderSidebar({ stats: partialStats })).not.toThrow();
    fireEvent.click(screen.getByRole("button", { name: /Library stats/ }));
    expect(screen.getByText("Photos")).toBeInTheDocument();
  });

  test("replaces the separate Duplicates and Cleanup entries", () => {
    renderSidebar();

    expect(screen.getByRole("button", { name: "Clean up" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Duplicates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cleanup" })).toBeNull();
  });

  test("stays highlighted on both of its screens", () => {
    renderSidebar({ screen: "Duplicates" });
    expect(screen.getByRole("button", { name: "Clean up" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    cleanup();
    renderSidebar({ screen: "Cleanup" });
    expect(screen.getByRole("button", { name: "Clean up" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("returns to the last tab, not always the first", () => {
    const fromLibrary = renderSidebar({ cleanupTab: "Cleanup" });
    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
    expect(fromLibrary.onOpenScreen).toHaveBeenCalledWith("Cleanup");

    cleanup();
    const fromCleanup = renderSidebar({ screen: "Cleanup", cleanupTab: "Cleanup" });
    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
    // Already there: the entry keeps the tab instead of resetting to Duplicates.
    expect(fromCleanup.onOpenScreen).toHaveBeenCalledWith("Cleanup");
  });

  test("starts on Duplicate media before either tab has been opened", () => {
    const { onOpenScreen } = renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Clean up" }));
    expect(onOpenScreen).toHaveBeenCalledWith("Duplicates");
  });
});
