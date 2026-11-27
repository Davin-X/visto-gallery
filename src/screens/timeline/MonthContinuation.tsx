import { useEffect, useRef, useState } from "react";
import type { LibraryFilterDTO } from "../../engine/types/commands";
import { useLibraryStore } from "../../engine/stores/useLibraryStore";
import { loadTimelinePage } from "./loadTimelinePage";

// One queue across all mounted month sentinels. Re-check visibility before
// starting queued work so a jump or Option-click drops obsolete requests.
const store = useLibraryStore;
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
  requested = false,
}: {
  month: string;
  view: string;
  filter: LibraryFilterDTO;
  cursor: string | null;
  requested?: boolean;
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
        await loadTimelinePage(store, filter, view, month, cursor, () => live);
      } catch {
        if (live) setFailed(true);
      }
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        if ((requested || entry.isIntersecting) && !started) {
          pending.add(fetchPage);
          drain();
        } else pending.delete(fetchPage);
      },
      { rootMargin: "240px" },
    );
    if (requested) {
      pending.add(fetchPage);
      drain();
    }
    observer.observe(marker.current!);
    return () => {
      live = false;
      pending.delete(fetchPage);
      observer.disconnect();
    };
    // The view key identifies the filter across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, view, cursor, attempt, requested]);
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
