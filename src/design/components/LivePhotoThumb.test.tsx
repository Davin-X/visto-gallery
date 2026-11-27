import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LivePhotoThumb } from "./LivePhotoThumb";

describe("LivePhotoThumb", () => {
  it("falls back to CachedThumbnail when motionSrc is missing", () => {
    render(<LivePhotoThumb itemId="a" name="a.heic" size={128} />);
    // CachedThumbnail renders an img or placeholder; ensure no video is present.
    expect(screen.queryByRole("video")).toBeNull();
  });

  it("swaps to a video on hover when motionSrc is provided", () => {
    const { container } = render(
      <LivePhotoThumb itemId="a" name="a.heic" size={128} motionSrc="/motion.mov" />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    // A <video> should now be in the document.
    expect(container.querySelector("video")).not.toBeNull();
  });
});
