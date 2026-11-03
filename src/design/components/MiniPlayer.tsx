import { useEffect, useState } from "react";
import { usePlaybackStore } from "../../engine/stores/usePlaybackStore";
import { formatDuration } from "../../engine/utils/time";
import { PauseIcon, PlayIcon, PictureInPictureIcon, VolumeIcon } from "./icons";
import {
  observePictureInPicture,
  supportsPictureInPicture,
  togglePictureInPicture,
} from "../../engine/utils/pictureInPicture";

/** Compact playback controls shown while the dedicated player is in the background. */
export function MiniPlayer({
  onExpand,
  onClose,
  onPrevious,
  onNext,
}: {
  onExpand: () => void;
  onClose: () => void;
  onPrevious: () => boolean;
  onNext: () => boolean | Promise<boolean>;
}) {
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
  const [pictureInPictureSupported, setPictureInPictureSupported] = useState(false);
  const [pictureInPictureError, setPictureInPictureError] = useState<string | null>(null);

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
      setPictureInPictureError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!itemId) return null;

  return (
    <div className="mini-player" role="region" aria-label="Now playing">
      <div className="mini-player-heading">
        <span className="mini-player-status">
          <span className={playing ? "mini-player-pulse playing" : "mini-player-pulse"} />
          {playing ? "NOW PLAYING" : "PAUSED"}
        </span>
        <button
          type="button"
          className="mini-player-button mini-player-close"
          onClick={onClose}
          aria-label="Stop playback"
          title="Stop playback"
        >
          ×
        </button>
      </div>

      <button type="button" className="mini-player-info" onClick={onExpand} title="Return to video">
        <span className="mini-player-name">{name || "Video"}</span>
        <span className="mini-player-mode">
          {pictureInPicture
            ? "Floating above your other windows"
            : playing
              ? "Audio continues while you browse photos"
              : "Playback paused"}
        </span>
        <span className="mini-player-return">Return to video player ↗</span>
      </button>

      <div className="mini-player-transport">
        <button
          type="button"
          className="mini-player-button"
          onClick={onPrevious}
          aria-label="Previous video"
          title="Previous video"
        >
          ‹
        </button>
        <button
          type="button"
          className="mini-player-button mini-player-play"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
        </button>
        <button
          type="button"
          className="mini-player-button"
          onClick={() => void onNext()}
          aria-label="Next video"
          title="Next video"
        >
          ›
        </button>
        <input
          type="range"
          className="mini-player-seek"
          min={0}
          max={duration || 0}
          step={0.05}
          value={Math.min(time, duration || 0)}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label={`Seek, ${formatDuration(time)} of ${formatDuration(duration)}`}
        />
        <span className="mini-player-time">{formatDuration(time)}</span>
        <button
          type="button"
          className="mini-player-button"
          onClick={toggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
        >
          <VolumeIcon size={14} muted={muted} />
        </button>
        <button
          type="button"
          className="mini-player-button mini-player-pip"
          onClick={() => void togglePip()}
          disabled={!pictureInPictureSupported}
          aria-label={pictureInPicture ? "Exit picture in picture" : "Enter picture in picture"}
          aria-pressed={pictureInPicture}
          title={
            pictureInPictureSupported
              ? pictureInPicture
                ? "Exit picture in picture"
                : "Picture in picture"
              : "Picture in picture is unavailable"
          }
        >
          <PictureInPictureIcon size={14} />
        </button>
      </div>
      {pictureInPictureError && (
        <p className="mini-player-error" role="status">
          {pictureInPictureError}
        </p>
      )}
    </div>
  );
}
