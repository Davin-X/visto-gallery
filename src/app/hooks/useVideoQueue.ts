import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tauri } from "../../engine/commands/tauri";
import { useLibraryStore, usePlaybackStore } from "../../engine/stores";
import type { LibraryFilterDTO } from "../../engine/types/commands";
import type { MediaItem } from "../../engine/types/media";
import { getAdjacentVideo } from "../backgroundVideo";

export type ViewerScope = "library" | "hidden";

interface QueuePaging {
  filter: LibraryFilterDTO;
  cursor: string | null;
  hasMore: boolean;
  pageSize: number;
  loading: boolean;
}

/** Paging for the library scope as it stands now; hidden queues never page. */
function libraryPaging(): QueuePaging {
  const state = useLibraryStore.getState();
  return {
    filter: state.getCurrentLibraryFilter(),
    cursor: state.nextCursor,
    hasMore: state.hasMore,
    pageSize: state.pageSize,
    loading: false,
  };
}

/**
 * The background video session: the item the player shows and a locked,
 * video-only queue. The queue is captured when playback starts from the
 * current browsing scope, so switching filters mid-playback never changes
 * what plays next. In the library scope it keeps paging the catalog.
 */
export function useVideoQueue() {
  const viewerItems = useLibraryStore((s) => s.viewerItems);
  const items = useLibraryStore((s) => s.items);

  // The player keeps its own selection while the photo viewer has an
  // independent cursor.
  const [backgroundVideo, setBackgroundVideo] = useState<MediaItem | null>(null);
  const [videoQueue, setVideoQueue] = useState<MediaItem[]>([]);
  const [queueAutoPlayId, setQueueAutoPlayId] = useState<string | null>(null);
  const pagingRef = useRef<QueuePaging | null>(null);

  const playbackItemId = usePlaybackStore((s) => s.itemId);
  const playing = usePlaybackStore((s) => s.playing);
  const playbackName = usePlaybackStore((s) => s.name);
  const storedPlaybackItem = useMemo(
    () => items.find((item) => item.id === playbackItemId) ?? null,
    [items, playbackItemId],
  );
  const playbackItem = backgroundVideo ?? storedPlaybackItem;

  const currentPlayingId = () => usePlaybackStore.getState().itemId ?? backgroundVideo?.id ?? null;

  const loadNextVideoPage = useCallback(async () => {
    const paging = pagingRef.current;
    if (!paging || !paging.hasMore || !paging.cursor || paging.loading) return [];

    paging.loading = true;
    try {
      const page = await tauri.library.getItems({
        ...paging.filter,
        limit: paging.pageSize,
        cursor: paging.cursor,
      });
      pagingRef.current = {
        ...paging,
        cursor: page.nextCursor ?? null,
        hasMore: page.hasMore,
        loading: false,
      };
      const knownIds = new Set(videoQueue.map((item) => item.id));
      const videos = page.items.filter((item) => item.kind === "video" && !knownIds.has(item.id));
      if (videos.length > 0) {
        setVideoQueue((current) => {
          const currentIds = new Set(current.map((item) => item.id));
          return [...current, ...videos.filter((item) => !currentIds.has(item.id))];
        });
      }
      return videos;
    } catch (error) {
      pagingRef.current = { ...paging, loading: false };
      useLibraryStore.getState().showErrorNotice(error, "Failed to load more videos");
      return [];
    }
  }, [videoQueue]);

  const playNextVideo = useCallback(async (): Promise<boolean> => {
    if (videoQueue.length === 0) return false;
    const currentId = usePlaybackStore.getState().itemId ?? backgroundVideo?.id ?? null;
    const currentIndex = videoQueue.findIndex((item) => item.id === currentId);
    let next: MediaItem | null = null;
    if (currentIndex === videoQueue.length - 1) {
      while (pagingRef.current?.hasMore && pagingRef.current.cursor) {
        const pageVideos = await loadNextVideoPage();
        if (pageVideos.length > 0) {
          next = pageVideos[0];
          break;
        }
        if (pagingRef.current?.loading) return false;
      }
    }
    next ??= getAdjacentVideo(videoQueue, currentId, 1);
    if (!next) return false;
    if (next.id === currentId) {
      usePlaybackStore.getState().toggle();
      return true;
    }

    setQueueAutoPlayId(next.id);
    setBackgroundVideo(next);
    return true;
  }, [videoQueue, backgroundVideo, loadNextVideoPage]);

  const playPreviousVideo = useCallback((): boolean => {
    if (videoQueue.length === 0) return false;
    const currentId = usePlaybackStore.getState().itemId ?? backgroundVideo?.id ?? null;
    const previous = getAdjacentVideo(videoQueue, currentId, -1);
    if (!previous) return false;
    if (previous.id === currentId) {
      const video = usePlaybackStore.getState().element;
      if (video) {
        video.currentTime = 0;
        void video.play().catch(() => {});
      }
      return true;
    }

    setQueueAutoPlayId(previous.id);
    setBackgroundVideo(previous);
    return true;
  }, [videoQueue, backgroundVideo]);

  // Capture the video-only queue once for a playback session. If the user
  // explicitly selects a video outside that queue, start a queue in the new
  // browsing scope; changing filters alone leaves the current queue intact.
  useEffect(() => {
    if (!playbackItemId) {
      if (!backgroundVideo) {
        if (videoQueue.length > 0) setVideoQueue([]);
        pagingRef.current = null;
        if (queueAutoPlayId !== null) setQueueAutoPlayId(null);
      }
      return;
    }

    if (videoQueue.length === 0) {
      const state = useLibraryStore.getState();
      const nextQueue = viewerItems.filter((item) => item.kind === "video");
      if (backgroundVideo && !nextQueue.some((item) => item.id === backgroundVideo.id))
        nextQueue.unshift(backgroundVideo);
      // Leave the queue empty when this scope has no playable videos yet:
      // writing a fresh [] reference would retrigger this effect through
      // its own `videoQueue` dependency until React throws #185. The queue
      // is rebuilt once `viewerItems` gains a playable video.
      if (nextQueue.length === 0) return;
      setVideoQueue(nextQueue);
      if (!pagingRef.current && state.viewerScope === "library") {
        pagingRef.current = libraryPaging();
      }
    }
  }, [playbackItemId, viewerItems, videoQueue, backgroundVideo]);

  useEffect(() => {
    if (queueAutoPlayId && playbackItemId === queueAutoPlayId && playing) {
      setQueueAutoPlayId(null);
    }
  }, [queueAutoPlayId, playbackItemId, playing]);

  const selectVideoItem = useCallback(
    (id: string) => {
      const item = videoQueue.find((candidate) => candidate.id === id);
      if (!item) return;
      setBackgroundVideo(item);
      setQueueAutoPlayId(id);
    },
    [videoQueue],
  );

  const navigateVideoQueue = useCallback(
    (delta: -1 | 1) => {
      if (delta > 0) {
        void playNextVideo();
        return;
      }
      const currentId = usePlaybackStore.getState().itemId ?? backgroundVideo?.id ?? null;
      const next = getAdjacentVideo(videoQueue, currentId, delta);
      if (!next) return;
      setBackgroundVideo(next);
      setQueueAutoPlayId(next.id);
    },
    [backgroundVideo, videoQueue, playNextVideo],
  );

  // Shared setup for a video playback session: scope the queue to the
  // session's collection and lock it, so later filter changes never rewrite
  // what plays next.
  const beginVideoSession = useCallback((item: MediaItem, scope: ViewerScope = "library") => {
    useLibraryStore.getState().setViewerScope(scope);
    // Silence every other <video> surface (slideshow, compare, inspector)
    // before this session starts, so the same file can't sound from two
    // players at once. The inspector preview and thumbnails are muted, so
    // this only ever hits the slideshow and stale players.
    document.querySelectorAll("video").forEach((video) => {
      try {
        video.pause();
      } catch {}
    });
    const libraryState = useLibraryStore.getState();
    const scopedVideos = libraryState.viewerItems.filter((candidate) => candidate.kind === "video");
    if (!scopedVideos.some((candidate) => candidate.id === item.id)) scopedVideos.unshift(item);
    setVideoQueue(scopedVideos);
    pagingRef.current = scope === "library" ? libraryPaging() : null;
    setBackgroundVideo(item);
  }, []);

  /** End the session entirely: stop playback and drop the queue. */
  const stopVideoSession = useCallback(() => {
    usePlaybackStore.getState().stop();
    setBackgroundVideo(null);
    setVideoQueue([]);
    pagingRef.current = null;
    setQueueAutoPlayId(null);
  }, []);

  /**
   * Keep a playback session honest after a delete. When the video that was
   * playing is the one trashed, drop the removed rows from the locked queue
   * and start the next video (or end the session) instead of leaving the
   * player on a catalog row that no longer exists. Returns true when the
   * session ended because nothing playable is left.
   */
  const reconcilePlaybackAfterDelete = (deletedIds: string[]): boolean => {
    const state = useLibraryStore.getState();
    const stillThere = new Set(
      [...state.items, ...state.hiddenItems].map((candidate) => candidate.id),
    );
    const gone = new Set(deletedIds.filter((id) => !stillThere.has(id)));
    if (gone.size === 0) return false;
    const playlist = videoQueue.filter((video) => !gone.has(video.id));
    if (playlist.length !== videoQueue.length) setVideoQueue(playlist);
    const playingId = currentPlayingId();
    if (!playingId || !gone.has(playingId)) {
      // Something else in the queue went away; playback itself is fine.
      if (backgroundVideo && gone.has(backgroundVideo.id)) setBackgroundVideo(null);
      return false;
    }
    const removedIndex = videoQueue.findIndex((video) => video.id === playingId);
    const next =
      videoQueue.slice(removedIndex + 1).find((video) => !gone.has(video.id)) ??
      videoQueue
        .slice(0, Math.max(0, removedIndex))
        .reverse()
        .find((video) => !gone.has(video.id)) ??
      null;
    if (next) {
      setBackgroundVideo(next);
      setQueueAutoPlayId(next.id);
      return false;
    }
    // Nothing left to play: end the session.
    stopVideoSession();
    return true;
  };

  return {
    playbackItem,
    playbackItemId,
    playbackName,
    playing,
    videoQueue,
    queueAutoPlayId,
    queueHasMore: Boolean(pagingRef.current?.hasMore),
    setBackgroundVideo,
    loadNextVideoPage,
    playNextVideo,
    playPreviousVideo,
    selectVideoItem,
    navigateVideoQueue,
    beginVideoSession,
    stopVideoSession,
    reconcilePlaybackAfterDelete,
  };
}
