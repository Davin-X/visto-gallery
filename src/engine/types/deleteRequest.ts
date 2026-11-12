import type { MediaItem } from "./media";

/**
 * A pending "delete these items" request. Carries everything the confirmation
 * dialog needs to show *what* is going away (summary), and everything the
 * post-delete notice needs to offer an undo (undoItems — the full items, not
 * just ids, because restore needs paths and sizes).
 */
export interface DeleteRequest {
  ids: string[];
  summary?: string | null;
  undoItems?: MediaItem[];
}
