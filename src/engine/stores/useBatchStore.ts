import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { BatchExportRequest, BatchExportResult } from "../types/media";
import { tauri, events } from "../commands/tauri";
import { useLibraryStore } from "./useLibraryStore";

export type BatchFormat = "jpeg" | "png" | "webp" | "heic" | "avif" | "source";

interface BatchState {
  // Config
  outputFolder: string;
  pattern: string;
  format: BatchFormat;
  quality: number;
  stripMetadata: boolean;
  maxDimension: number | null;

  // UI State
  step: 1 | 2 | 3;
  busy: boolean;
  cancelRequested: boolean;
  progress: { current: number; total: number; currentFile: string } | null;
  stalled: boolean;
  result: BatchExportResult | null;
  error: string | null;

  // Actions
  setOutputFolder: (folder: string) => void;
  setPattern: (pattern: string) => void;
  setFormat: (format: BatchFormat) => void;
  setQuality: (quality: number) => void;
  setStripMetadata: (strip: boolean) => void;
  setMaxDimension: (dim: number | null) => void;
  setStep: (step: 1 | 2 | 3) => void;
  exportBatch: () => Promise<void>;
  cancelBatch: () => Promise<void>;
  reset: () => void;
}

const defaultConfig = {
  pattern: "{name}_{number}",
  format: "jpeg" as BatchFormat,
  quality: 88,
  stripMetadata: true,
  maxDimension: null,
};

export const useBatchStore = create<BatchState>()(
  devtools(
    (set, get) => ({
      ...defaultConfig,
      outputFolder: "",
      step: 1,
      busy: false,
      cancelRequested: false,
      progress: null,
      stalled: false,
      result: null,
      error: null,

      setOutputFolder: (outputFolder) => set({ outputFolder, error: null }),
      setPattern: (pattern) => set({ pattern }),
      setFormat: (format) => set({ format }),
      setQuality: (quality) =>
        set({ quality: Math.max(1, Math.min(100, quality)) }),
      setStripMetadata: (stripMetadata) => set({ stripMetadata }),
      setMaxDimension: (maxDimension) => set({ maxDimension }),
      setStep: (step) => set({ step }),

      exportBatch: async () => {
        const library = useLibraryStore.getState();
        const selected = new Set(library.selectedIds);
        const items = library.items.filter((item) => selected.has(item.id));
        const {
          outputFolder,
          pattern,
          format,
          quality,
          stripMetadata,
          maxDimension,
        } = get();

        if (items.length === 0) {
          set({
            error: "Select at least one item in the Library first.",
            result: null,
          });
          return;
        }
        if (!outputFolder.trim()) {
          set({
            error: "Choose an output folder before exporting.",
            result: null,
          });
          return;
        }

        set({
          busy: true,
          cancelRequested: false,
          error: null,
          result: null,
          step: 2,
          progress: { current: 0, total: items.length, currentFile: "" },
          stalled: false,
        });

        // Progress arrives from Rust between files. The listener is best-effort:
        // if the event bridge is unavailable the export still completes.
        let unlisten: (() => void) | undefined;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const stallMs = 15000;
        const armWatchdog = () => {
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            set({
              stalled: true,
              error: "Export appears stalled (no progress for 15s).",
            });
          }, stallMs);
        };
        const clearWatchdog = () => {
          if (watchdog) clearTimeout(watchdog);
          watchdog = undefined;
        };
        armWatchdog();

        try {
          unlisten = await events.onBatchProgress((progress) => {
            set({ progress, busy: true, stalled: false, error: null });
            armWatchdog();
          });
        } catch {
          unlisten = undefined;
        }

        try {
          const request: BatchExportRequest = {
            items: items.map((item, index) => ({
              id: item.id,
              sourcePath: item.path,
              index,
              kind: item.kind,
              date: item.capturedAt ?? item.modifiedAt,
            })),
            outputFolder: outputFolder.trim(),
            pattern: pattern.trim() || defaultConfig.pattern,
            format,
            quality: quality / 100,
            stripMetadata,
            maxDimension: maxDimension ?? undefined,
          };

          const result = await tauri.batch.export(request);
          clearWatchdog();
          set({
            busy: false,
            cancelRequested: false,
            progress: null,
            result,
            step: 3,
            stalled: false,
          });
        } catch (e) {
          clearWatchdog();
          set({
            busy: false,
            cancelRequested: false,
            progress: null,
            step: 2,
            error: String(e),
            result: null,
            stalled: false,
          });
        } finally {
          clearWatchdog();
          unlisten?.();
        }
      },

      cancelBatch: async () => {
        if (!get().busy || get().cancelRequested) return;
        set({ cancelRequested: true });
        try {
          await tauri.batch.cancel();
        } catch {
          set({
            cancelRequested: false,
            error: "Could not ask the export to stop.",
          });
        }
      },

      // Keep the destination so "Export another batch" does not make the user
      // pick the same folder again.
      reset: () =>
        set({
          ...defaultConfig,
          step: 1,
          busy: false,
          cancelRequested: false,
          progress: null,
          result: null,
          error: null,
          stalled: false,
        }),
    }),
    { name: "batch-store" },
  ),
);

export const useBatchConfig = () =>
  useBatchStore((s) => ({
    outputFolder: s.outputFolder,
    pattern: s.pattern,
    format: s.format,
    quality: s.quality,
    stripMetadata: s.stripMetadata,
    maxDimension: s.maxDimension,
  }));

export const useBatchState = () =>
  useBatchStore((s) => ({
    step: s.step,
    busy: s.busy,
    cancelRequested: s.cancelRequested,
    progress: s.progress,
    stalled: s.stalled,
    result: s.result,
    error: s.error,
  }));
