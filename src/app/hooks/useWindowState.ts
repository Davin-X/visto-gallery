import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";

/** Where the last window frame is kept between launches. */
export const WINDOW_FRAME_KEY = "visto:windowFrame";

export type WindowFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type WorkArea = {
  position: { x: number; y: number };
  size: { width: number; height: number };
};

/** Read the frame saved by a previous session, ignoring malformed data. */
export function readStoredWindowFrame(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
): WindowFrame | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(WINDOW_FRAME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WindowFrame>;
    const values = [parsed.x, parsed.y, parsed.width, parsed.height];
    if (
      values.every((value) => typeof value === "number" && Number.isFinite(value)) &&
      (parsed.width ?? 0) > 0 &&
      (parsed.height ?? 0) > 0
    ) {
      return parsed as WindowFrame;
    }
  } catch {
    // A cleared or corrupted entry just means "no saved frame".
  }
  return null;
}

/**
 * Keep a restored frame on screen: clamp its origin so a monitor that is no
 * longer attached cannot leave the window out of reach, while keeping some of
 * the titlebar visible.
 */
export function clampFrameToWorkArea(frame: WindowFrame, work: WorkArea): WindowFrame {
  const minVisibleX = Math.min(120, frame.width);
  const minVisibleY = Math.min(80, frame.height);
  return {
    width: frame.width,
    height: frame.height,
    x: Math.min(
      Math.max(frame.x, work.position.x),
      work.position.x + work.size.width - minVisibleX,
    ),
    y: Math.min(
      Math.max(frame.y, work.position.y),
      work.position.y + work.size.height - minVisibleY,
    ),
  };
}

function saveStoredWindowFrame(frame: WindowFrame): void {
  try {
    localStorage.setItem(WINDOW_FRAME_KEY, JSON.stringify(frame));
  } catch {
    // Storage can be unavailable in preview builds; persistence is best effort.
  }
}

/**
 * Native window behavior owned by the custom topbar: dragging, the
 * double-click fill/restore toggle, keeping a system-filled window fully on
 * screen, and nudging WebKit to relayout during live resizes.
 *
 * It also persists the window frame and restores it on launch when the
 * `restoreWindowState` setting is on.
 */
