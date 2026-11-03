/**
 * Return the platform-appropriate search keyboard shortcut label.
 * macOS -> "⌘F", everything else -> "Ctrl F".
 */
export function searchShortcutLabel(): string {
  if (typeof navigator === "undefined") return "⌘F";
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘F" : "Ctrl F";
}
