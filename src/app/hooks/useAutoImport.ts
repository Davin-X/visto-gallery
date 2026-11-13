import { useEffect, useRef } from "react";
import { tauri, events } from "../../engine/commands/tauri";
import { useLibraryStore, useSettingsStore } from "../../engine/stores";
import { createAutoImportController, syncFolderWatchers } from "../../engine/utils/folderWatcher";
import { errorCode } from "../../engine/types/errors";
import type { ErrorCode } from "../../engine/types/commands";
import { describeError } from "../utils/describeError";

interface UseAutoImportOptions {
  settingsHydrated: boolean;
  showNotice: (text: string, code?: ErrorCode) => void;
  showErrorNotice: (error: unknown, prefix?: string) => void;
}

const isTauriRuntime = () =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/**
 * Keep the catalog in step with the registered source folders:
 * - native folder watchers follow the source list and the autoImport setting,
 * - watcher change events re-scan the changed root (debounced by the
 *   controller) while autoImport is on,
 * - one cleanup scan per launch drops rows for files deleted while closed.
 */
export function useAutoImport({
  settingsHydrated,
  showNotice,
  showErrorNotice,
}: UseAutoImportOptions) {
  const watchedRootsRef = useRef<Set<string>>(new Set());

  // Folder-change and watch-error events from the native watchers.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const controller = createAutoImportController({
      isEnabled: () => useSettingsStore.getState().autoImport,
      scan: async (path) => {
        await tauri.library.scan(path, false);
        await useLibraryStore.getState().loadLibrary();
        await useLibraryStore.getState().loadFolders();
      },
      onError: (path, error) => {
        useLibraryStore
          .getState()
          .showErrorNotice(error, `Could not auto-import changes from ${path}`);
      },
    });
    const keep = (unlisten: () => void) => {
      if (cancelled) unlisten();
      else unlisteners.push(unlisten);
    };

    void (async () => {
      keep(
        await events.onFolderChanged((path) => {
          controller.changed(path);
        }),
      );
      keep(
        await events.onFolderWatchError(({ path, message }) => {
          const library = useLibraryStore.getState();
          const folder = library.folders.find((f) => f.path === path);
          if (folder && !folder.available) return;
          library.showNotice(
            `Folder watching stopped for ${path}: ${message}. Check the folder's macOS access permissions and restore or remove the source if needed.`,
            "io",
          );
        }),
      );
    })();

    return () => {
      cancelled = true;
      controller.cancel();
      unlisteners.forEach((un) => un());
    };
  }, []);

  // Restore native watchers for explicitly registered roots after launch and
  // whenever sources change. Turning auto-import off also stops watching, so
  // the setting describes actual behavior rather than only future scans.
  const autoImport = useSettingsStore((s) => s.autoImport);
  const folderSignature = useLibraryStore((s) =>
    s.folders
      .map((folder) => folder.path)
      .sort()
      .join("\n"),
  );
  useEffect(() => {
    if (!settingsHydrated || !isTauriRuntime()) return;
    let cancelled = false;

    const sync = async () => {
      const roots = autoImport
        ? await tauri.library.getRoots().catch((error) => {
            if (!cancelled) {
              showErrorNotice(error, "Could not read library sources for folder watching");
            }
            return [] as string[];
          })
        : [];
      if (cancelled) return;
      // A deleted source is "missing", not a permissions problem — don't try to
      // watch it and don't report an access error. The Sources UI shows it.
      const missing = new Set(
        useLibraryStore
          .getState()
          .folders.filter((folder) => !folder.available)
          .map((folder) => folder.path),
      );
      const watchable = roots.filter((path) => !missing.has(path));
      const result = await syncFolderWatchers(watchable, watchedRootsRef.current, {
        watch: (path) => tauri.library.watchFolder(path),
        unwatch: (path) => tauri.library.unwatchFolder(path),
      });
      if (cancelled) return;
      watchedRootsRef.current = result.watched;
      for (const failure of result.errors) {
        const detail = describeError(failure.error);
        // Missing sources are handled by the Sources UI; don't spam a
        // permissions-style error while the folder is gone or mid-remount.
        if (errorCode(failure.error) === "missingSource") continue;
        showNotice(
          `Could not ${watchable.includes(failure.path) ? "watch" : "stop watching"} ${failure.path}: ${detail}. Check macOS folder access permissions.`,
          "io",
        );
      }
    };

    void sync();
    return () => {
      cancelled = true;
    };
  }, [settingsHydrated, autoImport, folderSignature, showErrorNotice, showNotice]);

  // Startup deletion scan: detect files removed from Finder while the app was
  // closed, so they never linger as stale catalog rows. This runs once per
  // launch regardless of the autoImport setting. Unchanged files are skipped
  // quickly via the size/modified_at fast path, so this is a lightweight
  // cleanup pass rather than a full re-import.
  useEffect(() => {
    if (!settingsHydrated || !isTauriRuntime()) return;
    let cancelled = false;
    void (async () => {
      const [roots, folders] = await Promise.all([
        tauri.library.getRoots().catch(() => [] as string[]),
        tauri.library.getFolders().catch(() => []),
      ]);
      if (cancelled || roots.length === 0) return;
      const missing = new Set(folders.filter((f) => !f.available).map((f) => f.path));
      for (const root of roots) {
        if (cancelled) break;
        if (missing.has(root)) continue;
        await tauri.library.scan(root, false).catch(() => {});
      }
      if (cancelled) return;
      await useLibraryStore.getState().loadLibrary();
      await useLibraryStore.getState().loadFolders();
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsHydrated]);
}
