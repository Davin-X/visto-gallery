import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import VideoPlayer from "../design/components/VideoPlayer";
import { ChevronLeftIcon, FilmstripIcon, MoreIcon } from "../design/components/icons";
import { usePlaybackStore } from "../engine/stores/usePlaybackStore";
import { formatDuration } from "../engine/utils/time";
import type { MediaItem } from "../engine/types/media";

/**
 * The elapsed / total readout is the only per-tick value on the screen.
 * Isolating it in its own component keeps the header row and the queue strip
 * from re-rendering on every playback timeupdate.
 */
function PlaybackTimeChip({ itemDuration }: { itemDuration?: number | null }) {
  const time = usePlaybackStore((state) => state.time);
  const duration = usePlaybackStore((state) => state.duration);
  return (
    <span
      className="video-player-meta-chip video-player-meta-chip-time"
      title="Elapsed / total duration"
    >
      <span>{formatDuration(time)}</span>
      <span className="video-player-meta-sep" aria-hidden="true">
        /
      </span>
      <span>{formatDuration(duration || itemDuration || 0)}</span>
    </span>
  );
}

interface VideoPlayerScreenProps {
  active: boolean;
  item: MediaItem | null;
  queue: MediaItem[];
  queueAutoPlayItemId: string | null;
  assetUrl: (path: string) => string;
  onBack: () => void;
  onSelect: (id: string) => void;
  onPrevious: () => boolean;
  onNext: () => boolean | Promise<boolean>;
  queueHasMore?: boolean;
  onLoadMoreQueue?: () => unknown;
  /** Opens the shared item menu for a queue video or the one playing. */
  onContextMenu?: (item: MediaItem, event: ReactMouseEvent) => void;
}

export default function VideoPlayerScreen({
  active,
  item,
  queue,
  queueAutoPlayItemId,
  assetUrl,
  onBack,
  onSelect,
  onPrevious,
  onNext,
  queueHasMore = false,
  onLoadMoreQueue,
  onContextMenu,
}: VideoPlayerScreenProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLElement | null>(null);
  const queueStripRef = useRef<HTMLDivElement | null>(null);
  const loadMoreLockRef = useRef(false);
  const currentIndex = queue.findIndex((video) => video.id === item?.id);

  useEffect(() => {
    const element = screenRef.current;
    if (!element) return;
    if (active) element.removeAttribute("inert");
    else element.setAttribute("inert", "");
  }, [active]);

  useEffect(() => {
    loadMoreLockRef.current = false;
  }, [queue.length]);

  useEffect(() => {
    if (!active || !item?.id) return;
    const strip = queueStripRef.current;
    if (!strip) return;
    const activeEl = strip.querySelector<HTMLElement>(`[data-queue-id="${CSS.escape(item.id)}"]`);
    activeEl?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, item?.id]);

  const maybeLoadMoreQueue = useCallback(() => {
    if (!queueHasMore || !onLoadMoreQueue || loadMoreLockRef.current) return;
    const strip = queueStripRef.current;
    if (!strip) return;
    const remaining = strip.scrollWidth - strip.clientWidth - strip.scrollLeft;
    if (remaining > 240) return;
    loadMoreLockRef.current = true;
    Promise.resolve(onLoadMoreQueue()).finally(() => {
      loadMoreLockRef.current = false;
    });
  }, [queueHasMore, onLoadMoreQueue]);

  useEffect(() => {
    if (!active) return;
    maybeLoadMoreQueue();
  }, [active, queue.length, queueHasMore, maybeLoadMoreQueue]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await stageRef.current?.requestFullscreen();
      }
    } catch (error) {
      if (import.meta.env.DEV) console.warn("Unable to toggle video fullscreen", error);
    }
  }, []);

  if (!item) return null;

  return (
    <section
      ref={screenRef}
      className={`video-player-screen${active ? " video-player-screen-active" : " video-player-screen-background"}`}
      aria-hidden={!active}
    >
      <header className="page-heading video-player-heading">
        <button
          type="button"
          className="video-player-back"
          onClick={onBack}
          aria-label="Back to previous screen"
          title="Back to previous screen"
        >
          <ChevronLeftIcon size={17} strokeWidth={2.1} />
        </button>
        <div className="video-player-title">
          <h1 title={item.name}>{item.name}</h1>
          <span className="video-player-meta">
            <PlaybackTimeChip itemDuration={item.duration} />
            {currentIndex >= 0 && (
              <span
                className="video-player-meta-chip"
                title={`Video ${currentIndex + 1} of ${queue.length.toLocaleString()} in this queue`}
              >
                <FilmstripIcon size={11} strokeWidth={2} />
                <span>{currentIndex + 1}</span>
                <span className="video-player-meta-sep" aria-hidden="true">
                  of
                </span>
                <span>{queue.length.toLocaleString()}</span>
              </span>
            )}
          </span>
        </div>
        <button
          type="button"
          className="video-player-more"
          onClick={(event) => onContextMenu?.(item, event)}
          aria-label="More actions for this video"
          aria-haspopup="menu"
          title="More actions"
        >
          <MoreIcon size={16} />
        </button>
      </header>

      <div
        className="video-player-stage"
        ref={stageRef}
        onContextMenu={(event) => onContextMenu?.(item, event)}
      >
        <VideoPlayer
          itemId={item.id}
          active={active}
          src={assetUrl(item.path)}
          path={item.path}
          name={item.name}
          width={item.width}
          height={item.height}
          compact={!active}
          forceAutoPlay={queueAutoPlayItemId === item.id}
          onFullscreen={() => void toggleFullscreen()}
          onNext={onNext}
          onPrevious={onPrevious}
        />
      </div>

      <footer className="video-player-queue">
        <div className="video-player-queue-heading">
          <div className="video-player-queue-summary">
            <span className="video-player-queue-label">Up next</span>
            <span>
              {queue.length === 1 ? "1 video" : `${queue.length} videos`}
              {queueHasMore ? " · scroll for more" : ""}
            </span>
          </div>
        </div>
        <div className="video-player-queue-strip" ref={queueStripRef} onScroll={maybeLoadMoreQueue}>
          {queue.map((video, index) => (
            <button
              type="button"
              key={video.id}
              data-queue-id={video.id}
              className={video.id === item.id ? "video-queue-item active" : "video-queue-item"}
              onClick={() => onSelect(video.id)}
              onContextMenu={(event) => onContextMenu?.(video, event)}
              aria-label={`Play ${video.name}`}
              aria-current={video.id === item.id ? "true" : undefined}
              title={video.name}
            >
              <span className="video-queue-thumbnail">
                <CachedThumbnail
                  itemId={video.id}
                  name={video.name}
                  size={128}
                  eager={active}
                  placeholderClassName="video-queue-placeholder"
                />
                <span className="video-queue-index">{index + 1}</span>
                {video.duration ? (
                  <span className="video-queue-duration">{formatDuration(video.duration)}</span>
                ) : null}
              </span>
              <span className="video-queue-name">{video.name}</span>
            </button>
          ))}
          {queueHasMore ? (
            <button
              type="button"
              className="video-queue-item video-queue-more"
              onClick={() => void onLoadMoreQueue?.()}
              aria-label="Load more videos"
              title="Load more videos"
            >
              <span className="video-queue-more-inner">Load more</span>
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}
