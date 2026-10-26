import { useCallback, useEffect, useRef, useState } from "react";
import {
  useSlideshowStore,
  useDraftTransforms,
  draftTransformStyle,
  type SlideshowTransition,
} from "../../engine/stores";
import {
  GearIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
  PlusIcon,
  MinusIcon,
  RotateIcon,
  FlipIcon,
  FullscreenIcon,
  VolumeIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "./icons";

interface SlideshowOverlayProps {
  assetUrl: (path: string) => string;
}

// A slideshow is a mode, not a destination. It floats above whatever screen
// launched it, owns its own item list, and leaves the library selection and
// inspection state untouched when it closes.
export function SlideshowOverlay({ assetUrl }: SlideshowOverlayProps) {
  const isOpen = useSlideshowStore((s) => s.isOpen);
  const draftTransforms = useDraftTransforms();
  const items = useSlideshowStore((s) => s.items);
  const index = useSlideshowStore((s) => s.index);
  const playing = useSlideshowStore((s) => s.playing);
  const interval = useSlideshowStore((s) => s.interval);
  const shuffle = useSlideshowStore((s) => s.shuffle);
  const transition = useSlideshowStore((s) => s.transition);
  const item = items[index];
  const close = useSlideshowStore((s) => s.close);
  const next = useSlideshowStore((s) => s.next);
  const previous = useSlideshowStore((s) => s.previous);
  const toggle = useSlideshowStore((s) => s.toggle);
  const setInterval = useSlideshowStore((s) => s.setInterval);
  const setShuffle = useSlideshowStore((s) => s.setShuffle);
  const setTransition = useSlideshowStore((s) => s.setTransition);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [pip, setPip] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(false);
  const [hintsVisible, setHintsVisible] = useState(true);
  const hintsTimer = useRef<number | null>(null);

  const hideTimer = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoMuted, setVideoMuted] = useState(false);
  const [videoVolume, setVideoVolume] = useState(1);
  // True while the pointer or keyboard focus is on the HUD. Auto-hide must not
  // re-arm then, otherwise the controls fade out from under the cursor.
  const hudHeldRef = useRef(false);

  // Controls fade out while the slideshow plays and come back on movement.
  const poke = useCallback(() => {
    setHudVisible(true);
    setHintsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (!hudHeldRef.current) {
      hideTimer.current = window.setTimeout(() => {
        if (document.activeElement?.closest?.(".slideshow-controls")) return;
        setHudVisible(false);
      }, 3000);
    }
    if (hintsTimer.current) window.clearTimeout(hintsTimer.current);
    hintsTimer.current = window.setTimeout(() => setHintsVisible(false), 3500);
  }, []);

  const holdHud = useCallback(() => {
    hudHeldRef.current = true;
    setHudVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  }, []);

  const releaseHud = useCallback(() => {
    hudHeldRef.current = false;
    poke();
  }, [poke]);

  // Track video metadata and time for the seek bar
  useEffect(() => {
    const video = videoRef.current;
    if (!video || item?.kind !== "video") return;
    const onMetadata = () => {
      setVideoDuration(Number.isFinite(video.duration) ? video.duration : 0);
    };
    const onTimeUpdate = () => setVideoTime(video.currentTime);
    const onVolumeChange = () => {
      setVideoMuted(video.muted);
      setVideoVolume(video.volume);
    };
    if (video.readyState >= 1) onMetadata();
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("volumechange", onVolumeChange);
    return () => {
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  }, [item?.id, item?.kind]);

  // PiP support
  useEffect(() => {
    const video = videoRef.current;
    if (!video || item?.kind !== "video") {
      setPipSupported(false);
      setPip(false);
      return;
    }
    setPipSupported(
      Boolean(
        (document as any).pictureInPictureEnabled ||
        (video as any).webkitSupportsPresentationMode?.("picture-in-picture"),
      ),
    );
    const onEnter = () => setPip(true);
    const onLeave = () => setPip(false);
    const onWebKit = () =>
      setPip((video as any).webkitPresentationMode === "picture-in-picture");
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    video.addEventListener("webkitpresentationmodechanged", onWebKit);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
      video.removeEventListener("webkitpresentationmodechanged", onWebKit);
    };
  }, [item?.id, item?.kind]);

  const togglePip = () => {
    const video = videoRef.current;
    if (!video) return;
    const v = video as any;
    try {
      if (v.webkitSupportsPresentationMode?.("picture-in-picture")) {
        v.webkitSetPresentationMode(
          v.webkitPresentationMode === "picture-in-picture"
            ? "inline"
            : "picture-in-picture",
        );
      } else if (document.pictureInPictureElement === video) {
        void document.exitPictureInPicture();
      } else if (typeof video.requestPictureInPicture === "function") {
        void video.requestPictureInPicture();
      }
    } catch (err) {
      if (import.meta.env.DEV)
        console.warn("Picture-in-picture unavailable", err);
    }
  };

  // Sync play/pause with the video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video || item?.kind !== "video") return;
    if (playing) void video.play().catch(() => {});
    else video.pause();
    return () => video.pause();
  }, [item?.id, item?.kind, playing]);

  // Reset transforms when item changes
  useEffect(() => {
    setZoom(100);
    setRotation(0);
    setFlipX(false);
  }, [item?.id]);

  // Cleanup on close
  useEffect(() => {
    if (!isOpen) {
      setSettingsOpen(false);
      hudHeldRef.current = false;
    }
  }, [isOpen]);

  // Keyboard shortcuts (capture phase to beat the Viewer underneath)
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        previous();
      } else if (e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      } else if (
        e.key === "ArrowUp" &&
        item.kind === "video" &&
        videoRef.current
      ) {
        e.preventDefault();
        e.stopPropagation();
        const v = videoRef.current;
        v.volume = Math.min(1, v.volume + 0.1);
        if (v.volume > 0) v.muted = false;
      } else if (
        e.key === "ArrowDown" &&
        item.kind === "video" &&
        videoRef.current
      ) {
        e.preventDefault();
        e.stopPropagation();
        const v = videoRef.current;
        v.volume = Math.max(0, v.volume - 0.1);
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        e.stopPropagation();
        void toggleFullscreen();
      } else if (e.key === "m" && item.kind === "video") {
        e.preventDefault();
        e.stopPropagation();
        const v = videoRef.current;
        if (v) {
          v.muted = !v.muted;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, close, next, previous, toggle, item]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else
        await document.querySelector(".slideshow-overlay")?.requestFullscreen();
    } catch {}
  };

  const seek = (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = time;
    setVideoTime(time);
  };

  const handleVolumeChange = (volume: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = volume === 0;
    setVideoVolume(volume);
    setVideoMuted(volume === 0);
  };

  const handleMuteToggle = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setVideoMuted(video.muted);
  };

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds)) return "0:00";
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
  };

  if (!isOpen) return null;
  if (!item) return null;

  const hudShown = hudVisible || !playing || settingsOpen;
  const position = `${(index + 1).toLocaleString()} / ${items.length.toLocaleString()}`;
  const draftTransform = draftTransforms.get(item.id);
  const draftRotation = draftTransform?.rotation || 0;
  const imageRotation = (rotation + draftRotation) % 360;
  const rotated = imageRotation % 180 !== 0;
  const isVideo = item.kind === "video";

  return (
    <div
      className={`slideshow-overlay${hudShown ? " hud-visible" : ""}`}
      data-transition={transition}
      role="dialog"
      aria-modal="true"
      aria-label="Slideshow"
      onMouseMove={poke}
    >
      <div
        className="slideshow-media"
        key={item.id}
        onClick={toggle}
        title={playing ? "Pause" : "Play"}
      >
        {isVideo ? (
          <video
            ref={videoRef}
            src={assetUrl(item.path)}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={holdHud}
            onMouseLeave={releaseHud}
            autoPlay={playing}
            loop={false}
            playsInline
            onEnded={() => (items.length > 1 ? next() : toggle())}
            style={{
              maxWidth: rotated ? "min(100%, 100cqh)" : undefined,
              maxHeight: rotated ? "min(100%, 100cqw)" : undefined,
              transform: [
                `rotate(${imageRotation}deg)`,
                `scaleX(${flipX ? -1 : 1})`,
                draftTransformStyle(draftTransform),
                `scale(${zoom / 100})`,
              ]
                .filter(Boolean)
                .join(" "),
            }}
          />
        ) : (
          <img
            src={assetUrl(item.path)}
            alt={item.name}
            decoding="async"
            style={{
              maxWidth: rotated ? "min(100%, 100cqh)" : undefined,
              maxHeight: rotated ? "min(100%, 100cqw)" : undefined,
              transform: [
                `rotate(${imageRotation}deg)`,
                `scaleX(${flipX ? -1 : 1})`,
                draftTransformStyle(draftTransform),
                `scale(${zoom / 100})`,
              ]
                .filter(Boolean)
                .join(" "),
            }}
          />
        )}
      </div>

      {/* Top-right position indicator */}
      <span className="slideshow-position">{position}</span>

      {/* Bottom controls bar - matches viewer style */}
      <div
        className="slideshow-controls"
        onMouseEnter={holdHud}
        onMouseLeave={releaseHud}
        onFocusCapture={holdHud}
        onBlurCapture={releaseHud}
      >
        {/* Transport - all same style */}
        <button
          type="button"
          onClick={previous}
          aria-label="Previous slide"
          title="Previous (←)"
        >
          <ChevronLeftIcon size={18} />
        </button>
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
        >
          {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
        <button
          type="button"
          onClick={next}
          aria-label="Next slide"
          title="Next (→)"
        >
          <ChevronRightIcon size={18} />
        </button>

        {isVideo && (
          <>
            {/* Seek bar with time */}
            <span className="slideshow-time">{formatTime(videoTime)}</span>
            <input
              type="range"
              className="slideshow-seek"
              min={0}
              max={videoDuration || 0}
              step={0.05}
              value={Math.min(videoTime, videoDuration || 0)}
              onChange={(e) => seek(Number(e.target.value))}
              onMouseDown={() => holdHud()}
              onMouseUp={() => releaseHud()}
              aria-label="Seek"
            />
            <span className="slideshow-time">{formatTime(videoDuration)}</span>

            {/* Volume */}
            <button
              type="button"
              className="slideshow-volume-btn"
              onClick={handleMuteToggle}
              aria-label={videoMuted ? "Unmute" : "Mute"}
              title={videoMuted ? "Unmute (M)" : "Mute (M)"}
            >
              <VolumeIcon size={14} muted={videoMuted} />
            </button>
            <input
              type="range"
              className="slideshow-volume"
              min={0}
              max={1}
              step={0.05}
              value={videoMuted ? 0 : videoVolume}
              onChange={(e) => handleVolumeChange(Number(e.target.value))}
              onMouseDown={() => holdHud()}
              onMouseUp={() => releaseHud()}
              aria-label="Volume"
            />
          </>
        )}

        {/* Caption (filename/date) */}
        <div
          className="slideshow-caption"
          style={{
            flex: 1,
            textAlign: "center",
            maxWidth: 400,
            marginLeft: 16,
          }}
        >
          <div
            style={{
              fontWeight: 600,
              fontSize: 13,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {item.name}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
            {new Date(item.modifiedAt).toLocaleDateString()}
            {item.extension ? ` · ${item.extension.toUpperCase()}` : ""}
          </div>
        </div>

        {/* Right side actions - inline, no dropdown */}
        {/* Transform controls inline */}
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(300, z + 25))}
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          <PlusIcon size={14} />
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(25, z - 25))}
          aria-label="Zoom out"
          title="Zoom out (-)"
        >
          <MinusIcon size={14} />
        </button>
        <span className="slideshow-zoom-value">{zoom}%</span>
        <button
          type="button"
          onClick={() => setRotation((r) => (r + 90) % 360)}
          aria-label="Rotate 90 degrees"
          title="Rotate (R)"
        >
          <RotateIcon size={14} />
        </button>
        <button
          type="button"
          className={flipX ? "active" : ""}
          onClick={() => setFlipX((f) => !f)}
          aria-label="Flip horizontally"
          title="Flip horizontal"
        >
          <FlipIcon size={14} />
        </button>
        {(rotation !== 0 || flipX || zoom !== 100) && (
          <button
            type="button"
            style={{ width: "auto", padding: "0 10px" }}
            onClick={() => {
              setZoom(100);
              setRotation(0);
              setFlipX(false);
            }}
            aria-label="Reset transform"
            title="Reset transform"
          >
            Reset
          </button>
        )}

        {isVideo && pipSupported && (
          <button
            type="button"
            onClick={togglePip}
            aria-label={pip ? "Exit picture in picture" : "Picture in picture"}
            title="Picture in picture"
            className={pip ? "active" : ""}
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
              aria-hidden="true"
            >
              <path d="M19 7V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h11" />
              <path d="M9 12v6" />
              <path d="M15 12v6" />
              <path d="M4 12h16" />
              <rect x="17" y="17" width="5" height="5" rx="1" />
            </svg>
          </button>
        )}

        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          aria-label="Full screen"
          title="Full screen (F)"
        >
          <FullscreenIcon size={14} />
        </button>

        <button
          type="button"
          className={settingsOpen ? "active" : ""}
          onClick={() => setSettingsOpen((open) => !open)}
          aria-label="Slideshow settings"
          title="Slideshow settings"
        >
          <GearIcon size={16} />
        </button>

        <button type="button" className="slideshow-stop" onClick={close}>
          <StopIcon size={13} /> Stop
        </button>
      </div>

      {/* Settings popover */}
      {settingsOpen && (
        <div
          className="slideshow-settings-pop"
          role="dialog"
          aria-label="Slideshow settings"
        >
          <div className="slideshow-settings-head">
            <b>Slideshow</b>
            <button
              type="button"
              onClick={() => setSettingsOpen(false)}
              aria-label="Close settings"
            >
              ×
            </button>
          </div>

          <label className="slideshow-setting">
            <span>
              Interval <i>{interval}s</i>
            </span>
            <input
              type="range"
              min={2}
              max={30}
              step={1}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
            />
          </label>

          <label className="slideshow-setting row">
            <input
              type="checkbox"
              checked={shuffle}
              onChange={(e) => setShuffle(e.target.checked)}
            />
            <span>Shuffle</span>
          </label>

          <label className="slideshow-setting">
            <span>Transition</span>
            <select
              value={transition}
              onChange={(e) =>
                setTransition(e.target.value as SlideshowTransition)
              }
            >
              <option value="fade">Fade</option>
              <option value="slide">Slide</option>
              <option value="none">None</option>
            </select>
          </label>
        </div>
      )}

      {hintsVisible && (
        <div className="slideshow-hints" role="status" aria-live="polite">
          Space play/pause · ←/→ navigate · Esc close · F fullscreen · M mute ·
          +/- zoom · R rotate
        </div>
      )}
    </div>
  );
}
