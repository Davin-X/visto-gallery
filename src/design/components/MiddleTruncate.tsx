import { splitForMiddleTruncation } from "../../engine/utils/fileName";

/**
 * Text that, when too wide, is cut in the middle ("selective-foc…berries-0042")
 * rather than at the end, so names with a shared prefix stay distinguishable.
 * The full text is in the tooltip and the accessible name.
 */
export function MiddleTruncate({
  text,
  className,
  tailLength,
}: {
  text: string;
  className?: string;
  /** Characters kept visible at the end (default 10; fewer for short labels). */
  tailLength?: number;
}) {
  const [head, tail] = splitForMiddleTruncation(text, tailLength);
  return (
    <span className={`middle-truncate${className ? ` ${className}` : ""}`} title={text}>
      <span className="middle-truncate-head">{head}</span>
      {tail && <span className="middle-truncate-tail">{tail}</span>}
    </span>
  );
}
