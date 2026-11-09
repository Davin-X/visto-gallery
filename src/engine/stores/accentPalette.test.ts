/// <reference types="vitest/globals" />
import { ACCENT_PALETTE } from "./useSettingsStore";

// Mirrors the WCAG relative-luminance / contrast math used by `contrastOn` in
// useSettingsStore, so the palette can be checked without a DOM.
const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
};

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// `contrastOn` picks whichever label wins; these are the labels that palette
// values are expected to resolve to, per theme.
const LABEL_ON_LIGHT_ACCENT = "#ffffff";
const LABEL_ON_DARK_ACCENT = "#101418";

describe("accent palette labels", () => {
  it("labels every light accent white", () => {
    for (const accent of ACCENT_PALETTE) {
      const onWhite = contrast(accent.light, LABEL_ON_LIGHT_ACCENT);
      const onBlack = contrast(accent.light, LABEL_ON_DARK_ACCENT);
      expect(onWhite, accent.label).toBeGreaterThanOrEqual(4.5);
      expect(onWhite, accent.label).toBeGreaterThan(onBlack);
    }
  });

  it("labels every dark accent near-black", () => {
    for (const accent of ACCENT_PALETTE) {
      const onBlack = contrast(accent.dark, LABEL_ON_DARK_ACCENT);
      const onWhite = contrast(accent.dark, LABEL_ON_LIGHT_ACCENT);
      expect(onBlack, accent.label).toBeGreaterThanOrEqual(4.5);
      expect(onBlack, accent.label).toBeGreaterThan(onWhite);
    }
  });

  it("keeps accent fills visible on the dark surface", () => {
    for (const accent of ACCENT_PALETTE) {
      expect(contrast(accent.dark, "#161b26"), accent.label).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses distinct ids and hexes", () => {
    expect(new Set(ACCENT_PALETTE.map((a) => a.id)).size).toBe(ACCENT_PALETTE.length);
    expect(new Set(ACCENT_PALETTE.map((a) => a.light)).size).toBe(ACCENT_PALETTE.length);
    expect(new Set(ACCENT_PALETTE.map((a) => a.dark)).size).toBe(ACCENT_PALETTE.length);
  });
});
