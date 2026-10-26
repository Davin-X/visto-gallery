import React from "react";
import VideoThumb from "./VideoThumb";
import { useDraftTransforms, draftTransformStyle } from "../../engine/stores/useEditStore";

function draftImageStyle(transforms: Map<string, any> | undefined, itemId: string) {
  const transform = draftTransformStyle(transforms?.get(itemId));
  return transform ? { transform } : undefined;
}

function albumStackPose(count: number, index: number) {
  const poses =
    count === 1
      ? [{ x: -2, y: 0, r: -3, hx: -3, hy: -1, hr: -4 }]
      : count === 2
        ? [
            { x: -9, y: 5, r: -8, hx: -14, hy: 7, hr: -11 },
            { x: 8, y: -2, r: 7, hx: 13, hy: -4, hr: 10 },
          ]
        : [
            { x: -16, y: 8, r: -11, hx: -24, hy: 12, hr: -15 },
            { x: 0, y: -4, r: -1, hx: 0, hy: -7, hr: -2 },
            { x: 16, y: 7, r: 10, hx: 24, hy: 11, hr: 14 },
          ];
  return poses[index] || poses[0];
}

function AlbumPhotoStack({ photos, assetUrl, albumItems = [] }: { photos: any[]; assetUrl: (path: string) => string; albumItems?: any[] }) {
  const draftTransforms = useDraftTransforms();
  return (
    <span className="album-stack">
      {photos.map((item: any, photoIndex: number) => {
        const pose = albumStackPose(photos.length, photoIndex);
        return (
          <span
            key={item.id}
            className="album-stack-photo"
            style={{
              "--x": `${pose.x}%`,
              "--y": `${pose.y}%`,
              "--r": `${pose.r}deg`,
              "--hx": `${pose.hx}%`,
              "--hy": `${pose.hy}%`,
              "--hr": `${pose.hr}deg`,
              zIndex: photoIndex === 1 ? 3 : photoIndex === 2 ? 2 : 1,
            } as React.CSSProperties}
          >
            {albumItems[photoIndex]?.kind === "video" ? (
              <VideoThumb src={assetUrl(item.path)} name={item.name} />
            ) : (
              <img src={assetUrl(item.path)} alt="" loading="lazy" style={draftImageStyle(draftTransforms, item.id)} />
            )}
          </span>
        );
      })}
    </span>
  );
}


export { AlbumPhotoStack };
export default AlbumPhotoStack;
