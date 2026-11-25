import type { EditValues, MediaItem } from "../../engine/types/media";

export interface EditScreenProps {
  item: MediaItem | null;
  values: EditValues | null;
  crop: {
    enabled: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    aspectRatio?: number | "free";
  };
  history: EditValues[];
  historyIndex: number;
  assetUrl: (path: string) => string;
  canUndo: boolean;
  canRedo: boolean;
  onSetValue: (key: keyof EditValues, value: EditValues[keyof EditValues]) => void;
  onSetValues: (values: EditValues) => void;
  onReset: () => void;
  onAuto: () => void;
  onRotate: (deg: number) => void;
  onFlip: () => void;
  onSetCrop: (
    crop: Partial<{
      enabled: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
      aspectRatio?: number | "free";
    }>,
  ) => void;
  onResetCrop: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void | Promise<void>;
  onSaveDraft: () => Promise<void>;
  onBack: () => void;
  onExport: (inPlace?: boolean) => void | Promise<void>;
  onClearDraft: (id: string) => void;
  onNotice: (text: string) => void;
  onOpenEdit: (item: MediaItem) => void | Promise<void>;
  onReloadLibrary?: () => void | Promise<void>;
}
