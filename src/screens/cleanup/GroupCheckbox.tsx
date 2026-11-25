import { useEffect, useRef } from "react";

/** A checkbox that can show the mixed state for a partly selected group. */
export function GroupCheckbox({
  checked,
  mixed,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed && !checked;
  }, [checked, mixed]);
  return (
    <label className="cleanup-check">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
      />
    </label>
  );
}
