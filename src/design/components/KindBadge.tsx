import { getTypeIdentity } from "../../engine/utils/mediaTypes";

export function KindBadge({ kind }: { kind: "photo" | "video" | "raw" }) {
  const { label } = getTypeIdentity(kind);
  return (
    <span className={`kind-badge ${kind}`} title={label}>
      {label}
    </span>
  );
}

export function KindDot({ kind }: { kind: "photo" | "video" | "raw" }) {
  return <span className={`kind-dot ${kind}`} aria-hidden="true" />;
}
