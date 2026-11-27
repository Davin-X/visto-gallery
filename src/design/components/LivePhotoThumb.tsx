import React, { useState } from "react";
import { CachedThumbnail, type CachedThumbnailSize } from "./CachedThumbnail";

interface LivePhotoThumbProps {
  itemId: string;
  name: string;
  size: CachedThumbnailSize;
  style?: React.CSSProperties;
  fallbackSrc?: string;
  motionSrc?: string;
}

/**
 * Shows a cached still for a Live Photo and plays its paired motion clip while
 * hovered. When there is no paired clip it behaves exactly like CachedThumbnail.
 */
export function LivePhotoThumb({
  itemId,
  name,
  size,
  style,
  fallbackSrc,
  motionSrc,
}: LivePhotoThumbProps) {
  const [hovered, setHovered] = useState(false);

  if (!motionSrc) {
    return (
      <CachedThumbnail
        itemId={itemId}
        name={name}
        size={size}
        style={style}
        fallbackSrc={fallbackSrc}
      />
    );
  }

  return (
    <span
      style={{ display: "block", width: "100%", height: "100%" }}
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      {hovered ? (
        <video src={motionSrc} muted playsInline autoPlay loop />
      ) : (
        <CachedThumbnail
          itemId={itemId}
          name={name}
          size={size}
          style={style}
          fallbackSrc={fallbackSrc}
        />
      )}
    </span>
  );
}

export default LivePhotoThumb;
