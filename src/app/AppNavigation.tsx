import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NowPlaying } from "../design/components/NowPlaying";
import {
  GearIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  LibraryIcon,
  AlbumsIcon,
  EditIcon,
  BatchIcon,
  FolderIcon,
  EyeOffIcon,
  GridIcon,
  PlayIcon,
  CropIcon,
  SparkleIcon,
  HeartIcon,
  TagIcon,
  PanelLeftIcon,
  PanelRightIcon,
  ChartIcon,
  TrashIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from "../design/components/icons";
import { ACCENT_PALETTE } from "../engine/stores";
import type { Appearance } from "../engine/types/generated/ipc";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import type { LibraryFolder, LibraryStats } from "../engine/types/commands";
import { isHiddenLocked, useHiddenLockStore } from "../engine/stores/useHiddenLockStore";
import type { Screen } from "./screen";
import type { CleanupScreen } from "./useNavigationStore";
import { usePopoverFocus } from "../design/hooks/usePopoverFocus";

/** The top-bar button cycles light → dark → system → light. */
export function cycleAppearance(appearance: Appearance): Appearance {
  return appearance === "light" ? "dark" : appearance === "dark" ? "system" : "light";
}

/** Top-bar name for screens whose sidebar entry is not the screen name. */
const SCREEN_TITLES: Partial<Record<Screen, string>> = {
  Video: "Video Player",
  Duplicates: "Clean up",
  Cleanup: "Clean up",
};

const APPEARANCE_LABEL: Record<Appearance, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const NAV_ITEMS: Array<{
  label: string;
  Icon: typeof LibraryIcon;
  /** Every screen this entry owns; the first one is where a click lands. */
  screens: Screen[];
}> = [
  { label: "Library", Icon: LibraryIcon, screens: ["Library"] },
  { label: "Albums", Icon: AlbumsIcon, screens: ["Albums"] },
  // Duplicates and Cleanup are separate screens behind one entry so the tab
  // strip, Back/Forward and the saved last view all keep working.
  { label: "Clean up", Icon: TrashIcon, screens: ["Duplicates", "Cleanup"] },
  { label: "Edit", Icon: EditIcon, screens: ["Edit"] },
  { label: "Batch", Icon: BatchIcon, screens: ["Batch"] },
  { label: "Hidden", Icon: EyeOffIcon, screens: ["Hidden"] },
];

interface AppTopBarProps {
  screen: Screen;
  activeAlbumName: string | null;
  busy: boolean;
  progressPhase: string | null;
  sidebarOpen: boolean;
  showInspector: boolean;
  dark: boolean;
  accentColor: string;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onToggleAppearance: () => void;
  appearance: Appearance;
  onCycleAccent: () => void;
  onOpenSettings: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  /** Set while a video is in the background player on a non-Video screen. */
  nowPlaying?: { name: string; playing: boolean; navigable?: boolean } | null;
  onNowPlayingExpand?: () => void;
  onNowPlayingToggle?: () => void;
  onNowPlayingStop?: () => void;
  onNowPlayingPrevious?: () => void;
  onNowPlayingNext?: () => void;
}

export function AppTopBar({
  screen,
  activeAlbumName,
  busy,
  progressPhase,
  sidebarOpen,
  showInspector,
  dark,
  appearance,
  accentColor,
  onToggleSidebar,
  onToggleInspector,
  onToggleAppearance,
  onCycleAccent,
  onOpenSettings,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onMouseDown,
  onDoubleClick,
  nowPlaying,
  onNowPlayingExpand,
  onNowPlayingToggle,
  onNowPlayingStop,
  onNowPlayingPrevious,
  onNowPlayingNext,
}: AppTopBarProps) {
  const inspectorAvailable = screen === "Library" || screen === "Hidden";
  const appearanceNextLabel = APPEARANCE_LABEL[cycleAppearance(appearance)];

  return (
    <header className="topbar" onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      {screen !== "Video" && (
        <div className="topbar-leading">
          <div className="topbar-history" role="group" aria-label="History">
            <button
              type="button"
              className="icon-button"
              aria-label="Go back"
              title="Go back (⌘[)"
              onClick={onGoBack}
              disabled={!canGoBack}
            >
              <ChevronLeftIcon size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Go forward"
              title="Go forward (⌘])"
              onClick={onGoForward}
              disabled={!canGoForward}
            >
              <ChevronRightIcon size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      )}
      <div className="topbar-context">
        {screen === "Library" ? (
          activeAlbumName ? (
            <span>{activeAlbumName}</span>
          ) : (
            <span className="muted">Library</span>
          )
        ) : (
          <span>{SCREEN_TITLES[screen] ?? screen}</span>
        )}
        {busy && (
          <span className="topbar-busy">
            {progressPhase === "hashing"
              ? "Checking duplicates…"
              : progressPhase === "reading"
                ? "Loading library…"
                : "Indexing…"}
          </span>
        )}
      </div>
      <div className="topbar-trailing">
        {nowPlaying && onNowPlayingExpand && onNowPlayingToggle && onNowPlayingStop && (
          <NowPlaying
            name={nowPlaying.name}
            playing={nowPlaying.playing}
            onExpand={onNowPlayingExpand}
            onToggle={onNowPlayingToggle}
            onStop={onNowPlayingStop}
            onPrevious={nowPlaying.navigable ? onNowPlayingPrevious : undefined}
            onNext={nowPlaying.navigable ? onNowPlayingNext : undefined}
          />
        )}
        <div className="topbar-actions">
          <button
            className="icon-button"
            type="button"
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-pressed={sidebarOpen}
            title={sidebarOpen ? "Hide sidebar (⌘\\)" : "Show sidebar (⌘\\)"}
            onClick={onToggleSidebar}
          >
            <PanelLeftIcon size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={
              !inspectorAvailable
                ? "Inspector available in Library and Hidden"
                : showInspector
                  ? "Hide inspector"
                  : "Show inspector"
            }
            aria-pressed={inspectorAvailable && showInspector}
            disabled={!inspectorAvailable}
            title={
              inspectorAvailable
                ? showInspector
                  ? "Hide inspector (⌥⌘I)"
                  : "Show inspector (⌥⌘I)"
                : "Inspector is available in Library and Hidden"
            }
            onClick={onToggleInspector}
          >
            <PanelRightIcon size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={`Appearance: ${APPEARANCE_LABEL[appearance]}. Switch to ${appearanceNextLabel}`}
            title={`Appearance: ${APPEARANCE_LABEL[appearance]} — switch to ${appearanceNextLabel}`}
            onClick={onToggleAppearance}
          >
            {appearance === "light" ? (
              <SunIcon size={16} />
            ) : appearance === "dark" ? (
              <MoonIcon size={16} />
            ) : (
              <MonitorIcon size={16} />
            )}
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Accent color"
            title="Cycle accent color"
            onClick={onCycleAccent}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: (ACCENT_PALETTE.find((c) => c.id === accentColor) || ACCENT_PALETTE[0])[
                  dark ? "dark" : "light"
                ],
                display: "inline-block",
                border: "1px solid rgba(0,0,0,0.2)",
              }}
            />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={onOpenSettings}
          >
            <GearIcon size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}

