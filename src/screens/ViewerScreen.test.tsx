import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ViewerScreen from "./ViewerScreen";
import { makeMediaItem } from "../test/fixtures";

vi.mock("../design/components/CachedThumbnail", () => ({
  CachedThumbnail: () => <span />,
}));
vi.mock("../engine/stores/useEditStore", () => ({
  useDraftTransforms: () => new Map(),
  draftTransformStyle: () => undefined,
}));

const openSlideshow = vi.hoisted(() => vi.fn());

vi.mock("../engine/stores/useSlideshowStore", () => ({
  useSlideshowStore: {
    getState: () => ({ open: openSlideshow }),
  },
}));

function renderPhotoViewer(
  selectedKind: "photo" | "video" = "photo",
  photoCount = 1,
  onToggleFitMode = vi.fn(),
  fitMode: "fit" | "actual" | "fill" = "fit",
) {
  const photo = makeMediaItem({
    id: "photo",
    name: "photo.jpg",
    kind: "photo",
    width: 640,
    height: 360,
  });
  const secondPhoto = makeMediaItem({
    id: "photo-2",
    name: "photo-2.jpg",
    kind: "photo",
    width: 640,
    height: 360,
  });
  const video = makeMediaItem({
    id: "video",
    name: "video.mp4",
    path: "/video.mp4",
    extension: "mp4",
    kind: "video",
  });
  return render(
    <ViewerScreen
      active
      items={[photo, ...(photoCount > 1 ? [secondPhoto] : []), video]}
      selected={selectedKind === "photo" ? photo : video}
      zoom={100}
      fitMode={fitMode}
      rotation={0}
      flipX={false}
      onNavigate={vi.fn()}
      onSetPhoto={vi.fn()}
      onSetZoom={vi.fn()}
      onZoomIn={vi.fn()}
      onZoomOut={vi.fn()}
      onResetZoom={vi.fn()}
      onToggleFitMode={onToggleFitMode}
      onRotate={vi.fn()}
      onToggleFlip={vi.fn()}
      onResetTransform={vi.fn()}
      onToggleFullscreen={vi.fn()}
      onClose={vi.fn()}
      onToggleFavorite={vi.fn()}
      onToggleHidden={vi.fn()}
      onOpenEdit={vi.fn()}
      onContextMenu={vi.fn()}
      assetUrl={(path) => path}
    />,
  );
}

describe("photo viewer", () => {
  it("uses the selected fit mode and exposes its control", () => {
    const onToggleFitMode = vi.fn();
    const { container } = renderPhotoViewer("photo", 1, onToggleFitMode);
    const image = container.querySelector(".viewer-stage img");

    expect(image).toHaveStyle({ objectFit: "contain" });
    expect(image).toHaveStyle({ aspectRatio: "auto 640 / 360" });
    fireEvent.load(image!);
    expect(image).toHaveClass("is-loaded");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Image scaling: fit. Click to change",
      }),
    );
    expect(onToggleFitMode).toHaveBeenCalledOnce();
  });

  it("fills the viewing canvas by cropping without stretching the image", () => {
    const { container } = renderPhotoViewer("photo", 1, vi.fn(), "fill");
    const image = container.querySelector(".viewer-stage img");

    expect(image).toHaveStyle({
      objectFit: "cover",
      width: "100%",
      height: "100%",
      aspectRatio: "auto 640 / 360",
    });
  });

  it("shows actual-size photos without constraining their intrinsic dimensions", () => {
    const { container } = renderPhotoViewer("photo", 1, vi.fn(), "actual");
    const image = container.querySelector(".viewer-stage img");

    expect(image).toHaveStyle({
      objectFit: "contain",
      maxWidth: "none",
      maxHeight: "none",
      aspectRatio: "auto 640 / 360",
    });
  });

  it("starts a slideshow with the photo-only list and current image", () => {
    renderPhotoViewer("photo", 2);

    fireEvent.click(screen.getByRole("button", { name: "Start photo slideshow" }));

    expect(openSlideshow).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "photo" }), expect.objectContaining({ id: "photo-2" })],
      "photo",
    );
  });

  it("keeps video items out of the photo filmstrip", () => {
    const { container } = renderPhotoViewer();

    expect(container.querySelector(".filmstrip button[title='photo.jpg']")).toBeTruthy();
    expect(container.querySelector(".filmstrip button[title='video.mp4']")).toBeNull();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    expect(container.querySelector(".viewer-stage video")).toBeNull();
  });

  it("flashes a boundary cue when navigation wraps past the ends", () => {
    const onNavigate = vi.fn();
    const photo = makeMediaItem({
      id: "photo",
      name: "photo.jpg",
      kind: "photo",
      width: 640,
      height: 360,
    });
    const secondPhoto = makeMediaItem({
      id: "photo-2",
      name: "photo-2.jpg",
      kind: "photo",
      width: 640,
      height: 360,
    });
    const video = makeMediaItem({
      id: "video",
      name: "video.mp4",
      path: "/video.mp4",
      extension: "mp4",
      kind: "video",
    });

    const baseProps = {
      active: true,
      zoom: 100,
      fitMode: "fit" as const,
      rotation: 0,
      flipX: false,
      onNavigate,
      onSetPhoto: vi.fn(),
      onSetZoom: vi.fn(),
      onZoomIn: vi.fn(),
      onZoomOut: vi.fn(),
      onResetZoom: vi.fn(),
      onToggleFitMode: vi.fn(),
      onRotate: vi.fn(),
      onToggleFlip: vi.fn(),
      onResetTransform: vi.fn(),
      onToggleFullscreen: vi.fn(),
      onClose: vi.fn(),
      onToggleFavorite: vi.fn(),
      onToggleHidden: vi.fn(),
      onOpenEdit: vi.fn(),
      onContextMenu: vi.fn(),
      assetUrl: (path: string) => path,
    };

    const first = render(
      <ViewerScreen {...baseProps} items={[photo, secondPhoto, video]} selected={photo} />,
    );
    fireEvent.click(first.container.querySelector('button[aria-label="Previous"]')!);
    expect(onNavigate).toHaveBeenCalledWith(-1);
    expect(first.container.querySelector(".viewer-boundary-cue")).toHaveTextContent(
      /Beginning of view/,
    );
    first.unmount();

    const last = render(
      <ViewerScreen {...baseProps} items={[photo, secondPhoto, video]} selected={secondPhoto} />,
    );
    fireEvent.click(last.container.querySelector('button[aria-label="Next"]')!);
    expect(onNavigate).toHaveBeenLastCalledWith(1);
    expect(last.container.querySelector(".viewer-boundary-cue")).toHaveTextContent(/End of view/);
    last.unmount();
  });

  it("does not render a video in the photo viewing surface, and says so", () => {
    renderPhotoViewer("video");

    expect(screen.getByText(/Videos don’t open in the viewer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to library" })).toBeInTheDocument();
    expect(document.querySelector(".viewer-stage video")).toBeNull();
  });
});
