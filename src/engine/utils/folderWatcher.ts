/**
 * Coalesces a burst of filesystem events into one trailing scan.
 *
 * `notify` emits several events for a single copy/save (create, modify,
 * rename, directory metadata). Scanning per event would run the same folder
 * repeatedly and, worse, can interleave catalog writes. Collecting paths for a
 * quiet window and flushing once keeps the catalog consistent.
 */
export interface FolderChangeCoalescer {
  /** Record a changed root path and restart the quiet window. */
  push(path: string): void;
  /** Flush immediately (used on teardown or in tests). */
  flush(): void;
  /** Drop pending paths without flushing. */
  cancel(): void;
  /** Paths currently waiting for the window to close. */
  pending(): string[];
}

export function createFolderChangeCoalescer(
  onFlush: (paths: string[]) => void,
  delayMs = 800,
): FolderChangeCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let paths = new Set<string>();

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    clear();
    if (paths.size === 0) return;
    const batch = [...paths];
    paths = new Set();
    onFlush(batch);
  };

  return {
    push(path) {
      paths.add(path);
      clear();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      clear();
      paths = new Set();
    },
    pending() {
      return [...paths];
    },
  };
}

export interface FolderWatchError {
  path: string;
  error: unknown;
}

export interface WatcherApi {
  watch: (path: string) => Promise<void>;
  unwatch: (path: string) => Promise<void>;
}

/**
 * Bring native watchers in line with the explicitly registered library roots.
 * Re-running this is safe: already watched roots are left alone, removed roots
 * are unwatched, and per-root failures are returned instead of hidden.
 */
export async function syncFolderWatchers(
  roots: string[],
  currentlyWatched: Iterable<string>,
  api: WatcherApi,
): Promise<{ watched: Set<string>; errors: FolderWatchError[] }> {
  const desired = new Set(roots);
  const watched = new Set(currentlyWatched);
  const errors: FolderWatchError[] = [];

  for (const path of [...watched]) {
    if (desired.has(path)) continue;
    try {
      await api.unwatch(path);
      watched.delete(path);
    } catch (error) {
      errors.push({ path, error });
    }
  }

  for (const path of desired) {
    if (watched.has(path)) continue;
    try {
      await api.watch(path);
      watched.add(path);
    } catch (error) {
      errors.push({ path, error });
    }
  }

  return { watched, errors };
}

export interface AutoImportController {
  /** Record a native folder-changed event. */
  changed(path: string): void;
  /** Flush pending roots immediately (tests / teardown). */
  flush(): void;
  /** Wait for scans started by a flush to settle. */
  drain(): Promise<void>;
  cancel(): void;
  pending(): string[];
}

/**
 * Auto-import is a behavior, not just a watcher: every coalesced event is
 * re-checked against the current setting, so turning auto-import off takes
 * effect even for events that arrived moments earlier. Scans are serialized
 * per path by the native scan command, and failures are surfaced by the caller.
 */
export function createAutoImportController(options: {
  isEnabled: () => boolean;
  scan: (path: string) => Promise<void>;
  onError: (path: string, error: unknown) => void;
  delayMs?: number;
}): AutoImportController {
  const inFlight = new Set<Promise<void>>();
  const coalescer = createFolderChangeCoalescer((paths) => {
    if (!options.isEnabled()) return;
    for (const path of paths) {
      let task: Promise<void>;
      task = options
        .scan(path)
        .catch((error) => options.onError(path, error))
        .finally(() => {
          inFlight.delete(task);
        });
      inFlight.add(task);
    }
  }, options.delayMs ?? 800);

  return {
    changed: (path) => coalescer.push(path),
    flush: () => coalescer.flush(),
    drain: async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    cancel: () => coalescer.cancel(),
    pending: () => coalescer.pending(),
  };
}
