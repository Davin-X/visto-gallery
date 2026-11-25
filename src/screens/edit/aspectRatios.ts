export const ASPECT_RATIO_OPTIONS: Array<{
  label: string;
  value: number | "free";
  ratioName: string;
  fractionText: string;
}> = [
  { label: "Free", value: "free", ratioName: "Unconstrained", fractionText: "Custom" },
  { label: "1:1", value: 1, ratioName: "Square", fractionText: "1:1" },
  { label: "4:5", value: 4 / 5, ratioName: "Portrait", fractionText: "4:5" },
  { label: "4:3", value: 4 / 3, ratioName: "Standard", fractionText: "4:3" },
  { label: "3:2", value: 3 / 2, ratioName: "35mm", fractionText: "3:2" },
  { label: "16:9", value: 16 / 9, ratioName: "Widescreen", fractionText: "16:9" },
  { label: "9:16", value: 9 / 16, ratioName: "Vertical Story", fractionText: "9:16" },
];
