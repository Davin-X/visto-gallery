import { tauri } from "../../engine/commands/tauri";
import type { LibraryFilterDTO } from "../../engine/types/commands";
import type { LibraryState } from "../../engine/stores/library/types";
import { timelineKey } from "./monthCache";

export async function loadTimelinePage(
  store: { getState: () => LibraryState; setState: (patch: Partial<LibraryState>) => void },
  filter: LibraryFilterDTO,
  view: string,
  month: string,
  cursor: string | null,
  isCurrent = () => true,
) {
  const query = filter.hidden ? tauri.library.getHiddenItems : tauri.library.getItems;
  const page = await query({
    ...filter,
    month,
    cursor: cursor ?? undefined,
    limit: 250,
    sortBy: "capturedAt",
    sortOrder: "desc",
  });
  const state = store.getState();
  if (!isCurrent() || timelineKey(state, !!filter.hidden) !== view) return;
  const pages = new Map(state.timelineCache?.view === view ? state.timelineCache.pages : []);
  const previous = pages.get(month);
  if ((previous?.nextCursor ?? null) !== cursor) return;
  if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor))
    throw Error("Invalid month cursor");
  pages.set(month, {
    items: [...(previous?.items ?? []), ...page.items],
    nextCursor: page.hasMore ? page.nextCursor! : null,
  });
  store.setState({ timelineCache: { view, pages } });
  state.refreshDerived();
}
