import React from "react";

type IconProps = { size?: number; className?: string; strokeWidth?: number };
type HeartProps = IconProps & { filled?: boolean };

/** Every icon shares one geometry contract: a 24×24 viewBox, stroked with
 *  currentColor, round caps/joins, and `size` controlling the rendered box.
 *  Keeping them consistent is what makes the chrome read as one set. */
function Svg({
  size = 18,
  className = "",
  strokeWidth = 1.8,
  fill = "none",
  children,
}: IconProps & { fill?: string; children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* ===== App chrome ===== */

export function GearIcon({ size = 20, className = "", strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}

export function SunIcon({ size = 18, className = "", strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  );
}

export function MoonIcon({ size = 18, className = "", strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.6 6.6 0 0 0 10.5 10.5z" />
    </Svg>
  );
}

/* ===== Sidebar navigation ===== */

export function LibraryIcon({ size = 18, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="3.2" y="3.2" width="7.4" height="7.4" rx="1.8" />
      <rect x="13.4" y="3.2" width="7.4" height="7.4" rx="1.8" />
      <rect x="3.2" y="13.4" width="7.4" height="7.4" rx="1.8" />
      <rect x="13.4" y="13.4" width="7.4" height="7.4" rx="1.8" />
    </Svg>
  );
}

export function AlbumsIcon({ size = 18, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="3.2" y="6.2" width="14.2" height="14.2" rx="2.2" />
      <path d="M7.2 3.2h11.6a2 2 0 0 1 2 2v11.6" />
      <path d="M6.2 16.6l3.2-3 2.3 2 2-1.8 2.1 1.9" />
      <circle cx="7.6" cy="10.4" r="1.2" />
    </Svg>
  );
}

export function ViewerIcon({ size = 18, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="3" y="4.2" width="18" height="15.6" rx="2.6" />
      <circle cx="8.6" cy="9.6" r="1.7" />
      <path d="M3.7 17.1l4.5-4.1 3.3 2.9 3.1-2.7 5.6 5" />
    </Svg>
  );
}

export function SearchIcon({ size = 18, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <circle cx="10.8" cy="10.8" r="6.6" />
      <path d="M20.2 20.2l-4.4-4.4" />
    </Svg>
  );
}

/** Explore is the search surface, so it shares the magnifier. */
export const ExploreIcon = SearchIcon;

export function DuplicatesIcon({ size = 18, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="8.6" y="3.2" width="12.2" height="12.2" rx="2.4" />
      <path d="M15.4 20.8H5.6a2.4 2.4 0 0 1-2.4-2.4V8.6" />
    </Svg>
  );
}

export function EditIcon({ size = 18, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M3 7h5.5M12.5 7H21M3 12h2.5M9.5 12H21M3 17h7.5M14.5 17H21" />
      <circle cx="10.5" cy="7" r="2" />
      <circle cx="7.5" cy="12" r="2" />
      <circle cx="12.5" cy="17" r="2" />
    </Svg>
  );
}

export function BatchIcon({ size = 18, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M12 3.2l8.8 4.6-8.8 4.6L3.2 7.8z" />
      <path d="M3.6 12.2L12 16.6l8.4-4.4" />
      <path d="M3.6 16.5L12 20.9l8.4-4.4" />
    </Svg>
  );
}

export function SlideshowIcon({ size = 18, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="3" y="4.6" width="18" height="14.8" rx="2.6" />
      <path d="M10.3 9.1l5.1 2.9-5.1 2.9z" />
    </Svg>
  );
}

/* ===== Small action icons ===== */

export function PlusIcon({ size = 16, className = "", strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M12 5.4v13.2M5.4 12h13.2" />
    </Svg>
  );
}

export function MoreIcon({ size = 16, className = "", strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" />
    </Svg>
  );
}

export function MinusIcon({ size = 16, className = "", strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M5.4 12h13.2" />
    </Svg>
  );
}

export function FolderIcon({ size = 16, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M3.4 7.2a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1.1 1.3h7.3a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

export function FilterIcon({ size = 16, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M3.6 6.4h16.8M6.6 12h10.8M10 17.6h4" />
    </Svg>
  );
}

export function HeartIcon({ size = 15, className = "", strokeWidth = 1.8, filled = false }: HeartProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth} fill={filled ? "currentColor" : "none"}>
      <path d="M12 20.2s-7.4-4.5-7.4-9.6a4.2 4.2 0 0 1 7.4-2.8 4.2 4.2 0 0 1 7.4 2.8c0 5.1-7.4 9.6-7.4 9.6z" />
    </Svg>
  );
}

export function EyeIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M2.4 12S6 5.6 12 5.6 21.6 12 21.6 12 18 18.4 12 18.4 2.4 12 2.4 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </Svg>
  );
}

export function EyeOffIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M9.9 6a8.6 8.6 0 0 1 2.1-.3c6 0 9.6 6.3 9.6 6.3a15.6 15.6 0 0 1-2.7 3.6M6.4 7.6A15.4 15.4 0 0 0 2.4 12S6 18.4 12 18.4a8.7 8.7 0 0 0 3.5-.7" />
      <path d="M10 10a2.9 2.9 0 0 0 4 4M3.4 3.4l17.2 17.2" />
    </Svg>
  );
}

