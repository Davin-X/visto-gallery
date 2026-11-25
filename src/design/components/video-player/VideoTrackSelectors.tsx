import type { AudioTrackInfo, SubtitleTrackInfo } from "../../../engine/types/commands";

function languageLabel(language: string | null): string | null {
  if (!language || language === "und") return null;
  try {
    if (typeof Intl.DisplayNames === "function") {
      return new Intl.DisplayNames(undefined, { type: "language" }).of(language) ?? null;
    }
  } catch {
    // Older WebKit or an unknown tag: fall back to the tag itself.
  }
  return language.toUpperCase();
}

function trackLabel(
  track: { language: string | null; title: string | null },
  fallback: string,
): string {
  return track.title ?? languageLabel(track.language) ?? fallback;
}

function audioTrackLabel(track: AudioTrackInfo, position: number): string {
  const label = trackLabel(track, `Audio ${position + 1}`);
  return track.channels && track.channels > 1 ? `${label} · ${track.channels} ch` : label;
}

interface VideoTrackSelectorsProps {
  audioTracks: AudioTrackInfo[];
  textSubtitles: SubtitleTrackInfo[];
  audioTrack: number | null;
  subtitleTrack: number | "off";
  setAudioTrack: (index: number) => void;
  setSubtitleTrack: (index: number | "off") => void;
}

export function VideoTrackSelectors({
  audioTracks,
  textSubtitles,
  audioTrack,
  subtitleTrack,
  setAudioTrack,
  setSubtitleTrack,
}: VideoTrackSelectorsProps) {
  return (
    <>
      {textSubtitles.length > 0 && (
        <select
          className="video-track-select"
          value={String(subtitleTrack)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setSubtitleTrack(value === "off" ? "off" : Number(value));
          }}
          aria-label="Subtitles"
          title="Subtitles"
        >
          <option value="off">Subtitles off</option>
          {textSubtitles.map((track, position) => (
            <option key={track.index} value={track.index}>
              {trackLabel(track, `Subtitles ${position + 1}`)}
            </option>
          ))}
        </select>
      )}
      {audioTracks.length > 1 && (
        <select
          className="video-track-select"
          value={audioTrack ?? audioTracks[0]?.index ?? ""}
          onChange={(event) => setAudioTrack(Number(event.currentTarget.value))}
          aria-label="Audio track"
          title="Audio track"
        >
          {audioTracks.map((track, position) => (
            <option key={track.index} value={track.index}>
              {audioTrackLabel(track, position)}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
