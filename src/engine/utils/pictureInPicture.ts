type WebKitPresentationVideo = HTMLVideoElement & {
  webkitPresentationMode?: "inline" | "picture-in-picture";
  webkitSetPresentationMode?: (
    mode: "inline" | "picture-in-picture",
  ) => void;
  webkitSupportsPresentationMode?: (
    mode: "inline" | "picture-in-picture",
  ) => boolean;
};

export function supportsPictureInPicture(video: HTMLVideoElement): boolean {
  const webkitVideo = video as WebKitPresentationVideo;
  return (
    (typeof webkitVideo.webkitSetPresentationMode === "function" &&
      webkitVideo.webkitSupportsPresentationMode?.("picture-in-picture") ===
        true) ||
    (video.ownerDocument.pictureInPictureEnabled === true &&
      typeof video.requestPictureInPicture === "function")
  );
}

export function isPictureInPicture(video: HTMLVideoElement): boolean {
  const webkitVideo = video as WebKitPresentationVideo;
  return (
    webkitVideo.webkitPresentationMode === "picture-in-picture" ||
    video.ownerDocument.pictureInPictureElement === video
  );
}

export function observePictureInPicture(
  video: HTMLVideoElement,
  onChange: (active: boolean) => void,
): () => void {
  const webkitVideo = video as WebKitPresentationVideo;
  const onEnter = () => onChange(true);
  const onLeave = () => onChange(false);
  const onWebKitModeChange = () =>
    onChange(webkitVideo.webkitPresentationMode === "picture-in-picture");

  video.addEventListener("enterpictureinpicture", onEnter);
  video.addEventListener("leavepictureinpicture", onLeave);
  video.addEventListener("webkitpresentationmodechanged", onWebKitModeChange);
  onChange(isPictureInPicture(video));

  return () => {
    video.removeEventListener("enterpictureinpicture", onEnter);
    video.removeEventListener("leavepictureinpicture", onLeave);
    video.removeEventListener(
      "webkitpresentationmodechanged",
      onWebKitModeChange,
    );
  };
}

export async function enterPictureInPicture(
  video: HTMLVideoElement,
): Promise<void> {
  const webkitVideo = video as WebKitPresentationVideo;
  if (isPictureInPicture(video)) return;
  if (
    webkitVideo.webkitSupportsPresentationMode?.("picture-in-picture") &&
    webkitVideo.webkitSetPresentationMode
  ) {
    webkitVideo.webkitSetPresentationMode("picture-in-picture");
    return;
  }
  if (
    video.ownerDocument.pictureInPictureEnabled &&
    typeof video.requestPictureInPicture === "function"
  ) {
    await video.requestPictureInPicture();
    return;
  }
  throw new Error("Picture in Picture is not supported for this video.");
}

export async function exitPictureInPicture(
  video: HTMLVideoElement,
): Promise<void> {
  const webkitVideo = video as WebKitPresentationVideo;
  if (!isPictureInPicture(video)) return;
  if (
    webkitVideo.webkitSupportsPresentationMode?.("picture-in-picture") &&
    webkitVideo.webkitSetPresentationMode
  ) {
    webkitVideo.webkitSetPresentationMode("inline");
    return;
  }
  if (video.ownerDocument.pictureInPictureElement === video) {
    await video.ownerDocument.exitPictureInPicture();
    return;
  }
  throw new Error("Unable to exit Picture in Picture for this video.");
}

export async function togglePictureInPicture(
  video: HTMLVideoElement,
): Promise<void> {
  if (isPictureInPicture(video)) {
    await exitPictureInPicture(video);
  } else {
    await enterPictureInPicture(video);
  }
}
