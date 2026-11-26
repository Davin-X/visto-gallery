import type { MutableRefObject } from "react";

const GRID_HORIZONTAL_PADDING = 40;
const VIRTUAL_GRID_OVERSCAN_ROWS = 6;
const MAX_VIRTUAL_GRID_ITEMS = 480;

/** Pure row-window calculation for the fixed-height grid and overview cards. */
export function calculateVirtualGridWindow(
  itemCount: number,
  columns: number,
  rowStride: number,
  gap: number,
  scrollTop: number,
  viewportHeight: number,
) {
  const totalRows = Math.ceil(itemCount / columns);
  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / rowStride));
  const lastVisibleRow = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / rowStride));
  const startRow = Math.max(0, firstVisibleRow - VIRTUAL_GRID_OVERSCAN_ROWS);
  const requestedEndRow = Math.min(
    totalRows,
    Math.max(lastVisibleRow + VIRTUAL_GRID_OVERSCAN_ROWS, startRow + 1),
  );
  // Cap the DOM even on very wide monitors with many grid columns.
  const maxWindowRows = Math.max(1, Math.floor(MAX_VIRTUAL_GRID_ITEMS / columns));
  const endRow = Math.min(requestedEndRow, startRow + maxWindowRows);

  return {
    startIndex: startRow * columns,
    endIndex: Math.min(itemCount, endRow * columns),
    topSpacer: startRow ? Math.max(0, startRow * rowStride - gap) : 0,
    bottomSpacer: endRow < totalRows ? Math.max(0, (totalRows - endRow) * rowStride - gap) : 0,
  };
}

export function computeVirtualGridLayout({
  layout,
  thumbnailSize,
  showInspector,
  viewportWidth,
  measuredTileHeight,
}: {
  layout: string;
  thumbnailSize: string;
  showInspector?: boolean;
  viewportWidth: number;
  measuredTileHeight: number | null;
}) {
  const overview = layout === "overview";
  const gap = overview ? 20 : 16;
  const minTileWidth = overview
    ? 320
    : thumbnailSize === "small"
      ? 160
      : thumbnailSize === "large"
        ? 280
        : showInspector
          ? 210
          : 220;
  const availableWidth = Math.max(minTileWidth, viewportWidth - GRID_HORIZONTAL_PADDING);
  const columns = Math.max(1, Math.floor((availableWidth + gap) / (minTileWidth + gap)));
  const tileWidth = (availableWidth - gap * (columns - 1)) / columns;
  const estimatedTileHeight = tileWidth * (overview ? 10 / 16 : 1) + 58;
  const rowHeight = measuredTileHeight ?? estimatedTileHeight;
  return { columns, rowStride: rowHeight + gap, gap };
}

export interface VirtualScrollMetrics {
  columns: number;
  rowStride: number;
  itemIds: string[];
}

/**
 * Restore `top` on `container`. If `itemId` belongs to a virtualized row
 * outside the restored viewport, jump to that row first so the tile mounts
 * before fine-tuning with `scrollIntoView`.
 */
export function restoreScrollOffset(
  container: HTMLElement,
  top: number,
  itemId: string | null | undefined,
  restoringRef: MutableRefObject<boolean>,
  virtualMetrics?: VirtualScrollMetrics | null,
) {
  restoringRef.current = true;
  let targetTop = top;
  if (itemId && virtualMetrics && virtualMetrics.columns > 0 && virtualMetrics.rowStride > 0) {
    const idx = virtualMetrics.itemIds.indexOf(itemId);
    if (idx >= 0) {
      const rowTop = Math.floor(idx / virtualMetrics.columns) * virtualMetrics.rowStride;
      const rowBottom = rowTop + virtualMetrics.rowStride;
      const viewportHeight = container.clientHeight || 0;
      if (rowBottom < top || rowTop > top + viewportHeight) {
        targetTop = Math.max(
          0,
          rowTop - Math.max(0, (viewportHeight - virtualMetrics.rowStride) / 2),
        );
      }
    }
  }

  window.requestAnimationFrame(() => {
    container.scrollTo({ top: targetTop });
    window.requestAnimationFrame(() => {
      if (itemId) {
        const target = container.querySelector(
          `[data-item-id="${CSS.escape(itemId)}"]`,
        ) as HTMLElement | null;
        if (target) {
          const box = target.getBoundingClientRect();
          const host = container.getBoundingClientRect();
          if (box.bottom < host.top || box.top > host.bottom) {
            target.scrollIntoView({ block: "nearest", behavior: "auto" });
          }
        }
      }
      restoringRef.current = false;
    });
  });
}
