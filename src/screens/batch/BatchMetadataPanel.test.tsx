import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../engine/types/media";
import { BatchMetadataPanel, parseLocalDateTimeAsUtcMs } from "./BatchMetadataPanel";

const { mockEditMetadata } = vi.hoisted(() => ({
  mockEditMetadata: vi.fn(),
}));

vi.mock("../../engine/commands/tauri", () => ({
  tauri: {
    batch: {
      editMetadata: mockEditMetadata,
    },
  },
}));

const sampleItem: MediaItem = {
  id: "item-1",
  path: "/photos/IMG_0001.CR2",
  name: "IMG_0001.CR2",
  title: null,
  extension: "cr2",
  kind: "raw",
  size: 1024,
  modifiedAt: 1_700_000_000_000,
  capturedAt: null,
  width: 6000,
  height: 4000,
  camera: null,
  lens: null,
  exposure: null,
  iso: null,
  latitude: null,
  longitude: null,
  sha256: null,
  favorite: false,
  hidden: false,
  hiddenReason: null,
  isAnimated: false,
  rating: null,
  colorLabel: null,
  importSessionId: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  tags: ["existing"],
  albumIds: [],
};

describe("BatchMetadataPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEditMetadata.mockResolvedValue({
      updated: 1,
      sidecarsWritten: 1,
      failed: [],
    });
  });

  it("parses datetime-local values as wall-clock UTC ms", () => {
    expect(parseLocalDateTimeAsUtcMs("2026-07-11T23:30:05")).toBe(Date.UTC(2026, 6, 11, 23, 30, 5));
    expect(parseLocalDateTimeAsUtcMs("2026-07-11T23:30")).toBe(Date.UTC(2026, 6, 11, 23, 30, 0));
    expect(parseLocalDateTimeAsUtcMs("invalid")).toBeNull();
  });

  it("validates coordinates and submits XMP metadata edits", async () => {
    const onReload = vi.fn();
    render(
      <BatchMetadataPanel
        items={[sampleItem]}
        onReloadLibrary={onReload}
        onOpenLibrary={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Capture date and time"), {
      target: { value: "2026-07-11T23:30:00" },
    });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Tokyo Dusk" },
    });
    fireEvent.change(screen.getByLabelText("Keywords"), {
      target: { value: "japan, dusk" },
    });
    fireEvent.change(screen.getByLabelText("Latitude"), {
      target: { value: "35.6762" },
    });
    fireEvent.change(screen.getByLabelText("Longitude"), {
      target: { value: "139.6503" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Apply to 1 file/i }));

    await waitFor(() => {
      expect(mockEditMetadata).toHaveBeenCalledWith({
        itemIds: ["item-1"],
        capturedAt: Date.UTC(2026, 6, 11, 23, 30, 0),
        title: "Tokyo Dusk",
        keywords: ["japan", "dusk"],
        keywordsMode: "add",
        latitude: 35.6762,
        longitude: 139.6503,
        clearLocation: false,
      });
    });

    expect(await screen.findByText(/Updated 1 item \(1 XMP sidecar written\)/)).toBeTruthy();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["replace", "Updated title", null],
    ["clear", "", "replace"],
  ])("submits %s with empty keywords safely", async (action, title, expectedMode) => {
    render(
      <BatchMetadataPanel items={[sampleItem]} onReloadLibrary={vi.fn()} onOpenLibrary={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Keywords action"), { target: { value: action } });
    if (action === "clear")
      expect(screen.getByText("Clear all keywords from 1 file")).toBeVisible();
    else expect(screen.getByRole("button", { name: "Apply to 1 file" })).toBeDisabled();
    if (title) fireEvent.change(screen.getByLabelText("Title"), { target: { value: title } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 file" }));
    await screen.findByText(/Updated 1 item/);
    expect(mockEditMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ keywordsMode: expectedMode, keywords: [] }),
    );
  });

  it("rejects out-of-range coordinates without calling backend", async () => {
    render(
      <BatchMetadataPanel items={[sampleItem]} onReloadLibrary={vi.fn()} onOpenLibrary={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "95" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /Apply to 1 file/i }));

    expect(await screen.findByText(/Latitude must be between -90 and 90/)).toBeTruthy();
    expect(mockEditMetadata).not.toHaveBeenCalled();
  });
});
