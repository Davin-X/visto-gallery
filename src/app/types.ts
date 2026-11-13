import type React from "react";
import type { ContextMenuItem } from "../design/components/ContextMenu";
import type { ErrorCode } from "../engine/types/commands";

/**
 * The fields the album dialogs and menus need. Both a full `Album` and an
 * `AlbumOverview` (the Albums screen's card data) satisfy it.
 */
export interface AlbumTarget {
  id: string;
  name: string;
  itemCount?: number;
}

/** Optional action button on a notice toast (e.g. Undo). */
export interface NoticeAction {
  label: string;
  run: () => void;
}

export type ShowNotice = (text: string, code?: ErrorCode, action?: NoticeAction) => void;
export type ShowErrorNotice = (error: unknown, prefix?: string) => void;
export type OpenContextMenu = (items: ContextMenuItem[], e: React.MouseEvent) => void;
