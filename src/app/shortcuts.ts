/** The native File > Export… menu item uses CmdOrCtrl+E. */
export function isExportShortcut(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  key: string;
  altKey?: boolean;
  shiftKey?: boolean;
}): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "e"
  );
}
