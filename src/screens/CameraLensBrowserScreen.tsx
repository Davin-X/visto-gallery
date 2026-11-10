import React, { useMemo } from "react";
import { CameraIcon, LensIcon, ArrowLeftIcon } from "../design/components/icons";
import { useLibraryStore } from "../engine/stores/useLibraryStore";
import type { MediaItem } from "../engine/types/media";

interface CameraLensBrowserScreenProps {
  items: MediaItem[];
  assetUrl: (path: string) => string;
  onBack: () => void;
  onOpenViewer: (id?: string) => void;
}

interface CameraGroup {
  camera: string;
  count: number;
  items: MediaItem[];
}

interface LensGroup {
  lens: string;
  count: number;
  items: MediaItem[];
}

function CameraLensBrowserScreen(props: CameraLensBrowserScreenProps) {
  // Actions only: subscribe individually so state changes elsewhere don't
  // re-render this screen.
  const setMinRating = useLibraryStore((s) => s.setMinRating);
  const setColorLabelFilter = useLibraryStore((s) => s.setColorLabelFilter);
  const setActiveAlbum = useLibraryStore((s) => s.setActiveAlbum);
  const setQuery = useLibraryStore((s) => s.setQuery);
  const setCameraFilter = useLibraryStore((s) => s.setCameraFilter);
  const setLensFilter = useLibraryStore((s) => s.setLensFilter);

  const cameraGroups = useMemo<CameraGroup[]>(() => {
    const byCamera = new Map<string, MediaItem[]>();
    for (const item of props.items) {
      if (!item.camera) continue;
      const arr = byCamera.get(item.camera) ?? [];
      arr.push(item);
      byCamera.set(item.camera, arr);
    }
    return [...byCamera.entries()]
      .map(([camera, items]) => ({ camera, count: items.length, items }))
      .sort((a, b) => b.count - a.count);
  }, [props.items]);

  const lensGroups = useMemo<LensGroup[]>(() => {
    const byLens = new Map<string, MediaItem[]>();
    for (const item of props.items) {
      if (!item.lens) continue;
      const arr = byLens.get(item.lens) ?? [];
      arr.push(item);
      byLens.set(item.lens, arr);
    }
    return [...byLens.entries()]
      .map(([lens, items]) => ({ lens, count: items.length, items }))
      .sort((a, b) => b.count - a.count);
  }, [props.items]);

  const filterByCamera = (camera: string) => {
    setActiveAlbum(null);
    setQuery("");
    setMinRating(null);
    setColorLabelFilter(null);
    setLensFilter(null);
    setCameraFilter(camera);
    props.onBack();
  };

  const filterByLens = (lens: string) => {
    setActiveAlbum(null);
    setQuery("");
    setMinRating(null);
    setColorLabelFilter(null);
    setCameraFilter(null);
    setLensFilter(lens);
    props.onBack();
  };

  return (
    <div className="feature-page camera-lens-page">
      <div className="page-heading">
        <button
          type="button"
          className="icon-button camera-lens-back"
          onClick={props.onBack}
          title="Back to library"
          aria-label="Back to library"
        >
          <ArrowLeftIcon size={16} />
        </button>
        <div>
          <p className="eyebrow">EQUIPMENT</p>
          <h1>Camera & Lens</h1>
          <p className="page-subtitle">
            {props.items.length.toLocaleString()} items with EXIF data
          </p>
        </div>
      </div>

      {cameraGroups.length > 0 && (
        <section className="equipment-section">
          <div className="section-heading">
            <CameraIcon size={14} />
            <span>By Camera</span>
          </div>
          <div className="equipment-grid">
            {cameraGroups.map((group) => (
              <button
                key={group.camera}
                type="button"
                className="equipment-card"
                onClick={() => filterByCamera(group.camera)}
              >
                <span className="equipment-icon">
                  <CameraIcon size={20} />
                </span>
                <span className="equipment-name" title={group.camera}>
                  {group.camera}
                </span>
                <span className="equipment-count">
                  {group.count.toLocaleString()} {group.count === 1 ? "item" : "items"}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {lensGroups.length > 0 && (
        <section className="equipment-section">
          <div className="section-heading">
            <LensIcon size={14} />
            <span>By Lens</span>
          </div>
          <div className="equipment-grid">
            {lensGroups.map((group) => (
              <button
                key={group.lens}
                type="button"
                className="equipment-card"
                onClick={() => filterByLens(group.lens)}
              >
                <span className="equipment-icon">
                  <LensIcon size={20} />
                </span>
                <span className="equipment-name" title={group.lens}>
                  {group.lens}
                </span>
                <span className="equipment-count">
                  {group.count.toLocaleString()} {group.count === 1 ? "item" : "items"}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {cameraGroups.length === 0 && lensGroups.length === 0 && (
        <div className="empty-state">
          <span className="empty-state-icon" aria-hidden="true">
            <CameraIcon size={28} />
          </span>
          <b>No camera/lens data</b>
          <p>EXIF camera and lens information isn’t available for any items in this view.</p>
        </div>
      )}
    </div>
  );
}

export default CameraLensBrowserScreen;
