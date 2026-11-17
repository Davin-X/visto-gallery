import { useEffect, useRef } from "react";
import { events, tauri } from "../../engine/commands/tauri";
import { useLibraryStore } from "../../engine/stores";
import type { OpenPath, ScanResult } from "../../engine/types/commands";
import type { ShowErrorNotice, ShowNotice } from "../types";
import { setScreen } from "../useNavigationStore";
import { isFolderInLibrary, parentFolder } from "../openWith";

interface UseOpenWithOptions {
  /** Play a library item: photos open in the viewer, videos in the player. */
  openViewer: (id: string) => void;
  /** Import files, or index a folder wholesale. */
  importPaths: (paths: string[]) => Promise<ScanResult | null>;
  showNotice: ShowNotice;
  showErrorNotice: ShowErrorNotice;
}

/**
 * Finder "Open With" / double-click.
 *
 * The paths arrive at the process, not the page, so Rust queues them and emits
 * `open-paths-pending`. The queue is the single source of truth: drain it on
 * mount (covers a cold launch that happened before the page existed) and again
 * on every wake-up. Draining empties the queue, so the two routes cannot both
 * deliver the same open.
 *
 * A file is imported on its own — never expanded to its folder — and played.
 * The folder is only offered as an "Add folder" action, because double-clicking
 * one photo must not sweep in every neighbour on disk.
 */
export function useOpenWith(options: UseOpenWithOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    // Drains run one after another: two wakes in a row must not import at the
    // same time, and each takes its own slice of the queue.
    let chain: Promise<void> = Promise.resolve();

    const play = async (paths: string[]) => {
      const { importPaths, openViewer, showNotice } = optionsRef.current;
      const result = await importPaths(paths);
      if (cancelled || !result?.items.length) return;

      // `import_files` orders by modification time, so the newest of a
      // multi-file open is the one that lands on screen.
      const item = result.items[0];
      // The imported file may sort outside the loaded page; the viewer needs
      // it in `items` to resolve the selection.
      useLibraryStore.getState().includeItem(item);
      openViewer(item.id);

      const folder = parentFolder(item.path);
      const libraryFolders = useLibraryStore.getState().folders.map((root) => root.path);
      if (folder !== "/" && !isFolderInLibrary(folder, libraryFolders)) {
        showNotice(`Opened “${item.name}”.`, undefined, {
          label: "Add folder",
          run: () => {
            void importPaths([folder]);
          },
        });
      }
    };

    const handle = async (paths: OpenPath[]) => {
      // Folders opened with the app are an explicit "index this folder", so
      // import them first and let the files below still take over the screen.
      for (const folder of paths.filter((entry) => entry.isDir)) {
        const result = await optionsRef.current.importPaths([folder.path]);
        if (cancelled) return;
        if (result?.items.length) setScreen("Library");
      }
      const files = paths.filter((entry) => !entry.isDir).map((entry) => entry.path);
      if (files.length) {
        if (cancelled) return;
        await play(files);
      }
    };

    const drain = () => {
      chain = chain
        .then(async () => {
          if (cancelled) return;
          const paths = await tauri.library.takePendingOpenPaths();
          if (cancelled || !paths.length) return;
          await handle(paths);
        })
        .catch((error: unknown) => {
          if (!cancelled) optionsRef.current.showErrorNotice(error, "Could not open the file");
        });
    };

    void drain();
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stop = await events.onOpenPathsPending(drain);
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        /* browser preview has no Tauri event bridge */
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
