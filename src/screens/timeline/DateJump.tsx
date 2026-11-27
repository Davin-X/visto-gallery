import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "../../design/components/icons";

export function DateJump({
  years,
  jump,
}: {
  years: { year: string; months: { key: string; label: string; count: number }[] }[];
  jump: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = years.find((entry) => entry.year === year) ?? years[0];
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="date-jump"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        className="timeline-jump-month"
        type="button"
        ref={trigger}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Jump to month <ChevronDownIcon size={12} />
      </button>
      {open && current && (
        <div className="date-jump-panel">
          <label>
            Year{" "}
            <select value={current.year} onChange={(event) => setYear(event.target.value)}>
              {years.map((entry) => (
                <option key={entry.year}>{entry.year}</option>
              ))}
            </select>
          </label>
          <div className="date-jump-months">
            {current.months.map((month) => (
              <button
                type="button"
                key={month.key}
                aria-label={month.label}
                title={month.label}
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  jump(month.key);
                }}
              >
                {new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" }).format(
                  new Date(month.key + "-15T12:00:00Z"),
                )}
                <small>{month.count.toLocaleString()}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
