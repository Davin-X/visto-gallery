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
  const library = useLibraryStore();
  const { setMinRating, setColorLabelFilter, setActiveAlbum, setQuery } = library;

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
    // Filter items by camera using query (the library search includes camera)
    setQuery(camera);
    setMinRating(null);
    setColorLabelFilter(null);
    props.onBack();
  };

  const filterByLens = (lens: string) => {
    setActiveAlbum(null);
    setQuery("");
    setQuery(lens);
    setMinRating(null);
    setColorLabelFilter(null);
    props.onBack();
  };

  return (
    <div className="feature-page camera-lens-page">
      <div className="page-header">
        <button
          type="button"
          className="quiet-button icon-only"
          onClick={props.onBack}
          title="Back to library"
          aria-label="Back"
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
                <span className="equipment-icon">📷</span>
                <span className="equipment-name">{group.camera}</span>
                <span className="equipment-count">{group.count}</span>
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
                <span className="equipment-icon">🔍</span>
                <span className="equipment-name">{group.lens}</span>
                <span className="equipment-count">{group.count}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {cameraGroups.length === 0 && lensGroups.length === 0 && (
        <div className="empty-state">
          <span>📷</span>
          <b>No camera/lens data</b>
          <p>EXIF camera and lens information isn’t available for any items in this view.</p>
        </div>
      )}
    </div>
  );
}

export default CameraLensBrowserScreen;
