import { BrandMark } from "../design/components/BrandMark";
import { KindDot } from "../design/components/KindBadge";
import { NowPlaying } from "../design/components/NowPlaying";
import {
  GearIcon,
  SunIcon,
  MoonIcon,
  LibraryIcon,
  AlbumsIcon,
  ViewerIcon,
  DuplicatesIcon,
  EditIcon,
  BatchIcon,
  FolderIcon,
  InspectorIcon,
  EyeOffIcon,
} from "../design/components/icons";
import { ACCENT_PALETTE } from "../engine/stores";
import { formatBytesSimple } from "../engine/utils/mediaTypes";
import type { LibraryFolder, LibraryStats } from "../engine/types/commands";
import type { Screen } from "./screen";

const NAV_ITEMS: Array<{
  label: string;
  Icon: typeof LibraryIcon;
  screen: Screen;
}> = [
  { label: "Library", Icon: LibraryIcon, screen: "Library" },
  { label: "Albums", Icon: AlbumsIcon, screen: "Albums" },
  { label: "Viewer", Icon: ViewerIcon, screen: "Viewer" },
  { label: "Duplicates", Icon: DuplicatesIcon, screen: "Duplicates" },
  { label: "Edit", Icon: EditIcon, screen: "Edit" },
  { label: "Batch", Icon: BatchIcon, screen: "Batch" },
  { label: "Hidden", Icon: EyeOffIcon, screen: "Hidden" },
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
  onCycleAccent: () => void;
  onOpenSettings: () => void;
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
  accentColor,
  onToggleSidebar,
  onToggleInspector,
  onToggleAppearance,
  onCycleAccent,
  onOpenSettings,
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

  return (
    <header className="topbar" onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}>
      <div className="topbar-brand">
        <BrandMark size={26} />
        <b>VistoGallery</b>
      </div>
      <div className="topbar-context">
        {screen === "Library" ? (
          activeAlbumName ? (
            <span>{activeAlbumName}</span>
          ) : (
            <span className="muted">Library</span>
          )
        ) : screen === "Albums" ? (
          <span>Albums</span>
        ) : screen === "Video" ? (
          <span>Video Player</span>
        ) : (
          <span>{screen}</span>
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
          title={sidebarOpen ? "Hide sidebar (⌥⌘S)" : "Show sidebar (⌥⌘S)"}
          onClick={onToggleSidebar}
        >
          <LibraryIcon size={18} />
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
          <InspectorIcon size={18} />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label={dark ? "Switch to light appearance" : "Switch to dark appearance"}
          title={dark ? "Switch to light appearance" : "Switch to dark appearance"}
          onClick={onToggleAppearance}
        >
          {dark ? <SunIcon size={18} /> : <MoonIcon size={18} />}
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
              width: 14,
              height: 14,
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
          <GearIcon size={18} />
        </button>
      </div>
    </header>
  );
}

interface AppSidebarProps {
  screen: Screen;
  folders: LibraryFolder[];
  sourcesSheetOpen: boolean;
  stats: LibraryStats;
  updateAvailable: boolean;
  updateVersion: string | null;
  appVersion: string;
  onOpenScreen: (screen: Screen) => void;
  onOpenSources: () => void;
  onOpenUpdate: () => void;
}

export function AppSidebar({
  screen,
  folders,
  sourcesSheetOpen,
  stats,
  updateAvailable,
  updateVersion,
  appVersion,
  onOpenScreen,
  onOpenSources,
  onOpenUpdate,
}: AppSidebarProps) {
  const folderCount = folders.length;
  const folderItems = folders.reduce((total, folder) => total + folder.itemCount, 0);

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <div className="sidebar-header">
          <div className="sidebar-label">WORKSPACE</div>
          <nav className="primary-nav" aria-label="Main navigation">
            {NAV_ITEMS.map(({ label, Icon, screen: target }) => {
              return (
                <button
                  key={label}
                  type="button"
                  className={`nav-item ${screen === target ? "active" : ""}`}
                  aria-label={label}
                  title={label}
                  aria-current={screen === target ? "page" : undefined}
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

        <div className="sidebar-divider" aria-hidden="true" />

        <div className="sidebar-section">
          <div className="sidebar-section-label">LIBRARY</div>
          <div className="library-stats">
            <div className="stat-row">
              <KindDot kind="photo" />
              <span className="stat-label">Photos</span>
              <span className="stat-value">
                {stats.photos.toLocaleString()}
                <span className="stat-size">· {formatBytesSimple(stats.photoSize)}</span>
              </span>
            </div>
            <div className="stat-row">
              <KindDot kind="video" />
              <span className="stat-label">Videos</span>
              <span className="stat-value">
                {stats.videos.toLocaleString()}
                <span className="stat-size">· {formatBytesSimple(stats.videoSize)}</span>
              </span>
            </div>
            <div className="stat-row">
              <KindDot kind="raw" />
              <span className="stat-label">RAW</span>
              <span className="stat-value">
                {stats.raws.toLocaleString()}
                <span className="stat-size">· {formatBytesSimple(stats.rawSize)}</span>
              </span>
            </div>
            <div className="stat-row">
              <KindDot kind="photo" />
              <span className="stat-label">Favorites</span>
              <span className="stat-value">
                {stats.favorites.toLocaleString()}
                <span className="stat-size">· {formatBytesSimple(stats.favoriteSize)}</span>
              </span>
            </div>
            <div className="stat-row">
              <KindDot kind="photo" />
              <span className="stat-label">Uncategorized</span>
              <span className="stat-value">
                {stats.uncategorized.toLocaleString()}
                <span className="stat-size">· {formatBytesSimple(stats.uncategorizedSize)}</span>
              </span>
            </div>
            <div className="stat-row hidden">
              <KindDot kind="photo" />
              <span className="stat-label">Hidden</span>
              <span className="stat-value">
                {stats.hidden.toLocaleString()}
                <span className="stat-size">· {formatBytesSimple(stats.hiddenSize)}</span>
              </span>
            </div>
            <div className="stat-row size">
              <span className="stat-label">Total</span>
              <span className="stat-value">
                {(stats.photos + stats.videos + stats.raws + stats.uncategorized).toLocaleString()}{" "}
                · {formatBytesSimple(stats.totalSize)}
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="sidebar-footer">
        <span className="sidebar-health">
          <span className="health-dot" aria-hidden="true" />
          Storage Healthy
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
