/// <reference types="vitest/globals" />
import { describe, expect, test, vi } from "vitest";
import { navigateToBatchExport } from "./exportFlow";

describe("Batch Export navigation", () => {
  test("preserves the current selection and opens Batch", () => {
    const setScreen = vi.fn();
    const setSelection = vi.fn();
    const showNotice = vi.fn();

    navigateToBatchExport({
      selectedIds: ["a", "b"],
      setScreen,
      setSelection,
      showNotice,
    });

    expect(setSelection).toHaveBeenCalledWith(["a", "b"]);
    expect(setScreen).toHaveBeenCalledWith("Batch");
    expect(showNotice).not.toHaveBeenCalled();
  });

  test("empty selection still opens Batch with an actionable prompt", () => {
    const setScreen = vi.fn();
    const setSelection = vi.fn();
    const showNotice = vi.fn();

    navigateToBatchExport({
      selectedIds: [],
      setScreen,
      setSelection,
      showNotice,
    });

    expect(setSelection).not.toHaveBeenCalled();
    expect(setScreen).toHaveBeenCalledWith("Batch");
    expect(showNotice).toHaveBeenCalledWith(
      expect.stringContaining("Select photos or videos"),
    );
  });
});
