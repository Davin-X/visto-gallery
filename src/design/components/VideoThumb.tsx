import React, { useRef, useState, useEffect } from "react";
import { CachedThumbnail, type CachedThumbnailSize } from "./CachedThumbnail";
function VideoThumb({ src, name, className }: { src: string; name?: string; className?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "180px" },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video || !nearViewport) return;
    const seek = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      try {
        video.currentTime = Math.min(0.15, duration / 2);
      } catch {
        /* seeking can fail on very short or broken files; the frame stays blank */
      }
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [src, nearViewport]);

  return (
    <video
      ref={ref}
      className={className}
      src={nearViewport ? src : undefined}
      title={name}
      muted
      playsInline
      preload={nearViewport ? "metadata" : "none"}
    />
  );
}

export function VideoPoster({
  itemId,
  name,
  size,
  fallbackSrc,
}: {
  itemId: string;
  name: string;
  size: CachedThumbnailSize;
  fallbackSrc?: string;
}) {
  return (
    <CachedThumbnail
      itemId={itemId}
      name={name}
      size={size}
      failedLabel="Video preview unavailable"
      fallbackElement={fallbackSrc ? <VideoThumb src={fallbackSrc} name={name} /> : undefined}
    />
  );
}

export default VideoThumb;
