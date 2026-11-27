import { useEffect, useRef, useState } from "react";
import { tauri } from "../../engine/commands/tauri";
import type { LibraryFilterDTO } from "../../engine/types/commands";
import { useLibraryStore } from "../../engine/stores/useLibraryStore";
import { timelineKey } from "./monthCache";

// One queue across all mounted month sentinels. Re-check visibility before
// starting queued work so a jump or Option-click drops obsolete requests.
const pending = new Set<() => Promise<void>>();
let running = 0;
function drain() {
  while (running < 2 && pending.size) {
    const task = pending.values().next().value!;
    pending.delete(task);
    running++;
    void task().finally(() => {
      running--;
      drain();
    });
  }
}

export function MonthContinuation({
  month,
  view,
  filter,
  cursor,
}: {
  month: string;
  view: string;
  filter: LibraryFilterDTO;
  cursor: string | null;
}) {
  const marker = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let live = true;
    let started = false;
    const fetchPage = async () => {
      if (started || !live) return;
      started = true;
      try {
        const query = filter.hidden ? tauri.library.getHiddenItems : tauri.library.getItems;
        const page = await query({
          ...filter,
          month,
          cursor: cursor ?? undefined,
          limit: 250,
          sortBy: "capturedAt",
          sortOrder: "desc",
        });
        const state = useLibraryStore.getState();
        if (!live || timelineKey(state, !!filter.hidden) !== view) return;
        const pages = new Map(state.timelineCache?.view === view ? state.timelineCache.pages : []);
        const previous = pages.get(month);
        if ((previous?.nextCursor ?? null) !== cursor) return;
        if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor))
          throw Error("Invalid month cursor");
        pages.set(month, {
          items: [...(previous?.items ?? []), ...page.items],
          nextCursor: page.hasMore ? page.nextCursor! : null,
        });
        useLibraryStore.setState({ timelineCache: { view, pages } });
        state.refreshDerived();
      } catch {
        if (live) setFailed(true);
      }
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started) {
          pending.add(fetchPage);
          drain();
        } else pending.delete(fetchPage);
      },
      { rootMargin: "240px" },
    );
    observer.observe(marker.current!);
    return () => {
      live = false;
      pending.delete(fetchPage);
      observer.disconnect();
    };
    // The view key identifies the filter across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, view, cursor, attempt]);
  return (
    <div className="timeline-continuation" ref={marker}>
      {failed ? (
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            retry(attempt + 1);
          }}
        >
          Retry loading items
        </button>
      ) : (
        <span role="status">Loading items…</span>
      )}
    </div>
  );
}
