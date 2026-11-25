import { tauri } from "../../../engine/commands/tauri";
import type { ExternalPlayer } from "../../../engine/types/commands";
import { classifyVideoFailure, fileExtension } from "../../../engine/utils/mediaTypes";

interface VideoPlaybackFallbackProps {
  path?: string;
  name?: string;
  videoError: MediaError | null;
  player?: ExternalPlayer;
  canConvert: boolean;
  converting: boolean;
  conversionProgress: number | null;
  openError: string | null;
  conversionError: string | null;
  failureDetail: string | null;
  startConversion: () => Promise<void>;
  cancelConversion: () => Promise<void>;
  openExternally: (player?: string) => Promise<void>;
}

export function VideoPlaybackFallback({
  path,
  name,
  videoError,
  player,
  canConvert,
  converting,
  conversionProgress,
  openError,
  conversionError,
  failureDetail,
  startConversion,
  cancelConversion,
  openExternally,
}: VideoPlaybackFallbackProps) {
  const ext = fileExtension(path) || fileExtension(name);
  // SRC_NOT_SUPPORTED (4) is also what a missing file, an unplugged drive
  // or a permission error looks like, so only an unsupported extension or
  // a real decode error (3) may be reported as a format problem.
  const isFormatFailure = classifyVideoFailure(videoError?.code, path, name) === "format";
  return (
    <div className="viewer-video-fallback" role="alert">
      <div className="viewer-video-fallback-art" aria-hidden="true">
        <svg
          width="34"
          height="34"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5" />
        </svg>
      </div>
      <h3 className="viewer-video-fallback-title">{name || "This video"}</h3>
      <p className="viewer-video-fallback-copy">
        {canConvert || converting
          ? "This file uses a codec the built-in player cannot decode directly. VistoGallery can convert it once to H.264 so it plays here."
          : isFormatFailure
            ? `${ext ? `.${ext} files` : "This file"} can't be decoded by macOS's built-in web player. Open it in a desktop player that supports this format.`
            : "VistoGallery couldn't open this video. The file may have been moved, deleted, or be on a disconnected drive — or its codec may not be playable here. Check the source, then try a desktop player."}
      </p>
      {converting ? (
        <div className="viewer-video-converting" role="status" aria-live="polite">
          <div className="viewer-video-convert-bar" aria-hidden="true">
            <span
              style={{
                width: `${Math.round((conversionProgress ?? 0) * 100)}%`,
              }}
            />
          </div>
          <span>
            {conversionProgress == null
              ? "Converting…"
              : `Converting… ${Math.round(conversionProgress * 100)}%`}
          </span>
          <button type="button" onClick={() => void cancelConversion()}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="viewer-video-fallback-actions">
          {canConvert ? (
            <button type="button" className="primary" onClick={() => void startConversion()}>
              Convert to play here
            </button>
          ) : null}
          {player ? (
            <button
              type="button"
              className={canConvert ? undefined : "primary"}
              onClick={() => void openExternally(player.path)}
            >
              Open in {player.name}
            </button>
          ) : null}
          <button type="button" onClick={() => void openExternally()}>
            Open in default app
          </button>
          <button type="button" onClick={() => path && void tauri.items.revealInFinder(path)}>
            Show in Finder
          </button>
        </div>
      )}
      {canConvert && !converting && (
        <p className="viewer-video-feedback">
          The converted copy is kept in the playback cache and counts toward its size limit.
        </p>
      )}
      {isFormatFailure && !player && !canConvert && !converting && (
        <p className="viewer-video-feedback">
          Tip: IINA, VLC, or Elmedia Video Player all play MKV natively.
        </p>
      )}
      {openError && <p className="viewer-video-feedback error">{openError}</p>}
      {conversionError && <p className="viewer-video-feedback error">{conversionError}</p>}
      {failureDetail && <p className="viewer-video-feedback">{failureDetail}</p>}
    </div>
  );
}