export function FullscreenIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M4 9.2V5.6a1.6 1.6 0 0 1 1.6-1.6h3.6M14.8 4h3.6A1.6 1.6 0 0 1 20 5.6v3.6M20 14.8v3.6a1.6 1.6 0 0 1-1.6 1.6h-3.6M9.2 20H5.6A1.6 1.6 0 0 1 4 18.4v-3.6" />
    </Svg>
  );
}

export function VolumeIcon({ size = 15, className = "", strokeWidth = 1.8, muted = false }: IconProps & { muted?: boolean }) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M4 9.5h3l4-3.5v12l-4-3.5H4z" />
      {muted ? (
        <path d="M16.5 8.5l-4 7M12.5 8.5l4 7" />
      ) : (
        <>
          <path d="M16 8.2a4.5 4.5 0 0 1 0 7.6" />
          <path d="M18.8 5.6a8 8 0 0 1 0 12.8" />
        </>
      )}
    </Svg>
  );
}
export function RotateIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M20 11.4a8 8 0 1 0-1.4 5.7" />
      <path d="M20.4 5.6v5h-5" />
    </Svg>
  );
}

export function CropIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M6.4 2.4v15.2h15.2M2.4 6.4h15.2v15.2" />
    </Svg>
  );
}

export function FlipIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M12 3.6v16.8" />
      <path d="M8.6 7.2L4.2 12l4.4 4.8z" />
      <path d="M15.4 7.2L19.8 12l-4.4 4.8z" />
    </Svg>
  );
}

export function PlayIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M7.6 4.6l11 7.4-11 7.4z" />
    </Svg>
  );
}

export function StopIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="6.2" y="6.2" width="11.6" height="11.6" rx="2.2" />
    </Svg>
  );
}

export function PauseIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M9 5.2v13.6M15 5.2v13.6" />
    </Svg>
  );
}

export function SparkleIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M12 3.2l1.9 5.1 5.1 1.9-5.1 1.9L12 17.2l-1.9-5.1L5 10.2l5.1-1.9zM18.6 16.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </Svg>
  );
}

export function UsersIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <circle cx="9.4" cy="8.4" r="3.4" />
      <path d="M3.4 19.4a6 6 0 0 1 12 0" />
      <path d="M16.4 5.6a3.2 3.2 0 0 1 0 6M18.2 19.4a5.6 5.6 0 0 0-2.1-4.3" />
    </Svg>
  );
}

export function TagIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M11.4 3.6H19a1.4 1.4 0 0 1 1.4 1.4v7.6a1.4 1.4 0 0 1-.4 1l-7 7a1.4 1.4 0 0 1-2 0l-6.6-6.6a1.4 1.4 0 0 1 0-2l7-7a1.4 1.4 0 0 1 1-.4z" />
      <circle cx="15.8" cy="8.2" r="1.3" />
    </Svg>
  );
}

