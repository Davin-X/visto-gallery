import { useCallback, useEffect, useRef } from "react";
import { CachedThumbnail } from "../design/components/CachedThumbnail";
import VideoPlayer from "../design/components/VideoPlayer";
import { usePlaybackStore } from "../engine/stores/usePlaybackStore";
import { formatDuration } from "../engine/utils/time";
import type { MediaItem } from "../engine/types/media";

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
}: VideoPlayerScreenProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLElement | null>(null);
  const currentIndex = queue.findIndex((video) => video.id === item?.id);
  const time = usePlaybackStore((state) => state.time);
  const duration = usePlaybackStore((state) => state.duration);
  const queueStart =
    currentIndex < 0 ? 0 : Math.min(Math.max(0, currentIndex - 3), Math.max(0, queue.length - 12));
  const visibleQueue = queue.slice(queueStart, queueStart + 12);

  useEffect(() => {
    const element = screenRef.current;
    if (!element) return;
    if (active) element.removeAttribute("inert");
    else element.setAttribute("inert", "");
  }, [active]);

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
      <header className="video-player-heading">
        <button
          type="button"
          className="video-player-back"
          onClick={onBack}
          aria-label="Back to previous screen"
          title="Back to previous screen"
        >
          ‹
        </button>
        <div className="video-player-title">
          <p className="eyebrow">VIDEO PLAYER</p>
          <h1 title={item.name}>{item.name}</h1>
          <span>
            {formatDuration(time)} / {formatDuration(duration || item.duration || 0)}
            {currentIndex >= 0 ? ` · ${currentIndex + 1} of ${queue.length}` : ""}
          </span>
        </div>
        <span className="video-player-mode-label">VIDEO QUEUE</span>
      </header>

      <div className="video-player-stage" ref={stageRef}>
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
        />
      </div>

      <footer className="video-player-queue">
        <div className="video-player-queue-heading">
          <div>
            <p className="eyebrow">UP NEXT</p>
            <span>
              {queue.length === 1
                ? "1 video in this queue"
                : `${queue.length} videos in this queue`}
            </span>
          </div>
          <div className="video-player-queue-controls">
            <button type="button" onClick={onPrevious} aria-label="Previous video">
              ‹
            </button>
            <button type="button" onClick={() => void onNext()} aria-label="Next video">
              ›
            </button>
          </div>
        </div>
        <div className="video-player-queue-strip">
          {visibleQueue.map((video, index) => (
            <button
              type="button"
              key={video.id}
              className={video.id === item.id ? "video-queue-item active" : "video-queue-item"}
              onClick={() => onSelect(video.id)}
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
                <span className="video-queue-index">{queueStart + index + 1}</span>
                {video.duration ? (
                  <span className="video-queue-duration">{formatDuration(video.duration)}</span>
                ) : null}
              </span>
              <span className="video-queue-name">{video.name}</span>
            </button>
          ))}
        </div>
      </footer>
    </section>
  );
}
