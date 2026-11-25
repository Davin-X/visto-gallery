// Shortcut list shown from the help button in the viewer bar.
export function buildShortcuts(kind: string | undefined) {
  const photo = kind === "photo";
  const still = photo || kind === "raw";
  const rows: Array<{ keys: string[]; label: string }> = [
    { keys: ["←", "→", "J", "K", "Space"], label: "Navigate" },
    { keys: ["↑", "↓"], label: "Zoom" },
  ];
  if (photo) rows.push({ keys: ["R", "X"], label: "Rotate / flip" });
  rows.push({ keys: ["0"], label: "Reset zoom" });
  if (still) rows.push({ keys: ["1"], label: "200%" });
  rows.push(
    { keys: ["L"], label: "Favorite" },
    { keys: ["F"], label: "Full screen" },
    { keys: ["Esc"], label: "Close" },
  );
  return rows;
}
