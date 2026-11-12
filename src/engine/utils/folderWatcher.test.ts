/// <reference types="vitest/globals" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createAutoImportController,
  createFolderChangeCoalescer,
  syncFolderWatchers,
} from "./folderWatcher";

describe("folder change coalescing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("flushes duplicate events once, on the trailing edge", () => {
    const onFlush = vi.fn();
    const coalescer = createFolderChangeCoalescer(onFlush, 800);

    coalescer.push("/Photos");
    vi.advanceTimersByTime(300);
    coalescer.push("/Photos");
    coalescer.push("/Photos");
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(799);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(["/Photos"]);
  });

  test("a steady stream of events cannot postpone the flush forever", () => {
    const onFlush = vi.fn();
    const coalescer = createFolderChangeCoalescer(onFlush, 800, 2000);

    // One event every 100 ms: each one restarts the 800 ms quiet window, so
    // without a cap nothing would ever flush.
    for (let index = 0; index < 20; index += 1) {
      coalescer.push(`/Photos/${index}.jpg`);
      vi.advanceTimersByTime(100);
    }

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toHaveLength(20);
    expect(coalescer.pending()).toEqual([]);
  });

  test("a quiet burst still flushes on the trailing edge", () => {
    const onFlush = vi.fn();
    const coalescer = createFolderChangeCoalescer(onFlush, 800, 5000);

    coalescer.push("/Photos/a.jpg");
    vi.advanceTimersByTime(700);
    coalescer.push("/Photos/b.jpg");
    vi.advanceTimersByTime(799);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(["/Photos/a.jpg", "/Photos/b.jpg"]);
  });

  test("flush can run immediately and cancel drops pending work", () => {
    const onFlush = vi.fn();
    const coalescer = createFolderChangeCoalescer(onFlush, 800);
    coalescer.push("/A");
    coalescer.flush();
    expect(onFlush).toHaveBeenCalledWith(["/A"]);

    coalescer.push("/B");
    coalescer.cancel();
    vi.advanceTimersByTime(1000);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });
});

describe("auto-import", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("does not scan while auto-import is disabled", async () => {
    const scan = vi.fn().mockResolvedValue(undefined);
    const controller = createAutoImportController({
      isEnabled: () => false,
      scan,
      onError: vi.fn(),
    });

    controller.changed("/Photos");
    vi.advanceTimersByTime(800);
    await controller.drain();

    expect(scan).not.toHaveBeenCalled();
  });

  test("scans once per coalesced root and reports failures", async () => {
    const scan = vi.fn().mockRejectedValue(new Error("permission denied"));
    const onError = vi.fn();
    const controller = createAutoImportController({
      isEnabled: () => true,
      scan,
      onError,
    });

    controller.changed("/Photos");
    controller.changed("/Photos");
    vi.advanceTimersByTime(800);
    await controller.drain();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith("/Photos");
    expect(onError).toHaveBeenCalledWith("/Photos", expect.any(Error));
  });
});

describe("watcher sync", () => {
  test("restores new roots, keeps existing ones, and removes stale roots", async () => {
    const watch = vi.fn().mockResolvedValue(undefined);
    const unwatch = vi.fn().mockResolvedValue(undefined);

    const result = await syncFolderWatchers(["/Keep", "/New"], ["/Keep", "/Removed"], {
      watch,
      unwatch,
    });

    expect(unwatch).toHaveBeenCalledWith("/Removed");
    expect(watch).toHaveBeenCalledWith("/New");
    expect([...result.watched].sort()).toEqual(["/Keep", "/New"]);
    expect(result.errors).toEqual([]);
  });

  test("returns failures instead of silently pretending a watcher exists", async () => {
    const watch = vi.fn().mockRejectedValue(new Error("denied"));
    const result = await syncFolderWatchers(["/Denied"], [], {
      watch,
      unwatch: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.watched.size).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe("/Denied");
  });
});