export function ImageOffIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M3.4 8.6V6.4a2.2 2.2 0 0 1 2.2-2.2h2.2M15.4 4.2h3a2.2 2.2 0 0 1 2.2 2.2v2.2M20.6 15.4v2.2a2.2 2.2 0 0 1-2.2 2.2h-2.2M8.6 19.8H6.2A2.2 2.2 0 0 1 4 17.6v-2.2" />
      <path d="M3.4 3.4l17.2 17.2" />
    </Svg>
  );
}

/* ===== Gallery layout modes ===== */

export function GridIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="3.4" y="3.4" width="7.2" height="7.2" rx="1.7" />
      <rect x="13.4" y="3.4" width="7.2" height="7.2" rx="1.7" />
      <rect x="3.4" y="13.4" width="7.2" height="7.2" rx="1.7" />
      <rect x="13.4" y="13.4" width="7.2" height="7.2" rx="1.7" />
    </Svg>
  );
}

export function FilmstripIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="3" y="4.4" width="18" height="15.2" rx="2.2" />
      <path d="M7.8 4.4v15.2M16.2 4.4v15.2" />
    </Svg>
  );
}

export function OverviewIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="3" y="3.6" width="18" height="7.4" rx="1.9" />
      <rect x="3" y="13" width="18" height="7.4" rx="1.9" />
    </Svg>
  );
}

export function ColumnsIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="3" y="3.6" width="5" height="16.8" rx="1.2" />
      <rect x="9.5" y="3.6" width="5" height="16.8" rx="1.2" />
      <rect x="16" y="3.6" width="5" height="16.8" rx="1.2" />
    </Svg>
  );
}

export function DetailsIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="3" y="3.4" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="16.6" width="18" height="4" rx="1" />
    </Svg>
  );
}

export function TimelineIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M4 8h16" />
      <path d="M12 11v7" />
      <circle cx="12" cy="11" r="2" />
      <path d="M8 16h8" />
    </Svg>
  );
}

export function ShareIcon({ size = 15, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M12 3.4v11.2" />
      <path d="M8.2 7.2L12 3.4l3.8 3.8" />
      <path d="M5.4 13.6v5a1.9 1.9 0 0 0 1.9 1.9h9.4a1.9 1.9 0 0 0 1.9-1.9v-5" />
    </Svg>
  );
}

export function InspectorIcon({ size = 18, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="2" y="2" width="18" height="18" rx="2" />
      <path d="M12 2v18" />
      <path d="M6 10h10" />
    </Svg>
  );
}

export function LockIcon({ size = 13, className = "", strokeWidth = 1.9 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="4.6" y="10.6" width="14.8" height="9.4" rx="2.4" />
      <path d="M8.2 10.6V8a3.8 3.8 0 0 1 7.6 0v2.6" />
    </Svg>
  );
}

export function ShieldIcon({ size = 16, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M12 2L3 7v11c0 5 4 8 9 11 5-3 9-6 9-11V7L12 2z" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 9h6M9 12h4" strokeLinecap="round" />
    </Svg>
  );
}

export function CpuIcon({ size = 16, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9h16M4 15h16" strokeLinecap="round" />
      <path d="M9 4v16M15 4v16" strokeLinecap="round" />
    </Svg>
  );
}

export function TrashIcon({ size = 16, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function RotateCcwIcon({ size = 16, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 3v5h5" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function DownloadIcon({ size = 16, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function InfoIcon({ size = 16, className = "", strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="10" fill="none" />
      <path d="M12 16v-4M12 8h.01" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function CheckIcon({ size = 14, className = "", strokeWidth = 2.2 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M4.5 12.5l4.5 4.5 7.5-7.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ChevronDownIcon({ size = 14, className = "", strokeWidth = 2 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M6 9l6 6 6-6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ChevronLeftIcon({ size = 14, className = "", strokeWidth = 2 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M15 18l-6-6 6-6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ChevronRightIcon({ size = 14, className = "", strokeWidth = 2 }: IconProps) {
  return (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      <path d="M9 6l6 6-6 6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export default GearIcon;
