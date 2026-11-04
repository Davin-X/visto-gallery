import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon, StopIcon } from "./icons";

interface NowPlayingProps {
  /** Track name as shown in the player. */
  name: string;
  playing: boolean;
  /** Jump back to the full player screen. */
  onExpand: () => void;
  onToggle: () => void;
  /** End the background session entirely. */
  onStop: () => void;
  /** Prev/next are offered only for multi-video sessions. */
  onPrevious?: () => void;
  onNext?: () => void;
}

/**
 * Slim "Now playing" chip for the top bar. Replaces the floating overlay:
 * it never covers gallery content, survives tab navigation, and stays
 * glanceable like macOS's own Now Playing menu item.
 */
export function NowPlaying({
  name,
  playing,
  onExpand,
  onToggle,
  onStop,
  onPrevious,
  onNext,
}: NowPlayingProps) {
  const sessionLabel = `Now playing: ${name}`;
  return (
    <div className="now-playing" role="group" aria-label="Now playing">
      <button
        type="button"
        className="now-playing-track"
        onClick={onExpand}
        title="Open player in player screen"
        aria-label={`${sessionLabel}. Open player.`}
      >
        <span className={`now-playing-eq${playing ? " playing" : ""}`} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="now-playing-name">{name}</span>
      </button>
      {onPrevious && (
        <button
          type="button"
          className="now-playing-btn"
          onClick={onPrevious}
          aria-label="Previous video"
          title="Previous video"
        >
          <ChevronLeftIcon size={13} />
        </button>
      )}
      <button
        type="button"
        className="now-playing-btn"
        onClick={onToggle}
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause" : "Play"}
      >
        {playing ? <PauseIcon size={13} /> : <PlayIcon size={13} />}
      </button>
      {onNext && (
        <button
          type="button"
          className="now-playing-btn"
          onClick={onNext}
          aria-label="Next video"
          title="Next video"
        >
          <ChevronRightIcon size={13} />
        </button>
      )}
      <button
        type="button"
        className="now-playing-btn"
        onClick={onStop}
        aria-label="Stop playback"
        title="Stop playback"
      >
        <StopIcon size={12} />
      </button>
    </div>
  );
}
