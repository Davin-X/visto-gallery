import React, { useRef, useState, useEffect, useCallback } from "react";
import { useSettingsStore } from "../../engine/stores/useSettingsStore";
import { usePlaybackStore } from "../../engine/stores/usePlaybackStore";
import {
  MinusIcon,
  PlusIcon,
  VolumeIcon,
  StopIcon,
  FullscreenIcon,
  PlayIcon,
  PauseIcon,
} from "./icons";
import { formatDuration } from "../../engine/utils/time";

function VideoPlayer({
  itemId,
  active = true,
  src,
  name,
  onFullscreen,
  onNext,
}: {
  itemId: string;
  active?: boolean;
  src: string;
  name?: string;
  onFullscreen?: () => void;
  onNext?: () => void;
}) {
  const videoAutoPlay = useSettingsStore((s) => s.videoAutoPlay);
  const videoLoop = useSettingsStore((s) => s.videoLoop);
  const registerPlayback = usePlaybackStore((s) => s.register);
  const unregisterPlayback = usePlaybackStore((s) => s.unregister);
  const syncPlayback = usePlaybackStore((s) => s.sync);
  const ref = useRef<HTMLVideoElement | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => usePlaybackStore.getState().lastVolume);
  const [muted, setMuted] = useState(false);
  const [pip, setPip] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);

  // Expose this element to the mini-player that takes over when the user
  // navigates away from the Viewer. The viewer is kept mounted off-screen, so
  // the media element is never torn down during tab switches.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    registerPlayback(video, { itemId, name: name || "Video" });
    syncPlayback({
      playing: !video.paused,
      time: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      muted: video.muted,
      volume: video.volume,
    });
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
    if (video.readyState >= 1) onMetadata();
    return () => {
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [src, syncPlayback]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const onEnded = () => {
      if (autoAdvance && active && onNext) {
        // Auto-advance is a foreground affordance: background playback must
        // not silently navigate the library while another tab is on screen.
        onNext();
      } else {
        setPlaying(false);
        syncPlayback({ playing: false });
      }
    };
    video.addEventListener("ended", onEnded);
    return () => video.removeEventListener("ended", onEnded);
  }, [src, autoAdvance, active, onNext, syncPlayback]);

  // Pause the video when the viewer is torn down so the Tauri webview does not
  // keep media alive briefly while React removes the element. Navigation away
  // from the Viewer does not unmount it (see the viewer host in App).
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
    setPipSupported(
      Boolean(
        (document as any).pictureInPictureEnabled ||
        (video as any).webkitSupportsPresentationMode?.("picture-in-picture"),
      ),
    );
    const onEnter = () => setPip(true);
    const onLeave = () => setPip(false);
    const onWebKitMode = () =>
      setPip((video as any).webkitPresentationMode === "picture-in-picture");
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    video.addEventListener("webkitpresentationmodechanged", onWebKitMode);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
      video.removeEventListener("webkitpresentationmodechanged", onWebKitMode);
    };
  }, [src]);

  const togglePip = async () => {
    const video = ref.current;
    if (!video) return;
    try {
      const v = video as any;
      if (v.webkitSupportsPresentationMode?.("picture-in-picture")) {
        v.webkitSetPresentationMode(
          v.webkitPresentationMode === "picture-in-picture"
            ? "inline"
            : "picture-in-picture",
        );
        return;
      }
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else if (typeof video.requestPictureInPicture === "function") {
        await video.requestPictureInPicture();
      }
    } catch (err) {
      if (import.meta.env.DEV)
        console.warn("Picture-in-picture unavailable", err);
    }
  };

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
      const next = Math.min(
        Math.max(0, video.currentTime + delta),
        video.duration || 0,
      );
      video.currentTime = next;
      setTime(next);
    };
    session.setActionHandler("play", play);
    session.setActionHandler("pause", pause);
    session.setActionHandler("seekbackward", (details) =>
      seekBy(-(details?.seekOffset || 10)),
    );
    session.setActionHandler("seekforward", (details) =>
      seekBy(details?.seekOffset || 10),
    );
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

  // A double-click means "fullscreen". Delay the single-click toggle briefly so
  // the second click of a double-click does not pause and resume the video.
  const handleVideoClick = () => {
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

  return (
    <>
      <video
        ref={ref}
        className="viewer-video"
        src={src}
        title={name}
        autoPlay={videoAutoPlay}
        loop={videoLoop && !autoAdvance}
        playsInline
        preload="metadata"
        onClick={handleVideoClick}
        onDoubleClick={() => onFullscreen?.()}
        tabIndex={0}
      />
      {/* macOS hides a video's native control bar unless the pointer is over the
          frame, so playback gets a permanent bar of our own instead. */}
      <div className="viewer-video-controls">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
        </button>
        <button
          type="button"
          onClick={() => setAutoAdvance((v) => !v)}
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
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
        >
          <VolumeIcon size={14} muted={muted || volume === 0} />
        </button>
        <button
          type="button"
          onClick={() => adjustVolume(-0.1)}
          aria-label="Volume down"
          title="Volume down"
        >
          <MinusIcon size={12} />
        </button>
        <input
          type="range"
          className="video-volume"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            if (v > 0) setMuted(false);
          }}
          aria-label="Volume"
        />
        <button
          type="button"
          onClick={() => adjustVolume(0.1)}
          aria-label="Volume up"
          title="Volume up"
        >
          <PlusIcon size={12} />
        </button>
        {pipSupported && (
          <button
            type="button"
            onClick={togglePip}
            aria-label={pip ? "Exit picture in picture" : "Picture in picture"}
            title="Picture in picture"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <rect
                x="12"
                y="12"
                width="8"
                height="6"
                fill={pip ? "currentColor" : "none"}
              />
            </svg>
          </button>
        )}
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
    </>
  );
}

export default VideoPlayer;
