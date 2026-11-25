import { useCallback, useEffect, useRef, useState } from "react";
import {
  useSlideshowStore,
  useDraftTransforms,
  draftTransformStyle,
  debugLog,
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
  MusicIcon,
} from "./icons";
import { CachedThumbnail } from "./CachedThumbnail";
import { canPlayVideoInApp, canDecodeStill } from "../../engine/utils/mediaTypes";
import {
  isPictureInPicture,
  supportsPictureInPicture,
  togglePictureInPicture,
} from "../../engine/utils/pictureInPicture";
import { formatItemDate } from "../../engine/utils/mediaDate";
import { convertFileSrc } from "@tauri-apps/api/core";
import { tauri } from "../../engine/commands/tauri";
import type { PreparedPlayback } from "../../engine/types/generated/ipc";

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
  const ambientPath = useSlideshowStore((s) => s.ambientPath);
  const ambientMuted = useSlideshowStore((s) => s.ambientMuted);
  const ambientVolume = useSlideshowStore((s) => s.ambientVolume);
  const ambientError = useSlideshowStore((s) => s.ambientError);
  const item = items[index];
  const close = useSlideshowStore((s) => s.close);
  const next = useSlideshowStore((s) => s.next);
  const previous = useSlideshowStore((s) => s.previous);
  const toggle = useSlideshowStore((s) => s.toggle);
  const setInterval = useSlideshowStore((s) => s.setInterval);
  const setShuffle = useSlideshowStore((s) => s.setShuffle);
  const setTransition = useSlideshowStore((s) => s.setTransition);
  const setAmbientMuted = useSlideshowStore((s) => s.setAmbientMuted);
  const setAmbientVolume = useSlideshowStore((s) => s.setAmbientVolume);

  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [pip, setPip] = useState(false);
  const [pipSupported, setPipSupported] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(false);
  const [hintsVisible, setHintsVisible] = useState(true);
  const hintsTimer = useRef<number | null>(null);

  // Still formats the web view cannot decode (RAW, HEIC, WebP, ...) are served
  // a macOS-rendered JPEG preview instead of the original, so the slideshow
  // never shows a blank frame or a broken image for them.
  const [preview, setPreview] = useState<{
    id: string;
    src: string;
    /** A cached thumbnail stood in for a preview that could not be rendered. */
    lowRes: boolean;
  } | null>(null);
  const [photoLoadState, setPhotoLoadState] = useState<{
    id: string;
    status: "loading" | "loaded" | "failed";
  } | null>(null);
  const [photoFallbackId, setPhotoFallbackId] = useState<string | null>(null);

  // RAW files and stills the web view cannot decode (HEIC, WebP, TIFF, …) are
  // shown from a macOS-rendered JPEG preview instead of the undecodable
  // original. `photoFallbackId` flips a decodable photo onto the preview path
  // after its original fails to load, mirroring the Viewer.
  const needsPreview =
    !!item &&
    (item.kind === "raw" || (item.kind === "photo" && !canDecodeStill(item.path, item.name)));
  const viaPreview = needsPreview || (!!item && photoFallbackId === item.id);

  const hideTimer = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoMuted, setVideoMuted] = useState(false);
  const [videoVolume, setVideoVolume] = useState(1);
  // True while the pointer or keyboard focus is on the HUD. Auto-hide must not
  // re-arm then, otherwise the controls fade out from under the cursor.
  const hudHeldRef = useRef(false);

  // Playback source resolution. WebKit plays the original when it can decode
  // it; anything else (MKV, AVI, …) is remuxed losslessly by the backend and
  // served from the cache. The resolved src is held in state so the <video>
  // never hands WebKit a container it would pull the whole file for.
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoPreparing, setVideoPreparing] = useState(false);
  // The resolved plan is cached by source path. A single-slot cache (no path
  // key) would hand slide B the plan resolved for slide A, so two undecodable
  // videos back to back would show A's footage under B's caption.
  const videoPlanRef = useRef<{ path: string; plan: PreparedPlayback | null } | null>(null);
  const videoPlanInFlight = useRef<{
    path: string;
    promise: Promise<PreparedPlayback | null>;
  } | null>(null);

  const resolveVideoPlan = useCallback(
    async (path: string | undefined): Promise<PreparedPlayback | null> => {
      if (!path) return null;
      if (videoPlanRef.current?.path === path) return videoPlanRef.current.plan;
      if (videoPlanInFlight.current?.path === path) return videoPlanInFlight.current.promise;
      const promise = tauri.items.preparePlayback(path, false);
      videoPlanInFlight.current = { path, promise };
      try {
        const plan = await promise;
        videoPlanRef.current = { path, plan };
        return plan;
      } finally {
        if (videoPlanInFlight.current?.path === path) {
          videoPlanInFlight.current = null;
        }
      }
    },
    [],
  );

  // Resolve the playback plan when the video item changes. The <video> element
  // keeps its old src until a remuxed copy is ready, so an undecodable
  // container never reaches WebKit at all — not even on first paint.
  useEffect(() => {
    if (item?.kind !== "video" || !item.path) {
      setVideoSrc(null);
      setVideoPreparing(false);
      videoPlanRef.current = null;
      return;
    }
    if (canPlayVideoInApp(item.path, item.name)) {
      setVideoSrc(assetUrl(item.path));
      setVideoPreparing(false);
      videoPlanRef.current = null;
      return;
    }
    let cancelled = false;
    setVideoPreparing(true);
    void resolveVideoPlan(item.path).then((plan) => {
      if (cancelled) return;
      if (plan?.strategy === "remuxed") {
        setVideoSrc(convertFileSrc(plan.path));
      } else {
        setVideoSrc(null);
      }
      setVideoPreparing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.path, item?.name, item?.kind, assetUrl, resolveVideoPlan]);

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
    setPipSupported(supportsPictureInPicture(video));
    const onEnter = () => setPip(true);
    const onLeave = () => setPip(false);
    const onWebKit = () => setPip(isPictureInPicture(video));
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    video.addEventListener("webkitpresentationmodechanged", onWebKit);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
      video.removeEventListener("webkitpresentationmodechanged", onWebKit);
    };
  }, [item?.id, item?.kind]);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      await togglePictureInPicture(video);
    } catch (err) {
      debugLog("Picture-in-picture unavailable", err);
    }
  }, []);

  // Sync play/pause with the video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video || item?.kind !== "video") return;
    if (playing) {
      // Pause every other audible surface (e.g. the background player) so a
      // slideshow video never shares audio with another <video> element.
      document.querySelectorAll("video").forEach((other) => {
        if (other === video) return;
        try {
          other.pause();
        } catch {}
      });
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
    return () => video.pause();
  }, [item?.id, item?.kind, playing]);

  // Reset transforms when item changes
  useEffect(() => {
    setZoom(100);
    setRotation(0);
    setFlipX(false);
  }, [item?.id]);

  // The show is a modal dialog: VoiceOver and the keyboard should land in it.
  // Focus the overlay itself, not its first button (Space must stay
  // play/pause rather than pressing "Previous slide"), and hand focus back
  // to where it was when the show closes.
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    overlayRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [isOpen]);

  // The overlay is a modal dialog, so Tab has to stay inside it: without a
  // trap, tabbing off the last control walks into the library behind the show.
  // The stage itself is the initial focus target, so the first Tab lands on the
  // transport and Shift+Tab from there wraps to the last control.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const root = overlayRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // The stage is focused on open and focus can sit outside the overlay
      // after a mouse click; both count as "at an edge" so Tab re-enters.
      const outside = !active || active === root || !root.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen]);

  // Cleanup on close
  useEffect(() => {
    if (!isOpen) {
      setSettingsOpen(false);
      hudHeldRef.current = false;
      setPreview(null);
      setPhotoLoadState(null);
      setPhotoFallbackId(null);
    }
  }, [isOpen]);

  // Fetch the display preview for a hard still. Falls back to a 1024 thumbnail
  // if ImageIO cannot render it, then marks the photo as failed.
  const fallBackToThumbnail = useCallback(async (id: string) => {
    try {
      const thumb = await tauri.library.getThumbnail({ itemId: id, size: 1024 });
      if (thumb?.dataUrl) {
        setPreview({ id, src: thumb.dataUrl, lowRes: true });
        return;
      }
    } catch {
      // Fall through to the failed state.
    }
    setPhotoLoadState({ id, status: "failed" });
  }, []);

  useEffect(() => {
    if (!item || !viaPreview) {
      setPreview(null);
      return;
    }
    const id = item.id;
    let cancelled = false;
    setPhotoLoadState({ id, status: "loading" });
    tauri.library
      .getDisplayPreview(id, false)
      .then((result) => {
        if (cancelled) return;
        const src = result.path ? assetUrl(result.path) : result.dataUrl;
        if (!src) throw new Error("empty preview");
        setPreview({ id, src, lowRes: false });
        setPhotoLoadState({ id, status: "loaded" });
      })
      .catch(() => {
        if (cancelled) return;
        void fallBackToThumbnail(id);
      });
    return () => {
      cancelled = true;
    };
    // `viaPreview` and `item?.id` fully describe when a new preview is needed;
    // `assetUrl`/`fallBackToThumbnail` are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, viaPreview, assetUrl, fallBackToThumbnail]);

  // If the original photo fails to load, ask ImageIO for a preview. This is
  // the same two-step dance the Viewer uses: try the original, then fall back.
  const onPhotoError = () => {
    const it = item;
    if (!it) return;
    if (!viaPreview) {
      setPhotoLoadState({ id: it.id, status: "loading" });
      setPhotoFallbackId(it.id);
      return;
    }
    // The preview itself failed to load: try a cached thumbnail, else give up.
    if (preview?.id === it.id && !preview.lowRes) {
      void fallBackToThumbnail(it.id);
      return;
    }
    setPhotoLoadState({ id: it.id, status: "failed" });
  };

  // Keyboard shortcuts (capture phase to beat the Viewer underneath)
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Focus trap: keep Tab inside the dialog so it never walks into the
      // library behind the modal. The overlay itself is the initial focus
      // (tabIndex -1), so Tab from it lands on the first control and
      // Shift+Tab on the last, wrapping at each end.
      if (e.key === "Tab") {
        const root = overlayRef.current;
        if (root) {
          const focusables = Array.from(
            root.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          );
          if (focusables.length > 0) {
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement as HTMLElement | null;
            const index = active ? focusables.indexOf(active) : -1;
            if (e.shiftKey) {
              if (index <= 0) {
                e.preventDefault();
                last.focus();
              }
            } else if (index === -1 || index === focusables.length - 1) {
              e.preventDefault();
              first.focus();
            }
            return;
          }
        }
      }

      // Never hijack a focused control. The settings popover (interval slider,
      // transition select, shuffle checkbox) and the seek/volume sliders are
      // real inputs: Space, arrows and +/- must reach them, not the show.
      // Escape still closes the show, except from a <select> that wants it to
      // dismiss its own dropdown first.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const editable =
        !!target &&
        (target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT");
      if (e.key === "Escape" && settingsOpen && tag !== "SELECT") {
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen(false);
        settingsTrigger.current?.focus();
        return;
      }
      if (editable) {
        if (e.key === "Escape" && tag !== "SELECT") {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
        return;
      }

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
      } else if (e.key === "ArrowUp" && item?.kind === "video" && videoRef.current) {
        e.preventDefault();
        e.stopPropagation();
        const v = videoRef.current;
        v.volume = Math.min(1, v.volume + 0.1);
        if (v.volume > 0) v.muted = false;
      } else if (e.key === "ArrowDown" && item?.kind === "video" && videoRef.current) {
        e.preventDefault();
        e.stopPropagation();
        const v = videoRef.current;
        v.volume = Math.max(0, v.volume - 0.1);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        e.stopPropagation();
        setZoom((z) => Math.min(300, z + 25));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        e.stopPropagation();
        setZoom((z) => Math.max(25, z - 25));
      } else if (e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        setZoom(100);
        setRotation(0);
        setFlipX(false);
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        e.stopPropagation();
        setRotation((r) => (r + 90) % 360);
      } else if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        e.stopPropagation();
        setFlipX((f) => !f);
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        e.stopPropagation();
        void toggleFullscreen();
      } else if (e.key === "m" && item?.kind === "video") {
        e.preventDefault();
        e.stopPropagation();
        const v = videoRef.current;
        if (v) {
          v.muted = !v.muted;
        }
      } else if ((e.key === "p" || e.key === "P") && item?.kind === "video" && pipSupported) {
        e.preventDefault();
        e.stopPropagation();
        void togglePip();
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen((open) => !open);
      } else if (e.key === "b" && ambientPath) {
        e.preventDefault();
        e.stopPropagation();
        setAmbientMuted(!ambientMuted);
      } else if (e.key === "v" && ambientPath) {
        e.preventDefault();
        e.stopPropagation();
        setAmbientVolume(ambientVolume <= 0.05 ? 0.4 : ambientVolume - 0.1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    isOpen,
    settingsOpen,
    close,
    next,
    previous,
    toggle,
    item,
    pipSupported,
    ambientPath,
    ambientMuted,
    ambientVolume,
    setAmbientMuted,
    setAmbientVolume,
    togglePip,
  ]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.querySelector(".slideshow-overlay")?.requestFullscreen();
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
  const hasVideoSrc = isVideo && (canPlayVideoInApp(item.path, item.name) || videoSrc);
  // Stills show the macOS-rendered preview when one is needed (a container the
  // web view cannot decode, or an original that failed to load), the original
  // when it can decode it, and the cached thumbnail while that preview is
  // rendered. A slide is never a blank stage.
  const previewSrc = preview?.id === item.id ? preview.src : null;
  const stillStatus = photoLoadState?.id === item.id ? photoLoadState.status : null;
  const stillSrc = isVideo ? null : viaPreview ? previewSrc : assetUrl(item.path);

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
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
        {isVideo && !hasVideoSrc ? (
          <div className="slideshow-video-fallback">
            <CachedThumbnail itemId={item.id} name={item.name} size={1024} />
            {videoPreparing ? (
              <p>Preparing this video for playback…</p>
            ) : (
              <p>This format can't play in the slideshow. Open it from the Library to watch it.</p>
            )}
          </div>
        ) : isVideo && videoPreparing ? (
          <div className="slideshow-video-fallback">
            <CachedThumbnail itemId={item.id} name={item.name} size={1024} />
            <p>Preparing this video for playback…</p>
          </div>
        ) : isVideo ? (
          <video
            ref={videoRef}
            src={videoSrc ?? assetUrl(item.path)}
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
        ) : stillSrc ? (
          <img
            src={stillSrc}
            alt={item.name}
            decoding="async"
            onError={onPhotoError}
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
          <div className="slideshow-video-fallback">
            <CachedThumbnail itemId={item.id} name={item.name} size={1024} />
            <p>
              {stillStatus === "failed"
                ? "This image can't be displayed in the slideshow. Open it from the Library."
                : "Preparing this photo…"}
            </p>
          </div>
        )}
      </div>

      {/* Top-right position indicator */}
      <span className="slideshow-position">{position}</span>

      {/* Bottom HUD: the caption sits above the controls in a shared
          bottom-anchored column, so its offset is structural (no magic number)
          however tall the control bar grows. */}
      <div className="slideshow-bottom">
        <div className="slideshow-caption">
          <div className="slideshow-caption-name">{item.name}</div>
          <div className="slideshow-caption-meta">
            {formatItemDate(item)}
            {item.extension ? ` · ${item.extension.toUpperCase()}` : ""}
          </div>
        </div>

        <div
          className="slideshow-controls"
          onMouseEnter={holdHud}
          onMouseLeave={releaseHud}
          onFocusCapture={holdHud}
          onBlurCapture={releaseHud}
        >
          {/* Transport - all same style */}
          <button type="button" onClick={previous} aria-label="Previous slide" title="Previous (←)">
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
          <button type="button" onClick={next} aria-label="Next slide" title="Next (→)">
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

          {/* Ambient audio - a track the user picked in Settings, played under the show.
            It is independent of the video's volume so a muted video does not
            silence the background track, and vice versa. */}
          {ambientPath && (
            <>
              <button
                type="button"
                className="slideshow-ambient-btn"
                onClick={() => setAmbientMuted(!ambientMuted)}
                aria-label={ambientMuted ? "Unmute ambient audio" : "Mute ambient audio"}
                aria-pressed={ambientMuted}
                title={
                  ambientError
                    ? "Ambient track unavailable — re-pick it in Settings"
                    : ambientMuted
                      ? "Unmute ambient audio (B)"
                      : "Mute ambient audio (B)"
                }
              >
                <MusicIcon size={14} muted={ambientMuted || ambientError} />
              </button>
              {ambientError ? (
                <span className="slideshow-ambient-error" role="status">
                  Ambient track unavailable
                </span>
              ) : (
                <input
                  type="range"
                  className="slideshow-ambient-volume"
                  min={0}
                  max={1}
                  step={0.05}
                  value={ambientMuted ? 0 : ambientVolume}
                  onChange={(e) => setAmbientVolume(Number(e.target.value))}
                  onMouseDown={() => holdHud()}
                  onMouseUp={() => releaseHud()}
                  aria-label="Ambient audio volume"
                />
              )}
            </>
          )}

          {/* Right side actions - inline, no dropdown. The first tool carries
              the auto margin that keeps the transport on the left and the
              tools on the right, even in photo mode where no seek bar absorbs
              the free space. */}
          <button
            type="button"
            className="slideshow-tools-start"
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
            aria-pressed={flipX}
            title="Flip horizontal (T)"
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
              aria-pressed={pip}
              title="Picture in picture (P)"
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
            ref={settingsTrigger}
            className={settingsOpen ? "active" : ""}
            onClick={() => setSettingsOpen((open) => !open)}
            aria-label="Slideshow settings"
            aria-pressed={settingsOpen}
            title="Slideshow settings (S)"
          >
            <GearIcon size={16} />
          </button>

          <button type="button" className="slideshow-stop" onClick={close}>
            <StopIcon size={13} /> Stop
          </button>
        </div>
      </div>

      {/* Settings popover */}
      {settingsOpen && (
        <div className="slideshow-settings-pop" role="dialog" aria-label="Slideshow settings">
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
              onChange={(e) => setTransition(e.target.value as SlideshowTransition)}
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
          Space play/pause · ←/→ navigate · Esc close · F fullscreen · M mute · ↑/↓ volume · +/-
          zoom · 0 reset · R rotate · T flip · S settings · P PiP · B/V ambient
        </div>
      )}
    </div>
  );
}
