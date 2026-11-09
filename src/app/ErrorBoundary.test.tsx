/// <reference types="vitest/globals" />
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";
import { CRASH_REPORT_STORAGE_KEY } from "./crashReport";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn((_url: string) => Promise.resolve()),
}));

vi.mock("../engine/commands/tauri", () => ({
  tauri: { app: { openExternal: mocks.openExternal } },
}));

function Thrower(): JSX.Element {
  throw new Error("boom");
}

afterEach(() => {
  window.localStorage.removeItem(CRASH_REPORT_STORAGE_KEY);
  vi.clearAllMocks();
});

describe("ErrorBoundary", () => {
  it("shows the crash screen and persists diagnostics when a child throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/VistoGallery encountered an error/i)).toBeInTheDocument();
    const saved = window.localStorage.getItem(CRASH_REPORT_STORAGE_KEY);
    expect(saved).toBeTruthy();
    expect(JSON.parse(saved!).errorMessage).toBe("boom");
    expect(JSON.parse(saved!).componentStack).toContain("Thrower");
    consoleError.mockRestore();
  });

  it("copies the error report to the clipboard", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy error report/i }));
    });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain("boom");
    consoleError.mockRestore();
  });

  it("opens the prefilled GitHub issue when reporting", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: /report on github/i }));
    expect(mocks.openExternal).toHaveBeenCalledOnce();
    expect(mocks.openExternal.mock.calls[0][0]).toContain(
      "github.com/Davin-X/visto-gallery/issues/new",
    );
    expect(mocks.openExternal.mock.calls[0][0]).toContain("boom");
    consoleError.mockRestore();
  });
});