interface AppSidebarProps {
  screen: Screen;
  /** The Clean up view the user was last on. */
  cleanupTab: CleanupScreen;
  folders: LibraryFolder[];
  sourcesSheetOpen: boolean;
  stats: LibraryStats;
  updateAvailable: boolean;
  updateVersion: string | null;
  appVersion: string;
  sidebarCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenScreen: (screen: Screen) => void;
  onOpenSources: () => void;
  onOpenUpdate: () => void;
}

export function AppSidebar({
  screen,
  cleanupTab,
  folders,
  sourcesSheetOpen,
  stats,
  updateAvailable,
  updateVersion,
  appVersion,
  sidebarCollapsed,
  onToggleCollapse,
  onOpenScreen,
  onOpenSources,
  onOpenUpdate,
}: AppSidebarProps) {
  // A catalog upgraded from an older build (and the browser harness) can
  // briefly return a partial stats object. The sidebar is rendered before any
  // interaction handlers, so never let a missing counter crash the whole app.
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const displayStats = {
    photos: count(stats?.photos),
    videos: count(stats?.videos),
    raws: count(stats?.raws),
    animations: count(stats?.animations),
    animationsSize: count(stats?.animationsSize),
    uncategorized: count(stats?.uncategorized),
    favorites: count(stats?.favorites),
    hidden: count(stats?.hidden),
    photoSize: count(stats?.photoSize),
    videoSize: count(stats?.videoSize),
    rawSize: count(stats?.rawSize),
    uncategorizedSize: count(stats?.uncategorizedSize),
    favoriteSize: count(stats?.favoriteSize),
    hiddenSize: count(stats?.hiddenSize),
    totalSize: count(stats?.totalSize),
  };
  const folderCount = folders.length;
  const folderItems = folders.reduce((total, folder) => total + folder.itemCount, 0);
  const hiddenLocked = useHiddenLockStore((s) => isHiddenLocked(s.status));
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsPos, setStatsPos] = useState({ top: 0, left: 0 });
  const statsWrapRef = useRef<HTMLDivElement>(null);
  const statsButtonRef = useRef<HTMLButtonElement>(null);
  const statsPopupRef = useRef<HTMLDivElement>(null);
  // The popup is read-only, so it takes focus itself when it opens and
  // hands it back to the chart button when it closes.
  usePopoverFocus(statsOpen, statsPopupRef, statsButtonRef);
  // The popup must escape the rail: .sidebar (overflow hidden) and
  // .sidebar-scroll (overflow-y auto / overflow-x hidden) clip anything
  // rendered inside them, and the sibling .main-content paints over
  // whatever overflows the sidebar. Portaling into .app-frame with fixed
  // positioning — like FilterDropdown / ContextMenu — is the only way to
  // paint above the main pane without giving up sidebar scrolling.
  // .app-frame (not body) so the panel inherits the theme tokens.
  const portalRoot =
    typeof document === "undefined"
      ? null
      : (document.querySelector<HTMLElement>(".app-frame") ?? document.body);

  // The popup only makes sense in rail mode; expanding or hiding the
  // sidebar should close it, and Escape/outside clicks dismiss it.
  useEffect(() => {
    if (!statsOpen) return;
    if (!sidebarCollapsed) {
      setStatsOpen(false);
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The popup is portaled outside statsWrapRef, so clicks inside it
      // would look like outside clicks unless it is checked too.
      if (
        !(statsWrapRef.current?.contains(target) ?? false) &&
        !(statsPopupRef.current?.contains(target) ?? false)
      ) {
        setStatsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setStatsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [statsOpen, sidebarCollapsed]);

  // Anchor the portaled popup to the chart button and keep it inside the
  // viewport (mirrors FilterDropdown's positioning). Re-run on resize and
  // on any scroll — .sidebar-scroll scrolling moves the button.
  useLayoutEffect(() => {
    if (!statsOpen) return;
    const positionPopup = () => {
      const button = statsButtonRef.current;
      const panel = statsPopupRef.current;
      if (!button || !panel) return;
      const buttonRect = button.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const padding = 8;
      const gap = 10;
      let left = buttonRect.right + gap;
      let top = buttonRect.top;
      left = Math.max(padding, Math.min(left, window.innerWidth - panelRect.width - padding));
      if (top + panelRect.height > window.innerHeight - padding) {
        top = window.innerHeight - panelRect.height - padding;
      }
      if (top < padding) top = padding;
      setStatsPos((prev) => (prev.top === top && prev.left === left ? prev : { top, left }));
    };
    positionPopup();
    window.addEventListener("resize", positionPopup);
    window.addEventListener("scroll", positionPopup, true);
    return () => {
      window.removeEventListener("resize", positionPopup);
      window.removeEventListener("scroll", positionPopup, true);
    };
  }, [statsOpen]);

  const libraryStatsRows = (
    <>
      <div className="stat-row">
        <GridIcon className="stat-icon is-photo" size={13} strokeWidth={1.7} />
        <span className="stat-label">Photos</span>
        <span className="stat-value">
          {displayStats.photos.toLocaleString()}
          <span className="stat-size">· {formatBytesSimple(displayStats.photoSize)}</span>
        </span>
      </div>
      <div className="stat-row">
        <PlayIcon className="stat-icon is-video" size={13} strokeWidth={1.7} />
        <span className="stat-label">Videos</span>
        <span className="stat-value">
          {displayStats.videos.toLocaleString()}
          <span className="stat-size">· {formatBytesSimple(displayStats.videoSize)}</span>
        </span>
      </div>
      <div className="stat-row">
        <CropIcon className="stat-icon is-raw" size={13} strokeWidth={1.7} />
        <span className="stat-label">RAW</span>
        <span className="stat-value">
          {displayStats.raws.toLocaleString()}
          <span className="stat-size">· {formatBytesSimple(displayStats.rawSize)}</span>
        </span>
      </div>
      <div className="stat-row">
        <SparkleIcon className="stat-icon" size={13} strokeWidth={1.7} />
        <span className="stat-label">Animations</span>
        <span className="stat-value">
          {displayStats.animations.toLocaleString()}
          <span className="stat-size">· {formatBytesSimple(displayStats.animationsSize)}</span>
        </span>
      </div>
      {/* The catalog only stores photo, video and raw kinds, so this row
          only appears if an older catalog holds something else. */}
      {displayStats.uncategorized > 0 && (
        <div className="stat-row">
          <TagIcon className="stat-icon" size={13} strokeWidth={1.7} />
          <span className="stat-label">Uncategorized</span>
          <span className="stat-value">
            {displayStats.uncategorized.toLocaleString()}
            <span className="stat-size">· {formatBytesSimple(displayStats.uncategorizedSize)}</span>
          </span>
        </div>
      )}
      <div className="stat-row size">
        <span className="stat-label">Total</span>
        <span className="stat-value">
          {(
            displayStats.photos +
            displayStats.videos +
            displayStats.raws +
            displayStats.animations +
            displayStats.uncategorized
          ).toLocaleString()}{" "}
          · {formatBytesSimple(displayStats.totalSize)}
        </span>
      </div>
      {/* Favorites and Hidden are views, not kinds: favorites are already in
          the counts above and hidden items are left out of the total, so they
          sit apart from the rows that add up to it. */}
      <div className="stat-row view-start" title="Already counted in the kinds above">
        <HeartIcon className="stat-icon" size={13} strokeWidth={1.7} />
        <span className="stat-label">Favorites</span>
        <span className="stat-value">
          {displayStats.favorites.toLocaleString()}
          <span className="stat-size">· {formatBytesSimple(displayStats.favoriteSize)}</span>
        </span>
      </div>
      {/* While Hidden is locked its count and size are not shown at all. */}
      {!hiddenLocked && (
        <div className="stat-row hidden" title="Not counted in the total">
          <EyeOffIcon className="stat-icon" size={13} strokeWidth={1.7} />
          <span className="stat-label">Hidden</span>
          <span className="stat-value">
            {displayStats.hidden.toLocaleString()}
            <span className="stat-size">· {formatBytesSimple(displayStats.hiddenSize)}</span>
          </span>
        </div>
      )}
    </>
  );

  // (No separate pointerdown opener: it would fire before the click
  // toggle and the pair would open-then-close. The dismissal effect is
  // only attached while open, so the opening gesture can't close it.)

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <div className="sidebar-header">
          <div className="sidebar-label">
            <span className="sidebar-label-text">WORKSPACE</span>
            <button
              type="button"
              className="sidebar-collapse-toggle"
              onClick={onToggleCollapse}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar to icons"}
              aria-pressed={sidebarCollapsed}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar to icons"}
            >
              {/* A different icon from the title bar's Hide sidebar button:
                  that one removes the sidebar, this one shrinks it to a rail. */}
              {sidebarCollapsed ? (
                <ChevronsRightIcon size={14} strokeWidth={2} />
              ) : (
                <ChevronsLeftIcon size={14} strokeWidth={2} />
              )}
            </button>
          </div>
          <nav className="primary-nav" aria-label="Main navigation">
            {NAV_ITEMS.map(({ label, Icon, screens }) => {
              const active = screens.includes(screen);
              // Clicking the entry from elsewhere returns to the last tab;
              // the tab strip itself is the only way to change it.
              const target = screens.includes("Cleanup") ? cleanupTab : screens[0];
              return (
                <button
                  key={label}
                  type="button"
                  className={`nav-item ${active ? "active" : ""}`}
                  aria-label={label}
                  title={label}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onOpenScreen(target)}
                >
                  <span className="nav-icon">
                    <Icon size={18} />
                  </span>
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="sidebar-divider" aria-hidden="true" />

        <div className="sidebar-section sources-entry-section">
          <button
            type="button"
            className={`sources-entry${sourcesSheetOpen ? " open" : ""}`}
            onClick={onOpenSources}
            title="Manage library sources"
            aria-haspopup="dialog"
            aria-expanded={sourcesSheetOpen}
          >
            <span className="sources-entry-icon">
              <FolderIcon size={16} />
            </span>
            <span className="sources-entry-text">
              <span className="sources-entry-name">Sources</span>
              <span className="sources-entry-count">
                {folderCount === 0
                  ? "No sources yet"
                  : `${folderCount.toLocaleString()} folder${folderCount === 1 ? "" : "s"} · ${folderItems.toLocaleString()} items`}
              </span>
            </span>
            <span className="sources-entry-action">
              <span className="sources-entry-chevron" aria-hidden="true">
                ›
              </span>
            </span>
          </button>
        </div>

        <div className="sidebar-stats-entry" ref={statsWrapRef}>
          <button
            ref={statsButtonRef}
            type="button"
            className="sidebar-stats-button"
            onClick={() => {
              if (!statsOpen) {
                // Seed the fixed position before the portal mounts so the
                // panel doesn't flash at the viewport origin; the layout
                // effect above then clamps it to the viewport.
                const rect = statsButtonRef.current?.getBoundingClientRect();
                if (rect) setStatsPos({ top: rect.top, left: rect.right + 10 });
              }
              setStatsOpen((value) => !value);
            }}
            aria-label="Library stats"
            aria-haspopup="dialog"
            aria-expanded={statsOpen}
            title="Library stats"
          >
            <ChartIcon size={18} />
          </button>
          {statsOpen &&
            portalRoot &&
            createPortal(
              <div
                ref={statsPopupRef}
                className="sidebar-stats-popup"
                tabIndex={-1}
                role="dialog"
                aria-label="Library stats"
                style={{ position: "fixed", top: statsPos.top, left: statsPos.left, zIndex: 200 }}
              >
                <div className="sidebar-section-label">LIBRARY</div>
                <div className="library-stats">{libraryStatsRows}</div>
              </div>,
              portalRoot,
            )}
        </div>

        <div className="sidebar-divider" aria-hidden="true" />

        <div className="sidebar-section">
          <div className="sidebar-section-label">LIBRARY</div>
          <div className="library-stats">{libraryStatsRows}</div>
        </div>
      </div>
      <div className="sidebar-footer">
        {/* A plain statement of where the library lives. The old "Storage
            Healthy" badge was static text that no check ever updated. */}
        <span className="sidebar-health" title="Your photos and catalog never leave this Mac">
          On this Mac
        </span>
        <div className="sidebar-version-group">
          {updateAvailable && (
            <button
              type="button"
              className="update-badge"
              onClick={onOpenUpdate}
              title={`VistoGallery ${updateVersion} is available`}
            >
              <span className="update-dot" aria-hidden="true" />
              Update
            </button>
          )}
          <span className="sidebar-version">v{appVersion || "dev"}</span>
        </div>
      </div>
    </aside>
  );
}
