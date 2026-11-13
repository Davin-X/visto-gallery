import { useShallow } from "zustand/react/shallow";
import { useLibraryStore } from "../../engine/stores";
import { formatBytesSimple } from "../../engine/utils/mediaTypes";

/**
 * The floating progress pill shown while a scan, import, duplicate hash or
 * trash operation is running, with a Cancel button for the active operation.
 */
export function BusyIndicator() {
  const library = useLibraryStore(
    useShallow((s) => ({
      busy: s.busy,
      progress: s.progress,
      canceling: s.canceling,
      cancelDelete: s.cancelDelete,
      cancelScan: s.cancelScan,
    })),
  );
  if (!library.busy || !library.progress) return null;
  return (
    <div
      className={`busy-indicator ${library.progress.phase === "hashing" ? "busy-indicator-hashing" : ""}`}
      role="status"
    >
      <span className="spinner" />
      {library.progress.phase === "hashing"
        ? (() => {
            const bytesProcessed = library.progress.bytesProcessed ?? 0;
            const bytesTotal = library.progress.bytesTotal ?? 0;
            const filesProcessed = library.progress.filesProcessed ?? library.progress.processed;
            const filesTotal = library.progress.filesTotal ?? library.progress.total;
            const percent =
              bytesTotal > 0 ? Math.min(100, Math.round((bytesProcessed / bytesTotal) * 100)) : 0;
            return (
              <div className="busy-indicator-progress-copy">
                <b>
                  {bytesTotal > 0
                    ? `Checking duplicates · ${percent}%`
                    : filesTotal > 0
                      ? "Hashing candidates…"
                      : "Finding duplicate candidates…"}
                </b>
                <small>
                  {filesProcessed.toLocaleString()} of {filesTotal.toLocaleString()} candidate files
                  {bytesTotal > 0 &&
                    ` · ${formatBytesSimple(bytesProcessed)} of ${formatBytesSimple(bytesTotal)}`}
                </small>
                <div
                  className="busy-indicator-progress-track"
                  role="progressbar"
                  aria-label="Duplicate scan progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <span style={{ width: `${percent}%` }} />
                </div>
                {library.progress.currentFile && (
                  <small
                    className="busy-indicator-current-file"
                    title={library.progress.currentFile}
                  >
                    {library.progress.currentFile}
                  </small>
                )}
              </div>
            );
          })()
        : library.progress.phase === "trashing"
          ? (() => {
              const processed = library.progress.processed ?? 0;
              const total = library.progress.total ?? 0;
              const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
              return (
                <div className="busy-indicator-progress-copy">
                  <b>Moving to Trash · {percent}%</b>
                  <small>
                    {processed.toLocaleString()} of {total.toLocaleString()} files
                  </small>
                  <div
                    className="busy-indicator-progress-track"
                    role="progressbar"
                    aria-label="Trash progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <span style={{ width: `${percent}%` }} />
                  </div>
                </div>
              );
            })()
          : library.progress.phase === "reading"
            ? (() => (
                <div className="busy-indicator-progress-copy">
                  <b>Loading library…</b>
                  <small>Reading database</small>
                  <div
                    className="busy-indicator-progress-track"
                    role="progressbar"
                    aria-label="Loading library"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={0}
                  >
                    <span style={{ width: "0%" }} />
                  </div>
                </div>
              ))()
            : library.progress.phase === "scanning"
              ? (() => {
                  // Distinguish source-level vs file-level progress:
                  // - source-level: total <= number of folders (frontend sets it)
                  // - file-level: total = files in current folder (backend sets it)
                  // Heuristic: if currentFile is a directory path, it's source-level.
                  const isSourceLevel = library.progress.currentFile
                    ? library.progress.currentFile.endsWith("/") ||
                      !library.progress.currentFile.includes(".")
                    : true;
                  const processed = library.progress.processed ?? 0;
                  const total = library.progress.total ?? 0;
                  const percent =
                    total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

                  // Extract just the folder/file name from path
                  const getName = (path: string) => path.split("/").pop() || path;

                  if (isSourceLevel) {
                    return (
                      <div className="busy-indicator-progress-copy">
                        <b>
                          Scanning source {processed + 1} of {total} · {percent}%
                        </b>
                        <small>
                          {library.progress.currentFile
                            ? getName(library.progress.currentFile)
                            : "Preparing…"}
                        </small>
                        <div
                          className="busy-indicator-progress-track"
                          role="progressbar"
                          aria-label="Scan progress"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={percent}
                        >
                          <span style={{ width: `${percent}%` }} />
                        </div>
                      </div>
                    );
                  } else {
                    // Show source folder + file progress in two lines
                    const currentFileName = library.progress.currentFile
                      ? library.progress.currentFile.split("/").pop() ||
                        library.progress.currentFile
                      : "files";
                    // Extract source folder from current file path
                    let sourceFolder = "files";
                    if (library.progress.currentFile) {
                      const parts = library.progress.currentFile.split("/");
                      if (parts.length >= 2) {
                        sourceFolder = parts[parts.length - 2]; // parent folder name
                      }
                    }
                    return (
                      <div className="busy-indicator-progress-copy">
                        <b>
                          Scanning {sourceFolder} · {processed.toLocaleString()} of{" "}
                          {total.toLocaleString()} · {percent}%
                        </b>
                        <small>{currentFileName}</small>
                        <div
                          className="busy-indicator-progress-track"
                          role="progressbar"
                          aria-label="File scan progress"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={percent}
                        >
                          <span style={{ width: `${percent}%` }} />
                        </div>
                      </div>
                    );
                  }
                })()
              : `${library.progress.phase} ${library.progress.processed}/${library.progress.total}`}
      <button
        className="busy-indicator-cancel"
        type="button"
        onClick={() =>
          void (library.progress?.phase === "trashing"
            ? library.cancelDelete()
            : library.cancelScan())
        }
        disabled={library.canceling}
      >
        {library.canceling ? "Cancelling…" : "Cancel"}
      </button>
    </div>
  );
}
