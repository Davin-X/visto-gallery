import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type { MediaItem } from "../types/media";
import { useLibraryStore } from "./useLibraryStore";

interface ViewerState {
  // State
  isOpen: boolean;
  zoom: number;
  fitMode: "fit" | "actual" | "fill";
  rotation: number; // 0, 90, 180, 270
  flipX: boolean; // horizontal flip

  // Actions
  open: (itemId?: string) => void;
  close: () => void;
  navigate: (delta: number) => void;
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  toggleFitMode: () => void;
  setRotation: (deg: number) => void;
  rotate: (delta: number) => void;
  toggleFlip: () => void;
  resetTransform: () => void;
  toggleFullscreen: () => Promise<void>;
}

export const useViewerStore = create<ViewerState>()(
  devtools(
    (set, get) => ({
      isOpen: false,
      zoom: 100,
      fitMode: "fit",
      rotation: 0,
      flipX: false,

      open: (itemId) => {
        const { inspectedId, viewerItems, viewerSelected } =
          useLibraryStore.getState();
        const targetId = itemId || inspectedId || viewerSelected?.id;
        if (targetId) {
          // Opening the viewer moves inspection only - the user's
          // multi-selection must survive a trip through the viewer.
          useLibraryStore.getState().inspectItem(targetId);
          set({
            isOpen: true,
            zoom: 100,
            fitMode: "fit",
            rotation: 0,
            flipX: false,
          });
        }
      },

      close: () => set({ isOpen: false, zoom: 100, rotation: 0, flipX: false }),

      navigate: (delta) => {
        const { viewerItems, viewerSelected } = useLibraryStore.getState();
        if (!viewerSelected || viewerItems.length === 0) return;
        const currentIndex = viewerItems.findIndex(
          (i) => i.id === viewerSelected.id,
        );
        const nextIndex =
          (currentIndex + delta + viewerItems.length) % viewerItems.length;
        useLibraryStore.getState().inspectItem(viewerItems[nextIndex].id);
        // Each photo starts untransformed - a rotation applied to one image
        // must not leak onto the next one.
        set({ rotation: 0, flipX: false });
      },

      setZoom: (zoom) => set({ zoom: Math.max(25, Math.min(300, zoom)) }),

      zoomIn: () => set((s) => ({ zoom: Math.min(300, s.zoom + 25) })),

      zoomOut: () => set((s) => ({ zoom: Math.max(25, s.zoom - 25) })),

      resetZoom: () => set({ zoom: 100, fitMode: "fit" }),

      toggleFitMode: () =>
        set((s) => ({
          fitMode:
            s.fitMode === "fit"
              ? "actual"
              : s.fitMode === "actual"
                ? "fill"
                : "fit",
          zoom: 100,
        })),

      setRotation: (deg) => set({ rotation: ((deg % 360) + 360) % 360 }),

      rotate: (delta) =>
        set((s) => ({ rotation: (((s.rotation + delta) % 360) + 360) % 360 })),

      toggleFlip: () => set((s) => ({ flipX: !s.flipX })),

      resetTransform: () => set({ rotation: 0, flipX: false }),

      toggleFullscreen: async () => {
        try {
          if (document.fullscreenElement) {
            await document.exitFullscreen();
          } else {
            await document.querySelector(".viewer-stage")?.requestFullscreen();
          }
        } catch {
          if (import.meta.env.DEV) console.warn("Fullscreen not available");
        }
      },
    }),
    { name: "viewer-store" },
  ),
);

export const useViewerOpen = () => useViewerStore((s) => s.isOpen);
export const useViewerZoom = () => useViewerStore((s) => s.zoom);
export const useViewerFitMode = () => useViewerStore((s) => s.fitMode);
export const useViewerRotation = () => useViewerStore((s) => s.rotation);
export const useViewerFlipX = () => useViewerStore((s) => s.flipX);
