import React, { useRef, useState, useEffect, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
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
  InfoIcon,
} from "./icons";
import { tauri } from "../../engine/commands/tauri";
import type { ExternalPlayer } from "../../engine/types/commands";
import { formatDuration } from "../../engine/utils/time";
import {
  canPlayVideoInApp,
  classifyVideoFailure,
  fileExtension,
} from "../../engine/utils/mediaTypes";
import {
  observePictureInPicture,
  supportsPictureInPicture,
  togglePictureInPicture,
} from "../../engine/utils/pictureInPicture";

type PlaybackSnapshot = ReturnType<typeof usePlaybackStore.getState>;

// WKWebView can decode MP4/MOV (H.264/HEVC) and WebM, but not Matroska or AVI.
// Files outside the supported list never reach the <video> element: WebKit
// renders a black frame for them, which made the whole viewer look broken.

// Shortcut list for the transport bar. Same keys the strip that used to float
// over the video listed, in the order they are reached for.
const PLAYER_SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["J", "K"], label: "Prev / next" },
  { keys: ["Space"], label: "Play / pause" },
  { keys: ["←", "→"], label: "Seek" },
  { keys: ["↑", "↓"], label: "Volume" },
  { keys: ["M"], label: "Mute" },
  { keys: ["L"], label: "Favorite" },
  { keys: ["F"], label: "Full screen" },
];

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
  onToggleFavorite,
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
  /** Favorite the playing item (L / F keyboard shortcuts). */
  onToggleFavorite?: () => void;
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
  const controlsFocusedRef = useRef(false);
  const barHoveredRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [keyboardFocusWithinControls, setKeyboardFocusWithinControls] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpOpenRef = useRef(false);
  const helpRef = useRef<HTMLDivElement | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => usePlaybackStore.getState().lastVolume);
  const [muted, setMuted] = useState(false);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const [pictureInPictureSupported, setPictureInPictureSupported] = useState(false);
  const [pictureInPictureError, setPictureInPictureError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [autoAdvance, setAutoAdvance] = useState(false);
  // Playback source resolution. WebKit plays the original file when it can
  // decode it; anything else is remuxed losslessly by the backend and served
  // from the cache. `preparing` covers the gap, so an undecodable container
  // never reaches <video> at all — not even on the first paint, where WebKit
  // would start pulling the whole file for nothing.
  const [resolvedSrc, setResolvedSrc] = useState(() => (canPlayVideoInApp(path, name) ? src : ""));
  const [preparing, setPreparing] = useState(() => Boolean(path) && !canPlayVideoInApp(path, name));
  const [failureDetail, setFailureDetail] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [videoError, setVideoError] = useState<MediaError | null>(null);
  const [players, setPlayers] = useState<ExternalPlayer[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);

  const scheduleControlsHide = useCallback(() => {
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    // The shortcut list is a child of the transport, so fading the transport
    // would take it away mid-read, and a pointer resting on the bar means the
    // hand is already there: it used to disappear under the cursor.
    if (!playing || controlsFocusedRef.current || helpOpenRef.current || barHoveredRef.current)
      return;
    controlsTimerRef.current = window.setTimeout(() => {
      // Re-checked when the timer fires, not only when it is set: a timer started
      // before the pointer arrived would otherwise hide the bar under the hand
      // that just moved onto it.
      if (barHoveredRef.current) return;
      setControlsVisible(false);
    }, 3500);
  }, [playing]);

  const showPlayerActivity = useCallback(() => {
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  // Shortcuts open from the transport instead of floating over the video, the
  // way the stills viewer keeps its list in the bar. A click anywhere else
  // closes the list.
  useEffect(() => {
    helpOpenRef.current = helpOpen;
    if (!helpOpen) return;
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    setControlsVisible(true);
    const onPointerDown = (event: PointerEvent) => {
      if (!helpRef.current?.contains(event.target as Node)) setHelpOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [helpOpen]);

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
    };
  }, [src, showPlayerActivity]);

  const requestPlaybackPlan = useCallback(
    async (forceRemux: boolean) => {
      if (!path) return null;
      try {
        return await tauri.items.preparePlayback(path, forceRemux);
      } catch {
        return null;
      }
    },
    [path],
  );

  // Re-copy a file that probed as playable but decoded no frames. WKWebView
  // reports nothing useful for a damaged index, so a remux is the only way to
  // tell a broken container apart from an unsupported codec.
  // Chosen when an item is registered and re-used by the setup effect below: the
  // store cannot answer "was this a handoff" once it has been pointed at the
  // new item.
  const handoffSnapshotRef = useRef<PlaybackSnapshot | null>(null);
  const remuxRetriedRef = useRef(false);
  // Resolves true when the retry produced a playable copy.
  const retryRemuxRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  // Assigned in an effect, not during render: a render React throws away would
  // otherwise leave a callback from an uncommitted tree in the ref.
  useEffect(() => {
    retryRemuxRef.current = async () => {
      if (!path || remuxRetriedRef.current) return false;
      remuxRetriedRef.current = true;
      setPreparing(true);
      const plan = await requestPlaybackPlan(true);
      setPreparing(false);
      if (!plan || plan.strategy !== "remuxed") return false;
      setFailureDetail(null);
      setVideoError(null);
      setFailed(false);
      setResolvedSrc(convertFileSrc(plan.path));
      return true;
    };
  }, [path, requestPlaybackPlan]);

  // A different item can use a different container, so re-evaluate on change.
  // The extension allow-list decides what can start playing immediately, but the
  // probe runs either way: an extension predicts very little about a file (an
  // MP4 can carry `hev1` HEVC that WebKit refuses, a Matroska can carry VP9), and
  // its answer arrives fast enough that it can only ever upgrade the source.
  useEffect(() => {
    let cancelled = false;
    remuxRetriedRef.current = false;
    setFailureDetail(null);
    setOpenError(null);
    setVideoError(null);
    setFailed(false);
    const nativeByExtension = canPlayVideoInApp(path, name);
    setResolvedSrc(nativeByExtension ? src : "");
    setPreparing(Boolean(path) && !nativeByExtension);
    if (!path) return;

    void requestPlaybackPlan(false).then((plan) => {
      if (cancelled) return;
      setPreparing(false);
      // No backend (browser preview, harness): behave exactly as before.
      if (!plan) {
        setResolvedSrc(src);
        return;
      }
      if (plan.strategy === "unsupported") {
        setFailureDetail(plan.detail ?? null);
        setFailed(true);
        return;
      }
      // A probe can also unlock a container the allow-list did not know.
      setResolvedSrc(plan.strategy === "remuxed" ? convertFileSrc(plan.path) : src);
    });

    return () => {
      cancelled = true;
    };
  }, [src, path, name, requestPlaybackPlan]);

  // Report one media-element snapshot per opened video (and every error) to
  // the app log. Without it a black picture that reports no error leaves no
  // trace at all, since the webview console is not visible in a Tauri window.
  useEffect(() => {
    if (!path) return;
    const report = (label: string) => {
      const video = ref.current;
      if (!video) return;
      const element = video as HTMLVideoElement & {
        getVideoPlaybackQuality?: () => { totalVideoFrames?: number };
        webkitDecodedFrameCount?: number;
      };
      const error = video.error;
      const rect = video.getBoundingClientRect();
      const style = window.getComputedStyle(video);
      const sample = {
        src: video.currentSrc,
        // The box separates "not decoding" from "decoding but not laid out":
        // a 0-height or hidden element has data and no visible picture.
        box: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        objectFit: style.objectFit,
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        currentTime: Math.round(video.currentTime * 100) / 100,
        duration: Number.isFinite(video.duration) ? video.duration : -1,
        size: `${video.videoWidth}x${video.videoHeight}`,
        errorCode: error?.code ?? 0,
        errorMessage: error?.message ?? "",
        decodedFrames:
          element.getVideoPlaybackQuality?.()?.totalVideoFrames ??
          element.webkitDecodedFrameCount ??
          -1,
      };
      void tauri.items.logPlaybackDiagnostic(label, JSON.stringify(sample)).catch(() => {});
    };
    const video = ref.current;
    const onError = () => report("error");
    video?.addEventListener("error", onError);
    // Report immediately as well: a quick click through the queue must still
    // leave a trace, and a missing line would otherwise look like a crash.
    report("mount");
    const timer = window.setTimeout(() => report("state"), 2500);
    return () => {
      window.clearTimeout(timer);
      video?.removeEventListener("error", onError);
    };
  }, [resolvedSrc, path]);

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
    // Read the snapshot before registering: registerPlayback points the store at
    // this item, so a check afterwards always matches. A queue switch then looked
    // like a handoff for the same video, and the paused snapshot it restored
    // turned autoplay off, so the next clip loaded but never started.
    const previous = usePlaybackStore.getState();
    const handoff = previous.itemId === itemId && previous.duration > 0;
    handoffSnapshotRef.current = handoff ? previous : null;
    registerPlayback(video, { itemId, name: name || "Video" });
    if (handoff) {
      // Handoff between foreground/background players: snapshot survived.
      // Resume playback if it was playing; sync volume/muted from snapshot.
      if (previous.playing && video.paused) {
        void video.play().catch(() => {});
      }
      video.volume = previous.volume;
      video.muted = previous.muted;
    } else {
      // Fresh video: no snapshot to preserve; record current element state.
      syncPlayback({
        playing: !video.paused,
        time: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        muted: video.muted,
        volume: video.volume,
      });
      // A handoff can have turned the attribute off for the paused case above;
      // a new item asks for playback again.
      video.autoplay = videoAutoPlay || forceAutoPlay;
      // WKWebView is finicky about autoplay for tiny background hosts: the
      // attribute alone can stall indefinitely with the host page inert. Ask
      // for playback explicitly; it happens within the user's gesture when
      // the click started the session. Unconditional: the user gesture is
      // the signal, not the attribute.
      void video.play().catch(() => {});
    }
    return () => unregisterPlayback(video);
  }, [
    itemId,
    name,
    registerPlayback,
    unregisterPlayback,
    syncPlayback,
    videoAutoPlay,
    forceAutoPlay,
  ]);

  // A queued video is a different timeline. The shared snapshot keeps the
  // *controls* (volume, mute, play/pause) across items, never the position,
  // and the reused <video> element can hold the previous clip's time until the
  // new source finishes loading — which showed its progress bar on the next
  // video. Reset both whenever the item itself changes.
  const lastItemIdRef = useRef(itemId);
  useEffect(() => {
    if (lastItemIdRef.current === itemId) return;
    lastItemIdRef.current = itemId;
    // The shortcut list was opened for the video that just left.
    setHelpOpen(false);
    const video = ref.current;
    if (video) video.currentTime = 0;
    setTime(0);
    // Only the position belongs to the new item. Duration belongs to the
    // element, and a source that brings a different one reports it through
    // durationchange, so resetting it here only threw away a value that was
    // still correct and left the readout with a zero total.
    syncPlayback({ time: 0 });
  }, [itemId, syncPlayback]);

  useEffect(() => {
    const video = ref.current as HTMLVideoElement | null;
    if (!video) return;

    // Restore the snapshot only when the item was registered as a handoff, and
    // restore it from that snapshot rather than from the store: registering
    // points the store at this item, and the retained duration survives a queue
    // switch on purpose, so reading it back here cannot tell the two apart.
    // Consumed on read: this effect also re-runs when the source is replaced or
    // a remux gives up, and a snapshot left in the ref would rewind a session
    // that has long moved on.
    const snapshot = handoffSnapshotRef.current;
    handoffSnapshotRef.current = null;
    if (snapshot && snapshot.itemId === itemId && snapshot.duration > 0) {
      const { time, volume, muted, playing, duration } = snapshot;
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
      // Safe to read after registering: the store only ever writes lastVolume
      // from the volume effect, never while registering an item.
      const lastVolume = usePlaybackStore.getState().lastVolume;
      setVolume(lastVolume);
      video.volume = lastVolume;
      setMuted(false);
    }

    let noVideoTrackTimer: number | null = null;
    let noDecodedFramesTimer: number | null = null;
    let sawVideoFrame = false;

    const markPlaybackFailure = () => {
      if (failed) return;
      setVideoError({ code: 3 } as MediaError);
      // A file can probe as playable and still decode nothing (damaged index,
      // odd edit list). Try the remux once before giving up on in-app playback;
      // the viewer keeps the frame and shows "Preparing playback…" meanwhile.
      void retryRemuxRef.current().then((recovered) => {
        if (!recovered) setFailed(true);
      });
    };

    const getDecodedFrameCount = () => {
      const quality = (
        video as HTMLVideoElement & {
          getVideoPlaybackQuality?: () => { totalVideoFrames?: number };
        }
      ).getVideoPlaybackQuality?.();
      if (quality && typeof quality.totalVideoFrames === "number") {
        return quality.totalVideoFrames;
      }
      const webkitDecoded = (video as HTMLVideoElement & { webkitDecodedFrameCount?: number })
        .webkitDecodedFrameCount;
      return typeof webkitDecoded === "number" ? webkitDecoded : null;
    };

    // WebKit exposes requestVideoFrameCallback but never calls it when the
    // stream produces no frames. That leaves a black picture with a working
    // transport bar and advancing time, and no `error` event — nothing else in
    // this component notices, because dimensions are reported normally. A real
    // video presents its first frame well inside this window.
    let frameWatchdog: number | null = null;
    const startFrameWatchdog = () => {
      if (sawVideoFrame || failed) return;
      if (frameWatchdog) window.clearTimeout(frameWatchdog);
      frameWatchdog = window.setTimeout(() => {
        const media = ref.current;
        if (!media || sawVideoFrame || failed) return;
        if (media.paused || media.currentTime < 0.15) return;
        markPlaybackFailure();
      }, 1500);
    };

    const checkDecodedFrames = () => {
      if (failed || sawVideoFrame) return;
      const el = ref.current;
      if (!el) return;
      // With a frame callback available the watchdog above is the reliable
      // signal; decoded-frame counters lag or stay at zero in WebKit.
      if (Reflect.has(el, "requestVideoFrameCallback")) return;
      if (el.readyState < 2) return;
      const decoded = getDecodedFrameCount();
      if (decoded !== null && decoded > 0) {
        sawVideoFrame = true;
        if (noDecodedFramesTimer) {
          window.clearTimeout(noDecodedFramesTimer);
          noDecodedFramesTimer = null;
        }
        return;
      }
      if (decoded === null) return;
      const progressing =
        (el.currentTime > 0.25 || !el.paused) &&
        (Number.isFinite(el.duration) || el.currentTime > 0.25);
      if (!progressing) return;
      if (noDecodedFramesTimer) window.clearTimeout(noDecodedFramesTimer);
      noDecodedFramesTimer = window.setTimeout(() => {
        const media = ref.current;
        if (!media) return;
        const nextDecoded = getDecodedFrameCount();
        const stillProgressing =
          (media.currentTime > 0.25 || !media.paused) &&
          (Number.isFinite(media.duration) || media.currentTime > 0.25);
        if (!failed && !sawVideoFrame && stillProgressing && nextDecoded === 0) {
          markPlaybackFailure();
        }
      }, 2000);
    };

    const checkVideoTrack = () => {
      // Some files (e.g. unsupported video codec inside a supported container)
      // play audio but expose no decodable video frames. Treat as a playback
      // failure so the user can open the file in an external player.
      // Be conservative: dimensions can be reported late, and playable videos
      // must not be misclassified as audio-only.
      if (failed) return;
      if (video.readyState >= 2 && video.videoWidth === 0 && video.videoHeight === 0) {
        if (noVideoTrackTimer) window.clearTimeout(noVideoTrackTimer);
        noVideoTrackTimer = window.setTimeout(() => {
          if (
            video.readyState >= 2 &&
            video.videoWidth === 0 &&
            video.videoHeight === 0 &&
            (video.currentTime > 0 || !video.paused || Number.isFinite(video.duration))
          ) {
            markPlaybackFailure();
          }
        }, 1500);
      } else if (video.videoWidth > 0 || video.videoHeight > 0) {
        if (noVideoTrackTimer) {
          window.clearTimeout(noVideoTrackTimer);
          noVideoTrackTimer = null;
        }
        checkDecodedFrames();
      }
    };

    const requestFrameCallback = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
        cancelVideoFrameCallback?: (id: number) => void;
      }
    ).requestVideoFrameCallback;
    let videoFrameCallbackId: number | null = null;
    if (typeof requestFrameCallback === "function") {
      const onFrame = () => {
        sawVideoFrame = true;
        if (noDecodedFramesTimer) {
          window.clearTimeout(noDecodedFramesTimer);
          noDecodedFramesTimer = null;
        }
      };
      try {
        videoFrameCallbackId = requestFrameCallback.call(video, onFrame);
      } catch {
        videoFrameCallbackId = null;
      }
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
      checkDecodedFrames();
    };
    const onPlay = () => {
      setPlaying(true);
      syncPlayback({ playing: true });
    };
    const onPause = () => {
      setPlaying(false);
      syncPlayback({ playing: false });
    };

    const onLoadedData = () => checkVideoTrack();
    const onPlaying = () => {
      onPlay();
      checkVideoTrack();
      checkDecodedFrames();
      startFrameWatchdog();
    };

    const onCanPlay = () => {
      checkVideoTrack();
      checkDecodedFrames();
    };
    video.addEventListener("loadedmetadata", onMetadata);
    // loadedmetadata fires once; a duration that arrives or changes later (a
    // stream, or a source swapped under a mounted element) only reports here.
    video.addEventListener("durationchange", onMetadata);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlaying);
    video.addEventListener("pause", onPause);
    // A second, belt-and-suspenders attempt once the media is actually ready:
    // the mount-time play() can lose the race against the canplay event in
    // WKWebView, which silently leaves the video idle at 0:00.
    const attemptAutoPlay = () => void video.play().catch(() => {});
    if (!snapshot) {
      video.addEventListener("canplay", attemptAutoPlay, { once: true });
    }
    if (video.readyState >= 1) onMetadata();
    if (video.readyState >= 2) {
      checkVideoTrack();
      checkDecodedFrames();
    }
    return () => {
      if (noVideoTrackTimer) window.clearTimeout(noVideoTrackTimer);
      if (noDecodedFramesTimer) window.clearTimeout(noDecodedFramesTimer);
      if (frameWatchdog) window.clearTimeout(frameWatchdog);
      if (
        videoFrameCallbackId !== null &&
        typeof (video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void })
          .cancelVideoFrameCallback === "function"
      ) {
        try {
          (video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void })
            .cancelVideoFrameCallback!(videoFrameCallbackId);
        } catch {
          // ignore
        }
      }
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("durationchange", onMetadata);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("canplay", attemptAutoPlay);
    };
    // `failed` is a dependency because the guards below short-circuit on it;
    // reading it from an older render made them permanently false.
    // `itemId` is deliberately omitted: re-running this setup when the queue
    // advances to the next video with the same resolved source throws away the
    // duration and loop state that is already correct. The queue-advance test
    // in VideoPlayer.test.tsx covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedSrc, syncPlayback, failed]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setPictureInPictureSupported(supportsPictureInPicture(video));
    setPictureInPictureError(null);
    return observePictureInPicture(video, setPictureInPicture);
  }, [resolvedSrc]);

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
  }, [resolvedSrc, autoAdvance, active, compact, onNext, syncPlayback]);

  // Pause playback when the player host is removed, such as after Stop.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    return () => {
      if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
      video.pause();
    };
  }, []);

  // Keyboard shortcuts for active video playback
  const adjustVolume = useCallback((delta: number) => {
    setVolume((current) => {
      const next = Math.min(1, Math.max(0, current + delta));
      if (next > 0) setMuted(false);
      return next;
    });
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video || compact || !active) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
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
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        e.stopPropagation();
        onPrevious?.();
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        e.stopPropagation();
        void onNext?.();
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        e.stopPropagation();
        onToggleFavorite?.();
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        e.stopPropagation();
        setMuted((m) => !m);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, compact, onFullscreen, onNext, onPrevious, onToggleFavorite, adjustVolume]);

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
  const handleSurfaceToggle = () => {
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
    // SRC_NOT_SUPPORTED (4) is also what a missing file, an unplugged drive
    // or a permission error looks like, so only an unsupported extension or
    // a real decode error (3) may be reported as a format problem.
    const isFormatFailure = classifyVideoFailure(videoError?.code, path, name) === "format";
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
            : "VistoGallery couldn't open this video. The file may have been moved, deleted, or be on a disconnected drive — or its codec may not be playable here. Check the source, then try a desktop player."}
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
            Show in Finder
          </button>
        </div>
        {isFormatFailure && !player && (
          <p className="viewer-video-feedback">
            Tip: IINA, VLC, or Elmedia Video Player all play MKV natively.
          </p>
        )}
        {openError && <p className="viewer-video-feedback error">{openError}</p>}
        {failureDetail && <p className="viewer-video-feedback">{failureDetail}</p>}
      </div>
    );
  }

  return (
    <div
      className="video-player-surface"
      onPointerMove={showPlayerActivity}
      onPointerDown={showPlayerActivity}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        handleSurfaceToggle();
      }}
    >
      {preparing && !compact && (
        <div className="viewer-video-preparing" role="status">
          Preparing playback…
        </div>
      )}
      <video
        ref={ref}
        className={`viewer-video${compact ? " viewer-video-compact" : ""}`}
        src={resolvedSrc || undefined}
        width={width ?? undefined}
        height={height ?? undefined}
        style={{
          width: "100%",
          height: "100%",
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          objectPosition: "center",
        }}
        autoPlay={videoAutoPlay || forceAutoPlay}
        loop={videoLoop && !autoAdvance && !compact}
        playsInline
        preload="metadata"
        onClick={handleSurfaceToggle}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onFullscreen?.();
        }}
        onError={(event) => {
          const error = event.currentTarget.error ?? null;
          // MEDIA_ERR_ABORTED fires when src changes mid-load (moving to the
          // next video); it is a navigation race, not a broken file.
          if (error?.code === 1) return;
          setVideoError(error);
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
            onPointerOver={(event) => {
              // pointerover bubbles from every child of the bar, so a move between
              // its buttons is not a re-entry.
              if (event.currentTarget.contains(event.relatedTarget as Node)) return;
              barHoveredRef.current = true;
              if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
              setControlsVisible(true);
            }}
            onPointerOut={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node)) return;
              barHoveredRef.current = false;
              scheduleControlsHide();
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
            <span className="video-time">
              {formatDuration(duration > 0 ? Math.min(time, duration) : time)}
            </span>
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
            {path && (
              <button
                type="button"
                onClick={() => void openExternally()}
                aria-label="Open in default app"
                title="Open in default app"
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
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
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
            <div className="media-anchor" ref={helpRef}>
              <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={helpOpen}
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts"
                className="media-keys-button"
                onClick={() => setHelpOpen((value) => !value)}
              >
                <InfoIcon size={14} />
                <span className="media-keys-label">Keys</span>
              </button>
              {helpOpen && (
                <div
                  className="media-popover media-shortcuts"
                  role="dialog"
                  aria-label="Keyboard shortcuts"
                >
                  {PLAYER_SHORTCUTS.map((hint) => (
                    <React.Fragment key={hint.label}>
                      <span className="media-shortcut-keys">
                        {hint.keys.map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                      </span>
                      <span className="media-shortcut-label">{hint.label}</span>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
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
