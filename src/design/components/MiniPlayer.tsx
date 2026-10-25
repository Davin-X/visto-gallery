import { usePlaybackStore } from "../../engine/stores/usePlaybackStore";
import { formatDuration } from "../../engine/utils/time";
import { PauseIcon, PlayIcon, VolumeIcon } from "./icons";

/**
 * Compact "now playing" bar shown when the user leaves the Viewer while a
 * video is playing. Playback itself lives in the still-mounted viewer; this
 * only surfaces transport controls and a way back to the full player.
 */
export function MiniPlayer({
  onExpand,
  onClose,
}: {
  onExpand: () => void;
  onClose: () => void;
}) {
  const itemId = usePlaybackStore((s) => s.itemId);
  const name = usePlaybackStore((s) => s.name);
  const playing = usePlaybackStore((s) => s.playing);
  const time = usePlaybackStore((s) => s.time);
  const duration = usePlaybackStore((s) => s.duration);
  const muted = usePlaybackStore((s) => s.muted);
  const toggle = usePlaybackStore((s) => s.toggle);
  const seek = usePlaybackStore((s) => s.seek);
  const toggleMute = usePlaybackStore((s) => s.toggleMute);

  if (!itemId) return null;

  return (
    <div className="mini-player" role="region" aria-label="Now playing">
      <button
        type="button"
        className="mini-player-info"
        onClick={onExpand}
        title="Return to the player"
      >
        <span className="mini-player-name">{name || "Video"}</span>
        <span className="mini-player-time">
          {formatDuration(time)} / {formatDuration(duration)}
        </span>
      </button>

      <button
        type="button"
        className="mini-player-button"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause" : "Play"}
      >
        {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
      </button>

      <input
        type="range"
        className="mini-player-seek"
        min={0}
        max={duration || 0}
        step={0.05}
        value={Math.min(time, duration || 0)}
        onChange={(event) => seek(Number(event.target.value))}
        aria-label="Seek"
      />

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
        className="mini-player-button mini-player-close"
        onClick={onClose}
        aria-label="Stop playback"
        title="Stop playback"
      >
        ×
      </button>
    </div>
  );
}
