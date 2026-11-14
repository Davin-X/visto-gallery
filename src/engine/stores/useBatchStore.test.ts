/// <reference types="vitest/globals" />
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../commands/tauri", () => ({
  tauri: { batch: { export: vi.fn(), cancel: vi.fn() } },
  events: { onBatchProgress: vi.fn().mockResolvedValue(() => {}) },
}));
vi.mock("./useLibraryStore", () => ({
  useLibraryStore: {
    getState: () => ({ selectedIds: new Set<string>(), items: [] }),
  },
}));

import { useBatchStore } from "./useBatchStore";

beforeEach(() => {
  useBatchStore.getState().reset();
});

test("a batch export keeps metadata unless stripping is turned on", () => {
  expect(useBatchStore.getState().stripMetadata).toBe(false);

  useBatchStore.getState().setStripMetadata(true);
  expect(useBatchStore.getState().stripMetadata).toBe(true);

  useBatchStore.getState().reset();
  expect(useBatchStore.getState().stripMetadata).toBe(false);
});
