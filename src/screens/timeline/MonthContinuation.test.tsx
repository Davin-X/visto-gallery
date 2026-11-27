import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { tauri } from "../../engine/commands/tauri";
import { useLibraryStore } from "../../engine/stores/useLibraryStore";
import { MonthContinuation } from "./MonthContinuation";
import { timelineKey } from "./monthCache";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("bounds simultaneous requests and drops queued or late work after a filter change", async () => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  const finish: (() => void)[] = [];
  const query = vi
    .spyOn(tauri.library, "getItems")
    .mockImplementation(
      () => new Promise((resolve) => finish.push(() => resolve({ items: [], hasMore: false }))),
    );
  const store = useLibraryStore.getState();
  const view = timelineKey(store, false);
  const rows = render(
    <>
      {["01", "02", "03", "04"].map((month) => (
        <MonthContinuation
          key={month}
          month={`2025-${month}`}
          view={view}
          filter={{ hidden: false }}
          cursor={null}
        />
      ))}
    </>,
  );
  expect(query).toHaveBeenCalledTimes(2);
  act(() => finish.shift()!());
  await waitFor(() => expect(query).toHaveBeenCalledTimes(3));
  rows.unmount();
  useLibraryStore.setState({ query: "different", timelineCache: undefined });
  await act(async () => {
    finish.forEach((done) => done());
  });
  expect(query).toHaveBeenCalledTimes(3);
  expect(useLibraryStore.getState().timelineCache).toBeUndefined();
  useLibraryStore.setState(store, true);
});