export function useWindowState(options?: { restoreFrame?: boolean; settingsHydrated?: boolean }) {
  const restoreFrame = options?.restoreFrame ?? false;
  const settingsHydrated = options?.settingsHydrated ?? false;
  // The topbar is our own drag region. Drag after a few pixels of movement
  // (not on mousedown) so a double-click is not mistaken for a drag, then use
  // double-click to toggle fill / centered small window. preventDefault keeps
  // the status text from being selected by the first click.
  const dragCandidateRef = useRef<{
    x: number;
    y: number;
    dragging: boolean;
  } | null>(null);
  const preFillSizeRef = useRef<{ width: number; height: number } | null>(null);

  const beginTopbarDrag = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, select, textarea, [role='button'], [data-no-drag]"))
      return;
    e.preventDefault();
    if (e.detail > 1) return;
    dragCandidateRef.current = { x: e.clientX, y: e.clientY, dragging: false };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragCandidateRef.current;
      if (!drag || drag.dragging) return;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      drag.dragging = true;
      getCurrentWindow()
        .startDragging()
        .catch(() => {});
    };
    const clear = () => {
      dragCandidateRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // First double-click fills the monitor's work area (fully on-screen).
  // The next one restores the saved inner size and centers it.
  const handleTopbarDoubleClick = useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, select, textarea, [role='button']")) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const win = getCurrentWindow();
      const monitor = await currentMonitor();
      if (!monitor) return;
      const work = monitor.workArea ?? {
        position: monitor.position,
        size: monitor.size,
      };
      const scale = monitor.scaleFactor || 1;
      const workWidth = work.size.width / scale;
      const workHeight = work.size.height / scale;
      const outer = await win.outerSize();
      const filled = outer.width >= work.size.width - 8 && outer.height >= work.size.height - 8;

      if (filled) {
        const saved = preFillSizeRef.current;
        const width =
          saved?.width && saved.width < workWidth - 40
            ? saved.width
            : Math.min(1280, workWidth - 80);
        const height =
          saved?.height && saved.height < workHeight - 40
            ? saved.height
            : Math.min(852, workHeight - 80);
        await win.setSize(new LogicalSize(width, height));
        await win.center();
        preFillSizeRef.current = null;
      } else {
        const inner = await win.innerSize();
        const outerBefore = await win.outerSize();
        const chromeHeight = Math.max(0, (outerBefore.height - inner.height) / scale);
        preFillSizeRef.current = {
          width: inner.width / scale,
          height: inner.height / scale,
        };
        await win.setPosition(new PhysicalPosition(work.position.x, work.position.y));
        await win.setSize(
          new LogicalSize(Math.max(1, workWidth - 2), Math.max(1, workHeight - chromeHeight - 2)),
        );
      }
    } catch {
      // Ignore: the browser preview has no Tauri window to resize.
    }
  }, []);

  // The system Fill can leave part of the window off-screen, and the restore
  // returns to the old frame instead of centering. Watch the native window and
  // correct both, without intercepting the titlebar gesture itself.
  useEffect(() => {
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let adjusting = false;
    let wasFilled = false;
    const unlisteners: Array<() => void> = [];

    const adjust = async () => {
      if (disposed || adjusting) return;
      try {
        const monitor = await currentMonitor();
        if (!monitor) return;
        const work = monitor.workArea ?? {
          position: monitor.position,
          size: monitor.size,
        };
        const outer = await win.outerSize();
        const pos = await win.outerPosition();
        const filled = outer.width >= work.size.width - 8 && outer.height >= work.size.height - 8;

        if (filled) {
          wasFilled = true;
          const maxX = Math.max(work.position.x, work.position.x + work.size.width - outer.width);
          const maxY = Math.max(work.position.y, work.position.y + work.size.height - outer.height);
          const x = Math.min(Math.max(pos.x, work.position.x), maxX);
          const y = Math.min(Math.max(pos.y, work.position.y), maxY);
          if (x !== pos.x || y !== pos.y) {
            adjusting = true;
            await win.setPosition(new PhysicalPosition(x, y)).catch(() => {});
            adjusting = false;
          }
        } else if (wasFilled) {
          wasFilled = false;
          adjusting = true;
          await win.center().catch(() => {});
          adjusting = false;
        }
      } catch {
        // Ignore: the browser preview has no Tauri window to query.
      }
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void adjust();
      }, 140);
    };

    win
      .onResized(schedule)
      .then((un) => (disposed ? un() : unlisteners.push(un)))
      .catch(() => {});
    win
      .onMoved(schedule)
      .then((un) => (disposed ? un() : unlisteners.push(un)))
      .catch(() => {});

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisteners.forEach((un) => un());
    };
  }, []);

  // Force WebKit to relayout during macOS live window drags without running an
  // animation-frame loop while the window is idle.
  useEffect(() => {
    let raf: ReturnType<typeof requestAnimationFrame> | null = null;
    let prevW = window.innerWidth;
    let prevH = window.innerHeight;

    const onResize = () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (w !== prevW || h !== prevH) {
          prevW = w;
          prevH = h;
          // Force a synchronous layout read so WebKit recalculates the viewport.
          void document.documentElement.offsetHeight;
        }
      });
    };
    window.addEventListener("resize", onResize, { passive: true });

    return () => {
      window.removeEventListener("resize", onResize);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  // Restore the saved frame once settings are hydrated. This stays separate
  // from the save listeners so toggling the setting does not unregister them.
  const didRestoreFrame = useRef(false);
  useEffect(() => {
    if (!settingsHydrated || didRestoreFrame.current) return;
    didRestoreFrame.current = true;
    if (!restoreFrame) return;

    const stored = readStoredWindowFrame();
    if (!stored) return;

    void (async () => {
      try {
        const win = getCurrentWindow();
        const monitor = await currentMonitor();
        const frame = monitor
          ? clampFrameToWorkArea(
              stored,
              monitor.workArea ?? {
                position: monitor.position,
                size: monitor.size,
              },
            )
          : stored;
        await win.setSize(new PhysicalSize(frame.width, frame.height));
        await win.setPosition(new PhysicalPosition(frame.x, frame.y));
      } catch {
        // Ignore: a disconnected monitor or preview build has no frame to restore.
      }
    })();
  }, [restoreFrame, settingsHydrated]);

  // Keep the saved frame in step with user moves and resizes. Runs whenever the
  // app is ready, even while the restore setting is off, so enabling it later
  // has a recent frame to restore.
  useEffect(() => {
    if (!settingsHydrated) return;

    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisteners: Array<() => void> = [];

    const scheduleSave = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const [position, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
          if (!disposed) {
            saveStoredWindowFrame({
              x: position.x,
              y: position.y,
              width: size.width,
              height: size.height,
            });
          }
        } catch {
          // Ignore: the preview build has no native window.
        }
      }, 400);
    };

    win
      .onMoved(scheduleSave)
      .then((un) => (disposed ? un() : unlisteners.push(un)))
      .catch(() => {});
    win
      .onResized(scheduleSave)
      .then((un) => (disposed ? un() : unlisteners.push(un)))
      .catch(() => {});

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisteners.forEach((un) => un());
    };
  }, [settingsHydrated]);

  return { beginTopbarDrag, handleTopbarDoubleClick };
}
