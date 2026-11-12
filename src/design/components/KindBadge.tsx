import { getTypeIdentity } from "../../engine/utils/mediaTypes";

export function KindBadge({ kind }: { kind: "photo" | "video" | "raw" }) {
  const { label } = getTypeIdentity(kind);
  return (
    <span className={`kind-badge ${kind}`} title={label}>
      {label}
    </span>
  );
}

export function KindDot({
  kind,
  variant = "solid",
}: {
  kind: "photo" | "video" | "raw";
  /** A filled dot marks a stored kind. A ring marks a derived row — Animations,
   *  Favorites, Hidden — which counts a subset of the real kinds rather than a
   *  kind of its own. Without the distinction, six rows showed four identical
   *  blue squares. */
  variant?: "solid" | "ring";
}) {
  return (
    <span className={`kind-dot ${kind}${variant === "ring" ? " ring" : ""}`} aria-hidden="true" />
  );
}
