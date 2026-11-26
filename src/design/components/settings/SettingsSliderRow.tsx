import type { CSSProperties } from "react";

/** Labeled range slider row with live percentage fill and formatted value readout. */
export function SettingsSliderRow({
  label,
  description,
  value,
  min,
  max,
  step,
  unit,
  ariaLabel,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  const progress = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <b>{label}</b>
        <span className="settings-row-desc">{description}</span>
      </div>
      <div className="settings-row-control" style={{ alignItems: "center" }}>
        <input
          type="range"
          className="settings-slider"
          style={{ "--slider-progress": progress } as CSSProperties}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={ariaLabel}
        />
        <span className="settings-slider-value">
          {value}
          {unit}
        </span>
      </div>
    </div>
  );
}
