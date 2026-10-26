import { getTypeIdentity } from "../../engine/utils/mediaTypes";

export function KindBadge({ kind }: { kind: "photo" | "video" | "raw" }) {
  const { label, softColor, color } = getTypeIdentity(kind);
  return (
    <span
      className={`kind-badge ${kind}`}
      style={{ background: softColor, color }}
      title={label}
    >
      {label}
    </span>
  );
}

export function KindDot({ kind }: { kind: "photo" | "video" | "raw" }) {
  const { color } = getTypeIdentity(kind);
  return <span className={`kind-dot ${kind}`} style={{ background: color }} />;
}
