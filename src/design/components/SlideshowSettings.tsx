import type { SlideshowTransition } from "../../engine/stores";

export function SlideshowSettings({
  interval,
  shuffle,
  transition,
  onIntervalChange,
  onShuffleChange,
  onTransitionChange,
  onClose,
}: {
  interval: number;
  shuffle: boolean;
  transition: SlideshowTransition;
  onIntervalChange: (interval: number) => void;
  onShuffleChange: (shuffle: boolean) => void;
  onTransitionChange: (transition: SlideshowTransition) => void;
  onClose: () => void;
}) {
  return (
    <div className="slideshow-settings-pop" role="dialog" aria-label="Slideshow settings">
      <div className="slideshow-settings-head">
        <b>Slideshow</b>
        <button type="button" onClick={onClose} aria-label="Close settings">
          ×
        </button>
      </div>

      <label className="slideshow-setting">
        <span>
          Interval <i>{interval}s</i>
        </span>
        <input
          type="range"
          min={2}
          max={30}
          step={1}
          value={interval}
          onChange={(e) => onIntervalChange(Number(e.target.value))}
        />
      </label>

      <label className="slideshow-setting row">
        <input
          type="checkbox"
          checked={shuffle}
          onChange={(e) => onShuffleChange(e.target.checked)}
        />
        <span>Shuffle</span>
      </label>

      <label className="slideshow-setting">
        <span>Transition</span>
        <select
          value={transition}
          onChange={(e) => onTransitionChange(e.target.value as SlideshowTransition)}
        >
          <option value="fade">Fade</option>
          <option value="slide">Slide</option>
          <option value="none">None</option>
        </select>
      </label>
    </div>
  );
}
