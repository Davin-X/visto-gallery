import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enterPictureInPicture,
  exitPictureInPicture,
  isPictureInPicture,
  observePictureInPicture,
  supportsPictureInPicture,
  togglePictureInPicture,
} from "./pictureInPicture";

const pictureInPictureDescriptors = [
  [
    "pictureInPictureEnabled",
    Object.getOwnPropertyDescriptor(document, "pictureInPictureEnabled"),
  ],
  [
    "pictureInPictureElement",
    Object.getOwnPropertyDescriptor(document, "pictureInPictureElement"),
  ],
  [
    "exitPictureInPicture",
    Object.getOwnPropertyDescriptor(document, "exitPictureInPicture"),
  ],
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, descriptor] of pictureInPictureDescriptors) {
    if (descriptor) Object.defineProperty(document, key, descriptor);
    else Reflect.deleteProperty(document, key);
  }
});

describe("picture-in-picture helpers", () => {
  it("uses WebKit presentation mode when available", async () => {
    const video = document.createElement("video") as HTMLVideoElement & {
      webkitPresentationMode?: "inline" | "picture-in-picture";
      webkitSetPresentationMode?: (
        mode: "inline" | "picture-in-picture",
      ) => void;
      webkitSupportsPresentationMode?: (mode: string) => boolean;
    };
    video.webkitPresentationMode = "inline";
    video.webkitSupportsPresentationMode = vi.fn(() => true);
    video.webkitSetPresentationMode = vi.fn((mode) => {
      video.webkitPresentationMode = mode;
    });

    expect(supportsPictureInPicture(video)).toBe(true);
    expect(isPictureInPicture(video)).toBe(false);
    await enterPictureInPicture(video);
    expect(video.webkitSetPresentationMode).toHaveBeenCalledWith(
      "picture-in-picture",
    );
    expect(isPictureInPicture(video)).toBe(true);
    await enterPictureInPicture(video);
    expect(video.webkitSetPresentationMode).toHaveBeenCalledOnce();
    await exitPictureInPicture(video);
    expect(video.webkitSetPresentationMode).toHaveBeenLastCalledWith("inline");
  });

  it("uses the standard document PiP API", async () => {
    const video = document.createElement("video");
    const pipWindow = {} as PictureInPictureWindow;
    const request = vi.fn().mockResolvedValue(pipWindow);
    Object.defineProperty(video, "requestPictureInPicture", {
      configurable: true,
      value: request,
    });
    Object.defineProperty(document, "pictureInPictureEnabled", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(document, "pictureInPictureElement", {
      configurable: true,
      writable: true,
      value: null,
    });
    const exit = vi.fn().mockImplementation(async () => {
      Object.defineProperty(document, "pictureInPictureElement", {
        configurable: true,
        writable: true,
        value: null,
      });
    });
    Object.defineProperty(document, "exitPictureInPicture", {
      configurable: true,
      value: exit,
    });

    expect(supportsPictureInPicture(video)).toBe(true);
    await togglePictureInPicture(video);
    expect(request).toHaveBeenCalledOnce();
    Object.defineProperty(document, "pictureInPictureElement", {
      configurable: true,
      writable: true,
      value: video,
    });
    expect(isPictureInPicture(video)).toBe(true);
    await togglePictureInPicture(video);
    expect(exit).toHaveBeenCalledOnce();
  });

  it("reports unsupported video PiP rather than silently doing nothing", async () => {
    const video = document.createElement("video");
    Object.defineProperty(document, "pictureInPictureEnabled", {
      configurable: true,
      value: false,
    });

    expect(supportsPictureInPicture(video)).toBe(false);
    await expect(togglePictureInPicture(video)).rejects.toThrow(
      "Picture in Picture is not supported",
    );
  });

  it("restores the inline player from the native PiP exit event", () => {
    const video = document.createElement("video") as HTMLVideoElement & {
      webkitPresentationMode?: "inline" | "picture-in-picture";
    };
    video.webkitPresentationMode = "picture-in-picture";
    const onChange = vi.fn();
    const unobserve = observePictureInPicture(video, onChange);

    expect(onChange).toHaveBeenLastCalledWith(true);
    video.dispatchEvent(new Event("leavepictureinpicture"));

    expect(onChange).toHaveBeenLastCalledWith(false);
    unobserve();
  });

  it("follows WebKit presentation mode changes in both directions", () => {
    const video = document.createElement("video") as HTMLVideoElement & {
      webkitPresentationMode?: "inline" | "picture-in-picture";
    };
    video.webkitPresentationMode = "inline";
    const onChange = vi.fn();
    const unobserve = observePictureInPicture(video, onChange);

    video.webkitPresentationMode = "picture-in-picture";
    video.dispatchEvent(new Event("webkitpresentationmodechanged"));
    video.webkitPresentationMode = "inline";
    video.dispatchEvent(new Event("webkitpresentationmodechanged"));

    expect(onChange.mock.calls.map(([active]) => active)).toEqual([
      false,
      true,
      false,
    ]);
    unobserve();
  });
});
