import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ViewerScreen from "./ViewerScreen";
import { tauri } from "../engine/commands/tauri";
import { makeMediaItem } from "../test/fixtures";

const getCachedThumbnailUrlMock = vi.hoisted(() => vi.fn<() => string | null>(() => null));

vi.mock("../design/components/CachedThumbnail", () => ({
  CachedThumbnail: () => <span />,
  getCachedThumbnailUrl: getCachedThumbnailUrlMock,
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
  const onNavigate = vi.fn();
  const onToggleFavorite = vi.fn();
  const onToggleFullscreen = vi.fn();
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
  const onSetZoom = vi.fn();
  const onResetZoom = vi.fn();
  const result = render(
    <ViewerScreen
      active
      items={[photo, ...(photoCount > 1 ? [secondPhoto] : []), video]}
      selected={selectedKind === "photo" ? photo : video}
      zoom={100}
      fitMode={fitMode}
      rotation={0}
      flipX={false}
      onNavigate={onNavigate}
      onSetPhoto={vi.fn()}
      onSetZoom={onSetZoom}
      onZoomIn={vi.fn()}
      onZoomOut={vi.fn()}
      onResetZoom={onResetZoom}
      onToggleFitMode={onToggleFitMode}
      onRotate={vi.fn()}
      onToggleFlip={vi.fn()}
      onResetTransform={vi.fn()}
      onToggleFullscreen={onToggleFullscreen}
      onClose={vi.fn()}
      onToggleFavorite={onToggleFavorite}
      onToggleHidden={vi.fn()}
      onOpenEdit={vi.fn()}
      onContextMenu={vi.fn()}
      assetUrl={(path) => path}
    />,
  );
  return { ...result, onNavigate, onToggleFavorite, onToggleFullscreen, onSetZoom, onResetZoom };
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

  it("does not render a video in the photo viewing surface, and says so", () => {
    renderPhotoViewer("video");

    expect(screen.getByText(/Videos don’t open in the Viewer/)).toBeInTheDocument();
    expect(screen.getByText(/play button on its tile/)).toBeInTheDocument();
    expect(document.querySelector(".viewer-stage video")).toBeNull();
  });
});

describe("photo viewer keyboard shortcuts", () => {
  it("advances to the next photo with Space and K, and back with J", () => {
    const { onNavigate } = renderPhotoViewer("photo", 2);

    fireEvent.keyDown(window, { key: " " });
    expect(onNavigate).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(window, { key: "k" });
    expect(onNavigate).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(window, { key: "K" });
    expect(onNavigate).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(window, { key: "j" });
    expect(onNavigate).toHaveBeenLastCalledWith(-1);

    fireEvent.keyDown(window, { key: "J" });
    expect(onNavigate).toHaveBeenLastCalledWith(-1);
    expect(onNavigate).toHaveBeenCalledTimes(5);
  });

  it("favorites the current photo with L and toggles full screen with F", () => {
    const { onToggleFavorite, onToggleFullscreen } = renderPhotoViewer("photo", 1);

    fireEvent.keyDown(window, { key: "l" });
    expect(onToggleFavorite).toHaveBeenLastCalledWith("photo");
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "F" });
    expect(onToggleFullscreen).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "f" });
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onToggleFullscreen).toHaveBeenCalledTimes(2);
  });

  it("leaves ⌘/Ctrl/⌥ combinations alone so they are not swallowed as plain keys", () => {
    const { onNavigate, onToggleFavorite } = renderPhotoViewer("photo", 2);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    fireEvent.keyDown(window, { key: "l", altKey: true });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(onToggleFavorite).not.toHaveBeenCalled();
  });

  it("ignores shortcuts when focus is inside an editable field", () => {
    const { onNavigate, onToggleFavorite } = renderPhotoViewer("photo", 2);
    const input = document.createElement("input");
    document.body.appendChild(input);

    fireEvent.keyDown(input, { key: " " });
    fireEvent.keyDown(input, { key: "j" });
    fireEvent.keyDown(input, { key: "l" });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(onToggleFavorite).not.toHaveBeenCalled();
    input.remove();
  });

  it("jumps to Retina-aware 1:1 pixels with 1 or the 1:1 button and resets with 0", () => {
    const { container, onSetZoom, onResetZoom } = renderPhotoViewer("photo", 1);
    const stage = container.querySelector(".viewer-stage") as HTMLDivElement;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      width: 320,
      height: 180,
      top: 0,
      left: 0,
      right: 320,
      bottom: 180,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.stubGlobal("devicePixelRatio", 2);

    // 640x360 image on 320x180 stage at 2x Retina DPR -> 1:1 is 100%, at 1x DPR -> 200%.
    fireEvent.click(screen.getByRole("button", { name: "Actual pixels (1:1)" }));
    expect(onResetZoom).toHaveBeenCalledOnce();

    vi.stubGlobal("devicePixelRatio", 1);
    fireEvent.keyDown(window, { key: "1" });
    expect(onSetZoom).toHaveBeenLastCalledWith(200);

    fireEvent.keyDown(window, { key: "0" });
    expect(onResetZoom).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it("requests full-resolution RAW render when 1:1 is enabled even below 150% zoom", async () => {
    const raw = makeMediaItem({
      id: "raw-1",
      name: "shot.dng",
      path: "/tmp/shot.dng",
      kind: "raw",
      width: 4000,
      height: 3000,
    });
    const getDisplayPreview = vi
      .spyOn(tauri.library, "getDisplayPreview")
      .mockResolvedValue({ path: "/tmp/preview.jpg", dataUrl: null, full: false } as never);
    const onSetZoom = vi.fn();
    const { container } = render(
      <ViewerScreen
        active
        items={[raw]}
        selected={raw}
        zoom={100}
        fitMode="fit"
        rotation={0}
        flipX={false}
        onNavigate={vi.fn()}
        onSetPhoto={vi.fn()}
        onSetZoom={onSetZoom}
        onZoomIn={vi.fn()}
        onZoomOut={vi.fn()}
        onResetZoom={vi.fn()}
        onToggleFitMode={vi.fn()}
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
    await waitFor(() => expect(getDisplayPreview).toHaveBeenCalledWith("raw-1", false));

    const stage = container.querySelector(".viewer-stage") as HTMLDivElement;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      width: 1600,
      height: 1200,
      top: 0,
      left: 0,
      right: 1600,
      bottom: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.stubGlobal("devicePixelRatio", 2);

    fireEvent.click(screen.getByRole("button", { name: "Actual pixels (1:1)" }));
    expect(onSetZoom).toHaveBeenCalledWith(125);
    await waitFor(() => expect(getDisplayPreview).toHaveBeenCalledWith("raw-1", true));

    getDisplayPreview.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows the cached thumbnail backdrop while a photo loads and hides it on load", () => {
    getCachedThumbnailUrlMock.mockReturnValue("data:image/jpeg;base64,Y2FjaGU=");
    const { container } = renderPhotoViewer("photo", 1);

    const backdrop = container.querySelector("img.photo-viewer-backdrop");
    expect(backdrop).not.toBeNull();
    expect(backdrop?.getAttribute("src")).toBe("data:image/jpeg;base64,Y2FjaGU=");

    const mainImage = container.querySelector("img.photo-viewer-image:not(.photo-viewer-backdrop)");
    expect(mainImage).not.toBeNull();
    fireEvent.load(mainImage!);

    expect(container.querySelector("img.photo-viewer-backdrop")).toBeNull();
    getCachedThumbnailUrlMock.mockReturnValue(null);
  });

  it("pins A and compares side-by-side or A/B flip at synchronized zoom with C and \\", () => {
    const first = makeMediaItem({
      id: "photo-a",
      name: "a.jpg",
      path: "/tmp/a.jpg",
      kind: "photo",
      width: 1200,
      height: 800,
    });
    const second = makeMediaItem({
      id: "photo-b",
      name: "b.jpg",
      path: "/tmp/b.jpg",
      kind: "photo",
      width: 1200,
      height: 800,
    });
    const onNavigate = vi.fn();
    const props = {
      active: true,
      items: [first, second],
      zoom: 200,
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

    const { container, rerender } = render(<ViewerScreen {...props} selected={first} />);

    // Pressing C pins photo-a and advances to photo-b.
    fireEvent.keyDown(window, { key: "c" });
    expect(onNavigate).toHaveBeenCalledWith(1);

    rerender(<ViewerScreen {...props} selected={second} />);
    expect(container.querySelector(".viewer-compare-stage")).not.toBeNull();
    expect(screen.getByText("A · a.jpg")).toBeInTheDocument();
    expect(screen.getByText("B · b.jpg")).toBeInTheDocument();
    const images = container.querySelectorAll(".viewer-compare-pane img.photo-viewer-image");
    expect(images).toHaveLength(2);
    expect((images[0] as HTMLElement).style.transform).toContain("scale(2)");
    expect((images[1] as HTMLElement).style.transform).toContain("scale(2)");

    // Pressing \ enters A/B flip mode and alternates A <-> B.
    fireEvent.keyDown(window, { key: "\\" });
    expect(container.querySelector(".viewer-compare-stage")).toBeNull();
    expect(screen.getByText("A · a.jpg")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "\\" });
    expect(screen.getByText("B · b.jpg")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show A" }));
    expect(screen.getByText("A · a.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show B" }));
    expect(screen.getByText("B · b.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Split side-by-side" }));
    expect(container.querySelector(".viewer-compare-stage")).not.toBeNull();

    // Pressing C again exits compare mode.
    fireEvent.keyDown(window, { key: "c" });
    expect(screen.queryByText("B · b.jpg")).toBeNull();
  });

  it("routes Favorite and Edit to A when A is shown in flip mode, and sizes A independently", () => {
    const first = makeMediaItem({
      id: "photo-a",
      name: "a.jpg",
      path: "/tmp/a.jpg",
      kind: "photo",
      width: 500,
      height: 400,
    });
    const second = makeMediaItem({
      id: "photo-b",
      name: "b.jpg",
      path: "/tmp/b.jpg",
      kind: "photo",
      width: 2400,
      height: 1600,
    });
    const onToggleFavorite = vi.fn();
    const onOpenEdit = vi.fn();
    const props = {
      active: true,
      items: [first, second],
      zoom: 100,
      fitMode: "actual" as const,
      rotation: 0,
      flipX: false,
      onNavigate: vi.fn(),
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
      onToggleFavorite,
      onToggleHidden: vi.fn(),
      onOpenEdit,
      onContextMenu: vi.fn(),
      assetUrl: (path: string) => path,
    };

    const { container, rerender } = render(<ViewerScreen {...props} selected={first} />);
    fireEvent.keyDown(window, { key: "c" });
    rerender(<ViewerScreen {...props} selected={second} />);

    // In 2-up split, A uses its own 500x400 dimensions, not B's 2400x1600.
    const images = container.querySelectorAll(".viewer-compare-pane img.photo-viewer-image");
    expect((images[0] as HTMLElement).style.aspectRatio).toBe("auto 500 / 400");
    expect((images[1] as HTMLElement).style.aspectRatio).toBe("auto 2400 / 1600");

    // Flip to A and trigger Favorite (L) and Edit -> both act on photo-a.
    fireEvent.keyDown(window, { key: "\\" });
    expect(screen.getByText("A · a.jpg")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "l" });
    expect(onToggleFavorite).toHaveBeenLastCalledWith("photo-a");

    fireEvent.click(screen.getByRole("button", { name: "Edit photo" }));
    expect(onOpenEdit).toHaveBeenLastCalledWith(first);
  });
});
