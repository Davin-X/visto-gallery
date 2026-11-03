import { useCallback, useEffect, useRef, useState } from "react";
import VideoPlayer from "./VideoPlayer";
import { usePlaybackStore } from "../../engine/stores/usePlaybackStore";
import { formatDuration } from "../../engine/utils/time";
import type { MediaItem } from "../../engine/types/media";
import {
  PauseIcon,
  PlayIcon,
  PictureInPictureIcon,
  VolumeIcon,
} from "./icons";
import {
  observePictureInPicture,
  supportsPictureInPicture,
  togglePictureInPicture,
} from "../../engine/utils/pictureInPicture";

/**
 * Picture-in-picture-style floating video overlay. Shows the actual video
 * frame in a small, draggable window over the photo viewer so playback
 * continues visibly while the user browses photos.
 */
interface FloatingVideoPlayerProps {
  item: MediaItem;
  assetUrl: (path: string) => string;
  onExpand: () => void;
  onClose: () => void;
  onPrevious: () => boolean;
  onNext: () => boolean | Promise<boolean>;
}

export function FloatingVideoPlayer({
  item,
  assetUrl,
  onExpand,
  onClose,
  onPrevious,
  onNext,
}: FloatingVideoPlayerProps) {
  const videoRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const position = useRef({ x: 20, y: 20 });

  const itemId = usePlaybackStore((s) => s.itemId);
  const name = usePlaybackStore((s) => s.name);
  const playing = usePlaybackStore((s) => s.playing);
  const time = usePlaybackStore((s) => s.time);
  const duration = usePlaybackStore((s) => s.duration);
  const muted = usePlaybackStore((s) => s.muted);
  const element = usePlaybackStore((s) => s.element);
  const toggle = usePlaybackStore((s) => s.toggle);
  const seek = usePlaybackStore((s) => s.seek);
  const toggleMute = usePlaybackStore((s) => s.toggleMute);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const [pictureInPictureSupported, setPictureInPictureSupported] =
    useState(false);
  const [pictureInPictureError, setPictureInPictureError] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!element) {
      setPictureInPicture(false);
      setPictureInPictureSupported(false);
      setPictureInPictureError(null);
      return;
    }
    setPictureInPictureSupported(supportsPictureInPicture(element));
    setPictureInPictureError(null);
    return observePictureInPicture(element, setPictureInPicture);
  }, [element]);

  const togglePip = async () => {
    if (!element) return;
    setPictureInPictureError(null);
    try {
      await togglePictureInPicture(element);
    } catch (error) {
      setPictureInPictureError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  // Drag handling for repositioning the floating window.
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("button, input")) return;
      e.preventDefault();
      setIsDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY };
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDragging || !dragStart.current) return;
      position.current.x += e.clientX - dragStart.current.x;
      position.current.y += e.clientY - dragStart.current.y;
      dragStart.current = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => {
      setIsDragging(false);
      dragStart.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging]);

  if (!itemId) return null;

  return (
    <div
      className="floating-video-player"
      ref={videoRef}
      onMouseDown={onMouseDown}
      style={{
        position: "fixed",
        right: position.current.x,
        bottom: position.current.y,
        zIndex: 55,
      }}
      role="region"
      aria-label="Floating video player"
    >
      <div className="floating-video-frame">
        <VideoPlayer
          itemId={item.id}
          active={true}
          src={assetUrl(item.path)}
          path={item.path}
          name={item.name}
          compact
          onFullscreen={onExpand}
          onNext={onNext}
        />
      </div>

      <div className="floating-video-bar">
        <button
          type="button"
          className="floating-video-button floating-video-previous"
          onClick={() => void onPrevious()}
          aria-label="Previous video"
          title="Previous video"
        >
          ‹
        </button>
        <button
          type="button"
          className="floating-video-button floating-video-play"
          onClick={() => void toggle()}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
        </button>
        <button
          type="button"
          className="floating-video-button floating-video-next"
          onClick={() => void onNext()}
          aria-label="Next video"
          title="Next video"
        >
          ›
        </button>
        <input
          type="range"
          className="floating-video-seek"
          min={0}
          max={duration || 0}
          step={0.05}
          value={Math.min(time, duration || 0)}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label={`Seek, ${formatDuration(time)} of ${formatDuration(duration)}`}
        />
        <span className="floating-video-time">
          {formatDuration(time)} / {formatDuration(duration)}
        </span>
        <button
          type="button"
          className="floating-video-button floating-video-mute"
          onClick={() => void toggleMute()}
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
        >
          <VolumeIcon size={12} muted={muted} />
        </button>
        <button
          type="button"
          className="floating-video-button floating-video-expand"
          onClick={onExpand}
          aria-label="Return to full video player"
          title="Return to full video player"
        >
          ↥
        </button>
        <button
          type="button"
          className="floating-video-button floating-video-close"
          onClick={onClose}
          aria-label="Stop playback"
          title="Stop playback"
        >
          ×
        </button>
      </div>
      {pictureInPictureError && (
        <p className="floating-video-error" role="status">
          {pictureInPictureError}
        </p>
      )}
    </div>
  );
}

export default FloatingVideoPlayer;
