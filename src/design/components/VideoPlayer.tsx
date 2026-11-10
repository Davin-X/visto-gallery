import React, { useRef, useState, useEffect, useCallback } from "react";
import { useSettingsStore } from "../../engine/stores/useSettingsStore";
import { usePlaybackStore } from "../../engine/stores/usePlaybackStore";
import {
  VolumeIcon,
  StopIcon,
  FullscreenIcon,
  PictureInPictureIcon,
  PlayIcon,
  PauseIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "./icons";
import { tauri } from "../../engine/commands/tauri";
import type { ExternalPlayer } from "../../engine/types/commands";
import { formatDuration } from "../../engine/utils/time";
import { canPlayVideoInApp, fileExtension } from "../../engine/utils/mediaTypes";
import {
  observePictureInPicture,
  supportsPictureInPicture,
  togglePictureInPicture,
} from "../../engine/utils/pictureInPicture";

// WKWebView can decode MP4/MOV (H.264/HEVC) and WebM, but not Matroska or AVI.
// Files outside the supported list never reach the <video> element: WebKit
// renders a black frame for them, which made the whole viewer look broken.

function VideoPlayer({
  itemId,
  active = true,
  src,
  path,
  name,
  width,
  height,
  onFullscreen,
  onNext,
  onPrevious,
  compact = false,
  forceAutoPlay = false,
}: {
  itemId: string;
  active?: boolean;
  src: string;
  path?: string;
  name?: string;
  width?: number | null;
  height?: number | null;
  onFullscreen?: () => void;
  onNext?: () => boolean | Promise<boolean>;
  /** Render a clean thumbnail-like frame; transport actions are external. */
  compact?: boolean;
  forceAutoPlay?: boolean;
  onPrevious?: () => void;
}) {
  const videoAutoPlay = useSettingsStore((s) => s.videoAutoPlay);
  const videoLoop = useSettingsStore((s) => s.videoLoop);
  const registerPlayback = usePlaybackStore((s) => s.register);
  const unregisterPlayback = usePlaybackStore((s) => s.unregister);
  const syncPlayback = usePlaybackStore((s) => s.sync);
  const ref = useRef<HTMLVideoElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const controlsTimerRef = useRef<number | null>(null);
  const hintsTimerRef = useRef<number | null>(null);
  const controlsFocusedRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [keyboardFocusWithinControls, setKeyboardFocusWithinControls] = useState(false);
  const [hintsVisible, setHintsVisible] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => usePlaybackStore.getState().lastVolume);
  const [muted, setMuted] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const [pictureInPictureSupported, setPictureInPictureSupported] = useState(false);
  const [pictureInPictureError, setPictureInPictureError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [failed, setFailed] = useState(() => !canPlayVideoInApp(path, name));
  const [videoError, setVideoError] = useState<MediaError | null>(null);
  const [players, setPlayers] = useState<ExternalPlayer[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);

  const scheduleControlsHide = useCallback(() => {
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    if (!playing || controlsFocusedRef.current) return;
    controlsTimerRef.current = window.setTimeout(() => setControlsVisible(false), 3500);
  }, [playing]);

  const showPlayerActivity = useCallback(() => {
    setControlsVisible(true);
    setHintsVisible(true);
    scheduleControlsHide();
    if (hintsTimerRef.current) window.clearTimeout(hintsTimerRef.current);
    hintsTimerRef.current = window.setTimeout(() => setHintsVisible(false), 3500);
  }, [scheduleControlsHide]);

  useEffect(() => {
    if (playing) {
      scheduleControlsHide();
    } else {
      if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
      setControlsVisible(true);
    }
  }, [playing, scheduleControlsHide]);

  useEffect(() => {
    showPlayerActivity();
    return () => {
      if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
      if (hintsTimerRef.current) window.clearTimeout(hintsTimerRef.current);
    };
  }, [src, showPlayerActivity]);

  // A different item can use a different container, so re-evaluate on change.
  useEffect(() => {
    setFailed(!canPlayVideoInApp(path, name));
    setOpenError(null);
  }, [src, path, name]);

  // Only look up external players when something actually failed.
  useEffect(() => {
    if (!failed) return;
    let cancelled = false;
    void tauri.items
      .externalVideoPlayers()
      .then((list) => {
        if (!cancelled) setPlayers(list);
      })
      .catch(() => {
        if (!cancelled) setPlayers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [failed]);

  const openExternally = async (player?: string) => {
    if (!path) return;
    setOpenError(null);
    try {
      if (player) await tauri.items.openWithPlayer(path, player);
      else await tauri.items.openFile(path);
    } catch (error) {
      setOpenError(String(error));
    }
  };

  // Expose the single active video element to the audio-only Now Playing card.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    registerPlayback(video, { itemId, name: name || "Video" });
    const state = usePlaybackStore.getState();
    const hasSnapshot = state.itemId === itemId && state.duration > 0;
    if (hasSnapshot) {
      // Handoff between foreground/background players: snapshot survived.
      // Resume playback if it was playing; sync volume/muted from snapshot.
      if (state.playing && video.paused) {
        void video.play().catch(() => {});
      }
      video.volume = state.volume;
      video.muted = state.muted;
    } else {
      // Fresh video: no snapshot to preserve; record current element state.
      syncPlayback({
        playing: !video.paused,
        time: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        muted: video.muted,
        volume: video.volume,
      });
      // WKWebView is finicky about autoplay for tiny background hosts: the
      // attribute alone can stall indefinitely with the host page inert. Ask
      // for playback explicitly; it happens within the user's gesture when
      // the click started the session. Unconditional: the user gesture is
      // the signal, not the attribute.
      void video.play().catch(() => {});
    }
    return () => unregisterPlayback(video);
  }, [itemId, name, registerPlayback, unregisterPlayback, syncPlayback]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    // Restore playback state from store if this is the same itemId
    const {
      itemId: storeItemId,
      time,
      volume,
      muted,
      playing,
      duration,
    } = usePlaybackStore.getState();
    if (storeItemId === itemId && duration > 0) {
      // Restore saved state
      video.currentTime = time;
      video.volume = volume;
      video.muted = muted;
      if (playing && !video.paused) {
        // Already playing, just sync
      } else if (playing) {
        void video.play().catch(() => {});
      } else {
        // The snapshot says paused: defeat the autoPlay attribute so a
        // handoff between players does not resume a paused video.
        video.autoplay = false;
        video.pause();
      }
      setPlaying(playing);
      setTime(time);
      setDuration(duration);
      setVolume(volume);
      setMuted(muted);
    } else {
      // Fresh load - defaults
      setPlaying(false);
      setTime(0);
      setDuration(0);
      const lastVolume = usePlaybackStore.getState().lastVolume;
      setVolume(lastVolume);
      video.volume = lastVolume;
      setMuted(false);
    }

    const onMetadata = () => {
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(nextDuration);
      syncPlayback({
        duration: nextDuration,
        time: video.currentTime,
        playing: !video.paused,
      });
    };
    const onTimeUpdate = () => {
      setTime(video.currentTime);
      syncPlayback({ time: video.currentTime });
    };
    const onPlay = () => {
      setPlaying(true);
      syncPlayback({ playing: true });
    };
    const onPause = () => {
      setPlaying(false);
      syncPlayback({ playing: false });
    };

    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    // A second, belt-and-suspenders attempt once the media is actually ready:
    // the mount-time play() can lose the race against the canplay event in
    // WKWebView, which silently leaves the video idle at 0:00.
    const attemptAutoPlay = () => void video.play().catch(() => {});
    if (storeItemId !== itemId || duration === 0) {
      video.addEventListener("canplay", attemptAutoPlay, { once: true });
    }
    if (video.readyState >= 1) onMetadata();
    return () => {
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("canplay", attemptAutoPlay);
    };
  }, [src, syncPlayback]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setPictureInPictureSupported(supportsPictureInPicture(video));
    setPictureInPictureError(null);
    return observePictureInPicture(video, setPictureInPicture);
  }, [src]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const onEnded = () => {
      if (!onNext || !(compact || (autoAdvance && active))) {
        setPlaying(false);
        syncPlayback({ playing: false });
        return;
      }
      void Promise.resolve(onNext()).then((advanced) => {
        if (!advanced) {
          setPlaying(false);
          syncPlayback({ playing: false });
        }
      });
    };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, [src, autoAdvance, active, compact, onNext, syncPlayback]);

  // Pause playback when the player host is removed, such as after Stop.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    return () => {
      if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
      video.pause();
    };
  }, []);

  // Keyboard shortcuts for video (when focused)
  const adjustVolume = useCallback((delta: number) => {
    setVolume((current) => {
      const next = Math.min(1, Math.max(0, current + delta));
      if (next > 0) setMuted(false);
      return next;
    });
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        seek(Math.max(0, video.currentTime - 5));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        seek(Math.min(video.duration || 0, video.currentTime + 5));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        adjustVolume(0.1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        adjustVolume(-0.1);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        e.stopPropagation();
        adjustVolume(0.1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        e.stopPropagation();
        adjustVolume(-0.1);
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        e.stopPropagation();
        onFullscreen?.();
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        e.stopPropagation();
        setMuted((m) => !m);
      }
    };
    video.addEventListener("keydown", handleKeyDown);
    return () => video.removeEventListener("keydown", handleKeyDown);
  }, [onFullscreen, adjustVolume]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
    syncPlayback({ volume, muted });
    usePlaybackStore.getState().setLastVolume(volume);
  }, [volume, muted, syncPlayback]);

  // Wire media keys / PiP transport controls to the player.
  useEffect(() => {
    const video = ref.current;
    if (!video || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({
      title: name || "Video",
      artist: "VistoGallery",
    });
    const play = () => void video.play().catch(() => {});
    const pause = () => video.pause();
    const seekBy = (delta: number) => {
      const next = Math.min(Math.max(0, video.currentTime + delta), video.duration || 0);
      video.currentTime = next;
      setTime(next);
    };
    session.setActionHandler("play", play);
    session.setActionHandler("pause", pause);
    session.setActionHandler("seekbackward", (details) => seekBy(-(details?.seekOffset || 10)));
    session.setActionHandler("seekforward", (details) => seekBy(details?.seekOffset || 10));
    const onPlay = () => {
      session.playbackState = "playing";
    };
    const onPause = () => {
      session.playbackState = "paused";
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      session.setActionHandler("play", null);
      session.setActionHandler("pause", null);
      session.setActionHandler("seekbackward", null);
      session.setActionHandler("seekforward", null);
    };
  }, [src, name]);

  const toggle = () => {
    const video = ref.current;
    if (!video) return;
    if (video.paused) {
      if (video.ended) video.currentTime = 0;
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const seek = (value: number) => {
    const video = ref.current;
    if (!video) return;
    video.currentTime = value;
    setTime(value);
  };

  const skipBy = (delta: number) => {
    const video = ref.current;
    if (!video) return;
    const target = Math.max(0, video.currentTime + delta);
    seek(Number.isFinite(video.duration) ? Math.min(target, video.duration) : target);
  };

  const togglePip = async () => {
    const video = ref.current;
    if (!video) return;
    setPictureInPictureError(null);
    try {
      await togglePictureInPicture(video);
    } catch (error) {
      setPictureInPictureError(error instanceof Error ? error.message : String(error));
    }
  };

  // A double-click means "fullscreen". Delay the single-click toggle briefly so
  // the second click of a double-click does not pause and resume the video.
  const handleVideoClick = () => {
    showPlayerActivity();
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      return;
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      toggle();
    }, 220);
  };

  if (failed) {
    const ext = fileExtension(path) || fileExtension(name);
    // Only call it a format problem when the extension is genuinely
    // unsupported or the error is SRC_NOT_SUPPORTED. A missing file, an
    // unplugged drive or a permission error gets the availability copy.
    // SRC_NOT_SUPPORTED (4) and DECODE (3) point at the codec; everything
    // else (network, aborted, unknown) means the file is unavailable.
    const isFormatFailure =
      !canPlayVideoInApp(path, name) ||
      !videoError ||
      videoError.code === 4 ||
      videoError.code === 3;
    const player = players[0];
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
          {isFormatFailure
            ? `${ext ? `.${ext} files` : "This file"} can't be decoded by macOS's built-in web player. Open it in a desktop player that supports this format.`
            : "This video could not be played. The file may be missing or the source drive may be disconnected — check the source and try again."}
        </p>
        <div className="viewer-video-fallback-actions">
          {player ? (
            <button
              type="button"
              className="primary"
              onClick={() => void openExternally(player.path)}
            >
              Open in {player.name}
            </button>
          ) : null}
          <button type="button" onClick={() => void openExternally()}>
            Open in default app
          </button>
          <button type="button" onClick={() => path && void tauri.items.revealInFinder(path)}>
            Reveal in Finder
          </button>
        </div>
        {isFormatFailure && !player && (
          <p className="viewer-video-feedback">
            Tip: IINA, VLC, or Elmedia Video Player all play MKV natively.
          </p>
        )}
        {openError && <p className="viewer-video-feedback error">{openError}</p>}
      </div>
    );
  }

  return (
    <div
      className="video-player-surface"
      onPointerMove={showPlayerActivity}
      onPointerDown={showPlayerActivity}
    >
      <video
        ref={ref}
        className={`viewer-video${compact ? " viewer-video-compact" : ""}`}
        src={src}
        width={width ?? undefined}
        height={height ?? undefined}
        style={{
          aspectRatio: width && height ? `auto ${width} / ${height}` : "auto",
        }}
        autoPlay={videoAutoPlay || forceAutoPlay}
        loop={videoLoop && !autoAdvance && !compact}
        playsInline
        preload="metadata"
        onClick={handleVideoClick}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onFullscreen?.();
        }}
        onError={(event) => {
          setVideoError(event.currentTarget.error ?? null);
          setFailed(true);
        }}
        tabIndex={0}
        aria-keyshortcuts="Space ArrowLeft ArrowRight ArrowUp ArrowDown F M"
        title={`${name || "Video"} — focus for shortcuts: Space play/pause, ←/→ seek, F fullscreen`}
      />
      {/* macOS hides a video's native control bar unless the pointer is over the
          frame, so playback gets a permanent bar of our own instead. */}
      {!compact && (
        <>
          {onPrevious && (
            <button
              type="button"
              className={`viewer-arrow left video-stage-arrow${controlsVisible ? "" : " hidden"}`}
              onClick={onPrevious}
              aria-label="Previous video"
              title="Previous video"
            >
              <ChevronLeftIcon size={21} strokeWidth={2.1} />
            </button>
          )}
          {onNext && (
            <button
              type="button"
              className={`viewer-arrow right video-stage-arrow${controlsVisible ? "" : " hidden"}`}
              onClick={() => void onNext()}
              aria-label="Next video"
              title="Next video"
            >
              <ChevronRightIcon size={21} strokeWidth={2.1} />
            </button>
          )}
          <div
            ref={controlsRef}
            className={`viewer-video-controls${controlsVisible ? "" : " is-hidden"}${keyboardFocusWithinControls ? " is-keyboard-focused" : ""}`}
            onPointerDownCapture={() => {
              controlsFocusedRef.current = false;
              setKeyboardFocusWithinControls(false);
            }}
            onFocusCapture={(event) => {
              const keyboardFocused =
                event.target instanceof HTMLElement && event.target.matches(":focus-visible");
              controlsFocusedRef.current = keyboardFocused;
              setKeyboardFocusWithinControls(keyboardFocused);
              if (keyboardFocused) {
                if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
                setControlsVisible(true);
              } else {
                scheduleControlsHide();
              }
            }}
            onBlurCapture={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                controlsRef.current?.contains(event.relatedTarget)
              )
                return;
              controlsFocusedRef.current = false;
              setKeyboardFocusWithinControls(false);
              scheduleControlsHide();
            }}
          >
            <button
              type="button"
              className="video-play-button"
              onClick={toggle}
              aria-label={playing ? "Pause" : "Play"}
              title={playing ? "Pause" : "Play"}
            >
              {playing ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
            </button>
            <button
              type="button"
              className="video-skip-button"
              onClick={() => skipBy(-10)}
              aria-label="Back 10 seconds"
              title="Back 10 seconds"
            >
              −10
            </button>
            <span className="video-time">{formatDuration(time)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.05}
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="Seek"
            />
            <span className="video-time">{formatDuration(duration)}</span>
            <button
              type="button"
              className="video-skip-button"
              onClick={() => skipBy(10)}
              aria-label="Forward 10 seconds"
              title="Forward 10 seconds"
            >
              +10
            </button>
            <button
              type="button"
              onClick={() => setAutoAdvance((value) => !value)}
              aria-pressed={autoAdvance}
              aria-label="Auto-advance to the next item"
              title={
                autoAdvance
                  ? "Auto-advance on: play the next item when this ends"
                  : "Auto-advance off: stop at the end"
              }
            >
              {autoAdvance ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polygon points="5 4 15 12 5 20 5 4" />
                  <line x1="19" y1="5" x2="19" y2="19" />
                </svg>
              ) : (
                <StopIcon size={14} />
              )}
            </button>
            <button
              type="button"
              onClick={() => setMuted((value) => !value)}
              aria-label={muted ? "Unmute" : "Mute"}
              title={muted ? "Unmute" : "Mute"}
            >
              <VolumeIcon size={14} muted={muted || volume === 0} />
            </button>
            <input
              type="range"
              className="video-volume"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const nextVolume = Number(e.target.value);
                setVolume(nextVolume);
                if (nextVolume > 0) setMuted(false);
              }}
              aria-label="Volume"
            />
            <select
              className="video-playback-rate"
              value={playbackRate}
              onChange={(event) => {
                const rate = Number(event.currentTarget.value);
                setPlaybackRate(rate);
                if (ref.current) ref.current.playbackRate = rate;
              }}
              aria-label="Playback speed"
              title="Playback speed"
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <option value={rate} key={rate}>
                  {rate}×
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void togglePip()}
              disabled={!pictureInPictureSupported}
              aria-label={pictureInPicture ? "Exit picture in picture" : "Enter picture in picture"}
              aria-pressed={pictureInPicture}
              title={
                pictureInPictureSupported
                  ? pictureInPicture
                    ? "Exit picture in picture"
                    : "Picture in picture"
                  : "Picture in picture is unavailable"
              }
            >
              <PictureInPictureIcon size={14} />
            </button>
            {onFullscreen && (
              <button
                type="button"
                onClick={onFullscreen}
                aria-label="Full screen"
                title="Full screen"
              >
                <FullscreenIcon size={14} />
              </button>
            )}
          </div>
          <div
            className={`video-player-hints${hintsVisible ? "" : " is-hidden"}`}
            aria-hidden="true"
          >
            <span>
              <kbd>Space</kbd> Play / pause
            </span>
            <span>
              <kbd>←</kbd>
              <kbd>→</kbd> Seek
            </span>
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> Volume
            </span>
            <span>
              <kbd>F</kbd> Full screen
            </span>
            <span>
              <kbd>M</kbd> Mute
            </span>
          </div>
          {pictureInPictureError && (
            <p className="video-pip-error" role="status">
              {pictureInPictureError}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default VideoPlayer;
