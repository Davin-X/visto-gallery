import { useEffect, type RefObject } from "react";
import { requestVideoPlay } from "../../engine/stores/usePlaybackStore";
import { getOrLoadThumbnailUrl } from "./CachedThumbnail";

export function useVideoMediaSession(
  videoRef: RefObject<HTMLVideoElement | null>,
  itemId: string,
  name: string | undefined,
  src: string,
  onSeek: (time: number) => void,
) {
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    let current = true;
    const title = name || "Video";
    const setMetadata = (artwork?: MediaImage[]) => {
      session.metadata = new MediaMetadata({
        title,
        artist: "VistoGallery",
        ...(artwork ? { artwork } : {}),
      });
    };
    const updatePositionState = () => {
      if (typeof session.setPositionState !== "function") return;
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      try {
        session.setPositionState({
          duration,
          playbackRate: video.playbackRate || 1,
          position: Math.min(Math.max(video.currentTime, 0), duration),
        });
      } catch {
        // The media can transition between valid and unavailable timing data.
      }
    };
    setMetadata();
    updatePositionState();
    void getOrLoadThumbnailUrl(itemId)
      .then((src) => {
        if (current) setMetadata([{ src, sizes: "128x128", type: "image/jpeg" }]);
      })
      .catch(() => {});
    const seekBy = (delta: number) => {
      const next = Math.min(Math.max(video.currentTime + delta, 0), video.duration || 0);
      video.currentTime = next;
      onSeek(next);
      updatePositionState();
    };
    const seekTo = (time: number) => {
      const duration = Number.isFinite(video.duration) ? video.duration : time;
      const next = Math.min(Math.max(time, 0), duration);
      video.currentTime = next;
      onSeek(next);
      updatePositionState();
    };
    session.setActionHandler("play", () => requestVideoPlay(video));
    session.setActionHandler("pause", () => video.pause());
    session.setActionHandler("seekbackward", (details) => seekBy(-(details?.seekOffset || 10)));
    session.setActionHandler("seekforward", (details) => seekBy(details?.seekOffset || 10));
    session.setActionHandler("seekto", (details) => {
      if (typeof details.seekTime === "number") seekTo(details.seekTime);
    });
    const onPlay = () => {
      session.playbackState = "playing";
      updatePositionState();
    };
    const onPause = () => {
      session.playbackState = "paused";
      updatePositionState();
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", updatePositionState);
    video.addEventListener("durationchange", updatePositionState);
    video.addEventListener("loadedmetadata", updatePositionState);
    video.addEventListener("seeked", updatePositionState);
    return () => {
      current = false;
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", updatePositionState);
      video.removeEventListener("durationchange", updatePositionState);
      video.removeEventListener("loadedmetadata", updatePositionState);
      video.removeEventListener("seeked", updatePositionState);
      session.setActionHandler("play", null);
      session.setActionHandler("pause", null);
      session.setActionHandler("seekbackward", null);
      session.setActionHandler("seekforward", null);
      session.setActionHandler("seekto", null);
      try {
        session.setPositionState();
      } catch {
        // Ignore unsupported or already-cleared media-session state.
      }
    };
  }, [videoRef, itemId, src, name, onSeek]);
}
