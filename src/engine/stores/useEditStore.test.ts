/// <reference types="vitest/globals" />
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn(() => ({ listen: vi.fn() })) }));

import { useEditStore, resetDraftRevision } from "../../engine/stores/useEditStore";

test("edit store rotate and flip", () => {
  localStorage.clear();
  resetDraftRevision();
  const store = useEditStore.getState();
  // set a dummy item
  useEditStore.setState({ item: { id: "1" } as any });
  store.rotate(90);
  expect(useEditStore.getState().values.rotation).toBe(90);
  store.flip();
  expect(useEditStore.getState().values.flip).toBe(true);
  store.undo();
  expect(useEditStore.getState().values.flip).toBe(false);
});