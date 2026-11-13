import type { ReactNode } from "react";
import type { AppSettings } from "../../../engine/types/settings";

/** Persist one setting; the value type follows the key. */
export type SettingsChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

export interface RadioOption {
  id: string;
  label: string;
}

export type RenderRadioGroup = (
  name: string,
  value: string,
  options: readonly RadioOption[],
  onChange: (v: string) => void,
) => ReactNode;

export type RenderAccentPicker = (value: string, onChange: (v: string) => void) => ReactNode;
