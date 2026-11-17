/**
 * Path maths for Finder "Open With". Kept apart from the hook so the "does
 * this folder need adding?" decision can be tested without a Tauri backend.
 */

/** The folder that owns a file: its parent directory. */
export function parentFolder(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
}

/**
 * True when `folder` is a library source or sits inside one. A file opened
 * from an already-indexed folder needs no "Add folder" offer — the import
 * already placed it in the library and a second one would only scan the same
 * tree again.
 */
export function isFolderInLibrary(folder: string, libraryFolders: string[]): boolean {
  const target = folder.replace(/\/+$/, "");
  return libraryFolders.some((root) => {
    const clean = root.replace(/\/+$/, "");
    return clean !== "" && (target === clean || target.startsWith(`${clean}/`));
  });
}
