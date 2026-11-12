import React from "react";
import { CachedThumbnail } from "./CachedThumbnail";
import { useDraftTransforms } from "../../engine/stores/useEditStore";
import { draftImageStyle } from "../../engine/utils/draftImage";

function albumStackPose(count: number, index: number) {
  const poses =
    count === 1
      ? [{ x: -2, y: 0, r: -3, hx: -3, hy: -3, hr: -4 }]
      : count === 2
        ? [
            { x: -9, y: 5, r: -8, hx: -11, hy: 1, hr: -11 },
            { x: 8, y: -2, r: 7, hx: 10, hy: -8, hr: 10 },
          ]
        : [
            // Hover lifts the prints and turns them a few degrees further
            // rather than dragging them sideways: the old offsets slid the
            // outer two past the cover edge, where the crop cut them off.
            { x: -16, y: 8, r: -11, hx: -18, hy: 1, hr: -15 },
            { x: 0, y: -4, r: -1, hx: 0, hy: -10, hr: -2 },
            { x: 16, y: 7, r: 10, hx: 18, hy: 0, hr: 14 },
          ];
  return poses[index] || poses[0];
}

function AlbumPhotoStack({
  photos,
  albumItems = [],
}: {
  photos: any[];
  albumItems?: any[];
}) {
  const draftTransforms = useDraftTransforms();
  return (
    <span className="album-stack">
      {photos.map((item: any, photoIndex: number) => {
        const pose = albumStackPose(photos.length, photoIndex);
        return (
          <span
            key={item.id}
            className="album-stack-photo"
            style={
              {
                "--x": `${pose.x}%`,
                "--y": `${pose.y}%`,
                "--r": `${pose.r}deg`,
                "--hx": `${pose.hx}%`,
                "--hy": `${pose.hy}%`,
                "--hr": `${pose.hr}deg`,
                zIndex: photoIndex === 1 ? 3 : photoIndex === 2 ? 2 : 1,
              } as React.CSSProperties
            }
          >
            {albumItems[photoIndex]?.kind === "video" ? (
              // Every other surface renders videos from the backend's cached
              // poster; a live <video> here re-composited on the hover fan and
              // flashed black in WebKit. Same source of frame everywhere.
              <CachedThumbnail itemId={item.id} name={item.name} size={128} />
            ) : (
              // Covers are small: a cached 256px thumbnail instead of the
              // original, with a quiet placeholder when the file is missing.
              <CachedThumbnail
                itemId={item.id}
                name=""
                size={256}
                style={draftImageStyle(draftTransforms, item.id)}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

export { AlbumPhotoStack };
export default AlbumPhotoStack;
