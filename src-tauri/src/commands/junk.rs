//! System and developer junk that lives outside the photo library.
//!
//! The Cleanup screen answers four questions, in this order of importance:
//!
//! 1. **Protection** — what is never offered, whatever the input. Only the
//!    fixed rules in [`STATIC_JUNK`], build artifacts listed in [`ARTIFACTS`]
//!    next to their project manifest, and old installers directly inside
//!    Downloads can ever become candidates. Anything inside a registered
//!    library folder is refused.
//! 2. **Pre-flight** — is it still safe right now? A rule whose tool is
//!    running, a project artifact that changed minutes ago, one that Git
//!    tracks, holds a nested repository or a private key, or one the user
//!    marked "Never clean" becomes a *skip with a reason*, not a row. Every
//!    check runs again when the user cleans, so scan-time trust expires.
//! 3. **Honesty** — sizes are allocated bytes with hard links counted once
//!    (a hard link shared with another folder frees nothing), and a folder
//!    that cannot be read makes its category `partial` instead of looking
//!    empty.
//! 4. **Recovery** — everything goes to the Trash through the same sink as
//!    item deletion, so Finder's Put Back works. Nothing here unlinks a file.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;
use walkdir::WalkDir;

use crate::errors::CommandError;

/// Old installers in Downloads have to be at least this old to be offered.
pub(crate) const INSTALLER_MIN_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Extensions treated as installers. Archives (`.zip`, `.tar.gz`) are left
/// alone: they are as likely to be a document as a download.
const INSTALLER_EXTENSIONS: &[&str] = &["dmg", "pkg", "mpkg", "iso", "xip"];
/// How deep below a project folder build artifacts are looked for.
const PROJECT_SCAN_DEPTH: usize = 6;
/// Folders below the home folder that are walked for projects. A project is
/// recognised by its manifest, not by these names; they only bound the walk
/// so the scan never wanders into `~/Library` or the photo library.
const PROJECT_ROOTS: &[&str] = &[
    "Developer",
    "Projects",
    "projects",
    "Code",
    "code",
    "src",
    "dev",
    "Dev",
    "repos",
    "Repos",
    "GitHub",
    "git",
    "Sites",
    "Workspace",
    "workspace",
    "work",
    "Work",
];
/// Folders macOS guards with a permission prompt. They are only walked (and
/// Downloads only scanned for installers) once the user turns this on, so
/// opening the Cleanup screen never triggers a burst of system prompts.
const PERSONAL_ROOTS: &[&str] = &["Documents", "Desktop", "Downloads"];
/// The settings key that stores the user's choice.
const PERSONAL_SETTING: &str = "cleanup_personal_folders";
/// Directory names the project walk never descends into.
const PROJECT_WALK_SKIP: &[&str] = &["Library", "Applications", "Pictures", "Movies", "Music"];
/// Bundle extensions the project walk never descends into.
const BUNDLE_EXTENSIONS: &[&str] = &[
    "app",
    "photoslibrary",
    "bundle",
    "framework",
    "xcarchive",
    "fcpbundle",
    "musiclibrary",
    "tvlibrary",
    "lrdata",
    "lrlibrary",
];
/// A project artifact changed this recently is probably being written by a
/// running build or dev server, so it is skipped rather than offered.
const RECENT_ACTIVITY: Duration = Duration::from_secs(15 * 60);
/// A cap so one enormous project tree cannot produce an endless list.
const MAX_PROJECT_ITEMS: usize = 200;
/// A cap for stale installers per scan, largest first.
const MAX_DOWNLOAD_ITEMS: usize = 100;
/// Upper bound on one cleanup request.
const MAX_SELECTION: usize = 1000;
/// Each category's scan stops after this long and reports itself partial.
const CATEGORY_BUDGET: Duration = Duration::from_secs(90);
/// A Git probe that takes longer than this is "unknown", which means skip.
const GIT_TIMEOUT: Duration = Duration::from_secs(5);
/// Videos at least this large are called out in the library footprint.
const LARGE_VIDEO_BYTES: i64 = 1024 * 1024 * 1024;
/// Cleanup runs kept in history.
const HISTORY_LIMIT: i64 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum JunkCategory {
    Xcode,
    Packages,
    Projects,
    Downloads,
}

/// What it costs to get an item back after the Trash is emptied.
/// Irreplaceable data is never listed at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum JunkTier {
    /// The tool recreates it on its own, at worst with a slower next run.
    Regenerable,
    /// Something has to be re-run or re-downloaded by hand (`npm install`,
    /// a new installer download, a re-archive).
    Rebuildable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ScanStatus {
    /// Every location in the category was read.
    Complete,
    /// Some folders could not be read or the scan ran out of time; totals
    /// are a lower bound.
    Partial,
    /// The category's location could not be read at all.
    Unavailable,
    /// The user has not turned scanning of this location on.
    Off,
}

/// Why a candidate is shown as skipped instead of offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    /// The tool that owns it is running (or running apps could not be listed).
    AppRunning,
    /// It changed in the last few minutes.
    RecentActivity,
    /// Its folder could not be read.
    Unreadable,
    /// Git tracks files inside it, or that could not be checked.
    GitTracked,
    /// It contains a nested Git repository or a private key.
    Sensitive,
    /// The user marked it "Never clean".
    NeverClean,
}

/// One cleanup candidate. `id` is the only thing the frontend sends back; the
/// path in it is never trusted without [`plan_clean`] re-validating it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct JunkItem {
    pub id: String,
    pub category: JunkCategory,
    pub label: String,
    pub detail: String,
    pub path: String,
    /// Allocated bytes that moving this item to the Trash (and emptying it)
    /// gives back. Hard links shared with files outside the item are not
    /// included: removing one link frees nothing.
    pub bytes: u64,
    /// Allocated bytes of files hard-linked from outside the item (a pnpm
    /// `node_modules` linking into the store, for example).
    pub shared_bytes: u64,
    pub file_count: u64,
    /// Most recent modification inside the item, in milliseconds since the
    /// epoch — how long ago the tool last actually used it.
    pub last_used_at: Option<i64>,
    pub tier: JunkTier,
}

/// A candidate that was found but is not offered, with the reason.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct JunkSkip {
    pub id: String,
    pub category: JunkCategory,
    pub label: String,
    pub path: String,
    pub bytes: u64,
    pub reason: SkipReason,
    pub message: String,
}

/// The scan result for one category. The screen scans every category in
/// parallel and renders each one as soon as it arrives.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct JunkCategoryReport {
    pub category: JunkCategory,
    pub status: ScanStatus,
    pub status_message: Option<String>,
    pub items: Vec<JunkItem>,
    pub skips: Vec<JunkSkip>,
    pub total_bytes: u64,
    pub scanned_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct JunkFailure {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
pub struct JunkCleanResult {
    pub removed_items: u64,
    /// Bytes moved to the Trash. The disk only gains them back when the
    /// Trash is emptied.
    pub moved_bytes: u64,
    pub failed: Vec<JunkFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct JunkIgnoredItem {
    pub id: String,
    pub label: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

/// What the catalog knows about the photo library's own size.
#[derive(Debug, Clone, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFootprint {
    pub total_items: u64,
    pub total_bytes: u64,
    pub photo_bytes: u64,
    pub video_bytes: u64,
    pub raw_bytes: u64,
    pub large_video_count: u64,
    pub large_video_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRun {
    pub finished_at: i64,
    pub removed_items: u64,
    pub moved_bytes: u64,
    pub failed_items: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOverview {
    pub disk: Option<DiskSpace>,
    /// Whether Documents, Desktop and Downloads are scanned.
    pub personal_folders: bool,
    pub library: LibraryFootprint,
    pub history: Vec<CleanupRun>,
}

struct StaticJunk {
    key: &'static str,
    category: JunkCategory,
    label: &'static str,
    detail: &'static str,
    /// Paths relative to the user's home folder.
    targets: &'static [&'static str],
    tier: JunkTier,
    /// Process names that mean the tool is in use right now.
    busy_if: &'static [&'static str],
}

const XCODE_PROCESSES: &[&str] = &["Xcode", "xcodebuild", "Simulator", "XCBBuildService"];

/// The complete allowlist of fixed junk locations. Keys are stable ids: they
/// are what the Clean button and the Never clean list store, so renaming one
/// is a breaking change.
const STATIC_JUNK: &[StaticJunk] = &[
    StaticJunk {
        key: "xcode-derived-data",
        category: JunkCategory::Xcode,
        label: "Xcode DerivedData",
        detail: "Build products and indexes — Xcode rebuilds them on the next build",
        targets: &["Library/Developer/Xcode/DerivedData"],
        tier: JunkTier::Regenerable,
        busy_if: XCODE_PROCESSES,
    },
    StaticJunk {
        key: "xcode-device-support",
        category: JunkCategory::Xcode,
        label: "Device support symbols",
        detail: "Debug symbols Xcode copies again the next time a device connects",
        targets: &[
            "Library/Developer/Xcode/iOS DeviceSupport",
            "Library/Developer/Xcode/watchOS DeviceSupport",
            "Library/Developer/Xcode/tvOS DeviceSupport",
            "Library/Developer/Xcode/visionOS DeviceSupport",
        ],
        tier: JunkTier::Regenerable,
        busy_if: XCODE_PROCESSES,
    },
    StaticJunk {
        key: "xcode-previews",
        category: JunkCategory::Xcode,
        label: "SwiftUI preview data",
        detail: "Preview simulators and builds — recreated when a preview runs",
        targets: &["Library/Developer/Xcode/UserData/Previews"],
        tier: JunkTier::Regenerable,
        busy_if: XCODE_PROCESSES,
    },
    StaticJunk {
        key: "simulator-caches",
        category: JunkCategory::Xcode,
        label: "Simulator caches",
        detail: "Dyld and runtime caches the Simulator rebuilds on launch",
        targets: &["Library/Developer/CoreSimulator/Caches"],
        tier: JunkTier::Regenerable,
        busy_if: XCODE_PROCESSES,
    },
    StaticJunk {
        key: "xcode-app-cache",
        category: JunkCategory::Xcode,
        label: "Xcode app cache",
        detail: "Downloaded documentation and download caches",
        targets: &["Library/Caches/com.apple.dt.Xcode"],
        tier: JunkTier::Regenerable,
        busy_if: XCODE_PROCESSES,
    },
    StaticJunk {
        key: "xcode-archives",
        category: JunkCategory::Xcode,
        label: "Xcode Archives",
        detail: "Signed builds and dSYMs — keep them if you symbolicate crash logs",
        targets: &["Library/Developer/Xcode/Archives"],
        tier: JunkTier::Rebuildable,
        busy_if: &["Xcode", "xcodebuild"],
    },
    StaticJunk {
        key: "npm-cache",
        category: JunkCategory::Packages,
        label: "npm cache",
        detail: "Package tarballs npm downloads again when it needs them",
        targets: &[".npm/_cacache"],
        tier: JunkTier::Regenerable,
        busy_if: &["npm", "npx"],
    },
    StaticJunk {
        key: "yarn-cache",
        category: JunkCategory::Packages,
        label: "Yarn cache",
        detail: "Global Yarn package cache",
        targets: &["Library/Caches/Yarn"],
        tier: JunkTier::Regenerable,
        busy_if: &["yarn"],
    },
    StaticJunk {
        key: "pnpm-store",
        category: JunkCategory::Packages,
        label: "pnpm store",
        detail: "Content-addressed store; projects that link into it keep their copies",
        targets: &["Library/pnpm/store", ".pnpm-store"],
        tier: JunkTier::Regenerable,
        busy_if: &["pnpm", "pnpx"],
    },
    StaticJunk {
        key: "bun-cache",
        category: JunkCategory::Packages,
        label: "Bun install cache",
        detail: "Packages Bun downloads again on the next install",
        targets: &[".bun/install/cache"],
        tier: JunkTier::Regenerable,
        busy_if: &["bun"],
    },
    StaticJunk {
        key: "node-gyp-cache",
        category: JunkCategory::Packages,
        label: "node-gyp headers",
        detail: "Node.js headers fetched for native modules",
        targets: &["Library/Caches/node-gyp"],
        tier: JunkTier::Regenerable,
        busy_if: &["node-gyp", "npm"],
    },
    StaticJunk {
        key: "playwright-browsers",
        category: JunkCategory::Packages,
        label: "Playwright browsers",
        detail: "Test browsers — run `npx playwright install` to get them back",
        targets: &["Library/Caches/ms-playwright"],
        tier: JunkTier::Rebuildable,
        busy_if: &["playwright"],
    },
    StaticJunk {
        key: "cocoapods-cache",
        category: JunkCategory::Packages,
        label: "CocoaPods cache",
        detail: "Downloaded pod specs and archives",
        targets: &["Library/Caches/CocoaPods"],
        tier: JunkTier::Regenerable,
        busy_if: &["pod"],
    },
    StaticJunk {
        key: "swiftpm-cache",
        category: JunkCategory::Packages,
        label: "Swift Package Manager cache",
        detail: "Fetched Swift packages and their repositories",
        targets: &["Library/Caches/org.swift.swiftpm"],
        tier: JunkTier::Regenerable,
        busy_if: &["swift-build", "swift-package", "xcodebuild", "Xcode"],
    },
    StaticJunk {
        key: "cargo-cache",
        category: JunkCategory::Packages,
        label: "Cargo registry cache",
        detail: "Crate archives Rust re-downloads when it needs them",
        targets: &[".cargo/registry/cache"],
        tier: JunkTier::Regenerable,
        busy_if: &["cargo", "rustc"],
    },
    StaticJunk {
        key: "go-build-cache",
        category: JunkCategory::Packages,
        label: "Go build cache",
        detail: "Compiled packages Go rebuilds on demand",
        targets: &["Library/Caches/go-build"],
        tier: JunkTier::Regenerable,
        busy_if: &["go", "gopls"],
    },
    StaticJunk {
        key: "pip-cache",
        category: JunkCategory::Packages,
        label: "pip cache",
        detail: "Wheels and downloads pip fetches again",
        targets: &["Library/Caches/pip"],
        tier: JunkTier::Regenerable,
        busy_if: &["pip", "pip3"],
    },
    StaticJunk {
        key: "uv-cache",
        category: JunkCategory::Packages,
        label: "uv cache",
        detail: "Python packages uv downloads again",
        targets: &[".cache/uv"],
        tier: JunkTier::Regenerable,
        busy_if: &["uv", "uvx"],
    },
    StaticJunk {
        key: "gradle-cache",
        category: JunkCategory::Packages,
        label: "Gradle caches",
        detail: "Dependencies and build caches Gradle downloads again",
        targets: &[".gradle/caches"],
        tier: JunkTier::Regenerable,
        busy_if: &["gradle", "gradlew"],
    },
    StaticJunk {
        key: "maven-repository",
        category: JunkCategory::Packages,
        label: "Maven repository",
        detail: "Local copies of Maven dependencies — the next build downloads them",
        targets: &[".m2/repository"],
        tier: JunkTier::Rebuildable,
        busy_if: &["mvn"],
    },
    StaticJunk {
        key: "homebrew-cache",
        category: JunkCategory::Packages,
        label: "Homebrew cache",
        detail: "Downloaded bottles and formula sources",
        targets: &["Library/Caches/Homebrew"],
        tier: JunkTier::Regenerable,
        busy_if: &["brew", "brew.sh", "brew.rb"],
    },
];

/// A build artifact inside a project. It is only recognised next to one of
/// its `manifests`, and, when `marker` is set, only when that file exists
/// inside it (a `venv` without `pyvenv.cfg` is not a virtual environment).
struct Artifact {
    name: &'static str,
    manifests: &'static [&'static str],
    marker: Option<&'static str>,
    tool: &'static str,
    recover: &'static str,
    busy_if: &'static [&'static str],
}

const JS: &[&str] = &["package.json"];
const PY: &[&str] = &["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"];
const GRADLE: &[&str] = &[
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
];

const ARTIFACTS: &[Artifact] = &[
    Artifact {
        name: "node_modules",
        manifests: JS,
        marker: None,
        tool: "Dependencies",
        recover: "reinstall with npm, yarn or pnpm install",
        busy_if: &["npm", "yarn", "pnpm", "bun"],
    },
    Artifact {
        name: "target",
        manifests: &["Cargo.toml"],
        marker: None,
        tool: "Rust build output",
        recover: "cargo build recreates it",
        busy_if: &["cargo", "rustc"],
    },
    Artifact {
        name: ".next",
        manifests: JS,
        marker: None,
        tool: "Next.js build",
        recover: "next build recreates it",
        busy_if: &[],
    },
    Artifact {
        name: ".nuxt",
        manifests: JS,
        marker: None,
        tool: "Nuxt build",
        recover: "nuxt build recreates it",
        busy_if: &[],
    },
    Artifact {
        name: ".svelte-kit",
        manifests: JS,
        marker: None,
        tool: "SvelteKit output",
        recover: "the next dev or build run recreates it",
        busy_if: &[],
    },
    Artifact {
        name: ".turbo",
        manifests: JS,
        marker: None,
        tool: "Turborepo cache",
        recover: "the next turbo run recreates it",
        busy_if: &["turbo"],
    },
    Artifact {
        name: ".parcel-cache",
        manifests: JS,
        marker: None,
        tool: "Parcel cache",
        recover: "the next build recreates it",
        busy_if: &[],
    },
    Artifact {
        name: ".angular",
        manifests: &["angular.json"],
        marker: None,
        tool: "Angular cache",
        recover: "the next build recreates it",
        busy_if: &["ng"],
    },
    Artifact {
        name: ".astro",
        manifests: JS,
        marker: None,
        tool: "Astro cache",
        recover: "the next build recreates it",
        busy_if: &[],
    },
    Artifact {
        name: ".expo",
        manifests: JS,
        marker: None,
        tool: "Expo cache",
        recover: "the next expo start recreates it",
        busy_if: &["expo"],
    },
    Artifact {
        name: ".venv",
        manifests: PY,
        marker: Some("pyvenv.cfg"),
        tool: "Python virtual environment",
        recover: "recreate it and reinstall the requirements",
        busy_if: &[],
    },
    Artifact {
        name: "venv",
        manifests: PY,
        marker: Some("pyvenv.cfg"),
        tool: "Python virtual environment",
        recover: "recreate it and reinstall the requirements",
        busy_if: &[],
    },
    Artifact {
        name: ".tox",
        manifests: &["tox.ini", "pyproject.toml", "setup.py"],
        marker: None,
        tool: "tox environments",
        recover: "the next tox run recreates them",
        busy_if: &["tox"],
    },
    Artifact {
        name: ".mypy_cache",
        manifests: PY,
        marker: None,
        tool: "mypy cache",
        recover: "the next mypy run recreates it",
        busy_if: &["mypy"],
    },
    Artifact {
        name: ".gradle",
        manifests: GRADLE,
        marker: None,
        tool: "Gradle project cache",
        recover: "the next Gradle build recreates it",
        busy_if: &["gradle", "gradlew"],
    },
    Artifact {
        name: "Pods",
        manifests: &["Podfile"],
        marker: None,
        tool: "CocoaPods",
        recover: "pod install restores it",
        busy_if: &["pod"],
    },
    Artifact {
        name: ".build",
        manifests: &["Package.swift"],
        marker: None,
        tool: "SwiftPM build output",
        recover: "swift build recreates it",
        busy_if: &["swift-build", "swift-package"],
    },
    Artifact {
        name: ".dart_tool",
        manifests: &["pubspec.yaml"],
        marker: None,
        tool: "Dart tool cache",
        recover: "dart pub get restores it",
        busy_if: &["dart", "flutter"],
    },
    Artifact {
        name: ".zig-cache",
        manifests: &["build.zig"],
        marker: None,
        tool: "Zig cache",
        recover: "zig build recreates it",
        busy_if: &["zig"],
    },
    Artifact {
        name: "zig-out",
        manifests: &["build.zig"],
        marker: None,
        tool: "Zig build output",
        recover: "zig build recreates it",
        busy_if: &["zig"],
    },
];

/// Files whose presence inside an artifact means it is not junk.
const KEY_FILE_NAMES: &[&str] = &["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];

/// Everything one scan or clean needs to know about the world. Kept free of
/// Tauri state so the rules can be tested against a temporary home folder.
pub(crate) struct ScanEnv<'a> {
    pub home: &'a Path,
    pub protected: &'a [PathBuf],
    /// Names of running processes, or `None` when they could not be listed —
    /// which makes every rule that has a busy check unsafe.
    pub running: Option<&'a HashSet<String>>,
    pub ignored: &'a HashSet<String>,
    /// The Git binary, or `None` when there is none to ask.
    pub git: Option<&'a Path>,
    pub deadline: Option<Instant>,
    /// Whether Documents, Desktop and Downloads may be read.
    pub personal_folders: bool,
}

#[derive(Debug, Default, Clone, Copy)]
struct Stats {
    bytes: u64,
    shared_bytes: u64,
    files: u64,
    newest: Option<SystemTime>,
    /// Entries that could not be read.
    unreadable: u64,
    timed_out: bool,
    has_git: bool,
    has_key: bool,
}

impl Stats {
    fn add(&mut self, other: Stats) {
        self.bytes += other.bytes;
        self.shared_bytes += other.shared_bytes;
        self.files += other.files;
        self.unreadable += other.unreadable;
        self.timed_out |= other.timed_out;
        self.has_git |= other.has_git;
        self.has_key |= other.has_key;
        self.newest = match (self.newest, other.newest) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn to_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn past_deadline(deadline: Option<Instant>) -> bool {
    deadline.is_some_and(|deadline| Instant::now() >= deadline)
}

/// Allocated size of one file and, when it has more than one hard link, the
/// key that identifies its inode.
#[cfg(unix)]
fn physical(metadata: &std::fs::Metadata) -> (u64, Option<(u64, u64, u64)>) {
    use std::os::unix::fs::MetadataExt;
    let bytes = metadata.blocks().saturating_mul(512);
    let link = (metadata.nlink() > 1).then(|| (metadata.dev(), metadata.ino(), metadata.nlink()));
    (bytes, link)
}

#[cfg(not(unix))]
fn physical(metadata: &std::fs::Metadata) -> (u64, Option<(u64, u64, u64)>) {
    (metadata.len(), None)
}

/// Bytes, file count, most recent modification and safety flags below
/// `path`. Symlinks are never followed, so a link inside a cache cannot pull
/// an unrelated tree into the total (or into the delete). A hard-linked file
/// counts towards `bytes` only when every one of its links is inside `path`.
fn stats(path: &Path, deadline: Option<Instant>) -> Stats {
    let mut stats = Stats::default();
    let Ok(root_meta) = std::fs::symlink_metadata(path) else {
        return stats;
    };
    if root_meta.is_file() {
        let (bytes, link) = physical(&root_meta);
        if link.is_some() {
            stats.shared_bytes = bytes;
        } else {
            stats.bytes = bytes;
        }
        stats.files = 1;
        stats.newest = root_meta.modified().ok();
        return stats;
    }
    if !root_meta.is_dir() {
        return stats;
    }

    // inode -> (links, links seen here, allocated bytes)
    let mut links: HashMap<(u64, u64), (u64, u64, u64)> = HashMap::new();
    for (index, entry) in WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .enumerate()
    {
        if index % 512 == 0 && past_deadline(deadline) {
            stats.timed_out = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                stats.unreadable += 1;
                continue;
            }
        };
        let file_type = entry.file_type();
        if file_type.is_dir() {
            if entry.depth() > 0 && entry.file_name() == ".git" {
                stats.has_git = true;
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if KEY_FILE_NAMES.contains(&name) || name.starts_with("deploy_key") {
                stats.has_key = true;
            }
        }
        let Ok(metadata) = entry.metadata() else {
            stats.unreadable += 1;
            continue;
        };
        let (bytes, link) = physical(&metadata);
        match link {
            Some((dev, ino, nlink)) => {
                let slot = links.entry((dev, ino)).or_insert((nlink, 0, bytes));
                slot.1 += 1;
            }
            None => stats.bytes += bytes,
        }
        stats.files += 1;
        if let Ok(modified) = metadata.modified() {
            stats.newest = Some(stats.newest.map_or(modified, |newest| newest.max(modified)));
        }
    }
    for (nlink, seen, bytes) in links.into_values() {
        if seen >= nlink {
            stats.bytes += bytes;
        } else {
            stats.shared_bytes += bytes;
        }
    }
    stats
}

/// True when `path` is a library root or sits inside one. Uses real paths so a
/// symlink cannot smuggle a library file past the check.
fn is_protected(path: &Path, protected: &[PathBuf]) -> bool {
    let Ok(real) = path.canonicalize() else {
        // A path that cannot be resolved is never trusted.
        return true;
    };
    protected.iter().any(|root| real.starts_with(root))
}

/// Canonical library roots. Missing folders (unmounted drive) are dropped;
/// they cannot contain anything right now.
pub(crate) fn protected_roots(paths: &[String]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter_map(|path| Path::new(path).canonicalize().ok())
        .collect()
}

/// The first of `names` that is running, as a user-facing reason. When the
/// process list is unknown every guarded rule is busy (fail closed).
fn busy_reason(env: &ScanEnv, names: &[&str]) -> Option<String> {
    if names.is_empty() {
        return None;
    }
    let Some(running) = env.running else {
        return Some("Running apps could not be checked".to_string());
    };
    names
        .iter()
        .find(|name| running.contains(**name))
        .map(|name| format!("{name} is running"))
}

/// Names of running processes: each executable's file name plus the file
/// name of its first argument, so `node …/npm-cli.js` and a script like
/// `brew.sh` are both recognised. `None` when `ps` fails.
pub(crate) fn running_processes() -> Option<HashSet<String>> {
    let mut names = HashSet::new();
    let comm = Command::new("/bin/ps")
        .args(["-axo", "comm="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !comm.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&comm.stdout).lines() {
        if let Some(name) = line
            .trim()
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
        {
            names.insert(name.to_string());
        }
    }
    if let Ok(args) = Command::new("/bin/ps")
        .args(["-axww", "-o", "args="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        for line in String::from_utf8_lossy(&args.stdout).lines() {
            for token in line.split_whitespace().take(2) {
                if token.starts_with('-') {
                    continue;
                }
                if let Some(name) = token.rsplit('/').next().filter(|name| !name.is_empty()) {
                    names.insert(name.to_string());
                }
            }
        }
    }
    Some(names)
}

/// A Git binary that will not pop the "install command line tools" dialog:
/// `/usr/bin/git` is only used when the developer tools are already there.
pub(crate) fn find_git() -> Option<PathBuf> {
    let candidates = [
        "/opt/homebrew/bin/git",
        "/usr/local/bin/git",
        "/Library/Developer/CommandLineTools/usr/bin/git",
        "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

/// Whether Git tracks anything at or below `target` in `repo`. Bounded and
/// hermetic: inherited Git environment is removed, optional locks and the
/// fsmonitor are off, the pathspec is literal, and a probe that times out or
/// fails is `None` — unknown, which callers treat as unsafe.
fn git_tracks(git: &Path, repo: &Path, target: &Path) -> Option<bool> {
    let relative = target.strip_prefix(repo).ok()?.to_str()?;
    let mut child = Command::new(git)
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-C")
        .arg(repo)
        .args(["ls-files", "-z", "--"])
        .arg(format!(":(top,literal){relative}"))
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_LITERAL_PATHSPECS")
        .env_remove("GIT_GLOB_PATHSPECS")
        .env_remove("GIT_NOGLOB_PATHSPECS")
        .env_remove("GIT_ICASE_PATHSPECS")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut byte = [0u8; 1];
        let _ = sender.send(stdout.read(&mut byte).map(|count| count > 0));
    });
    match receiver.recv_timeout(GIT_TIMEOUT) {
        Ok(Ok(true)) => {
            let _ = child.kill();
            let _ = child.wait();
            Some(true)
        }
        Ok(Ok(false)) => {
            let status = child.wait().ok()?;
            status.success().then_some(false)
        }
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// The nearest folder at or above `start` that holds a `.git`, stopping at
/// `limit` (the project root being walked).
fn repository_root(start: &Path, limit: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        if dir == limit {
            break;
        }
        current = dir.parent();
    }
    None
}

fn project_roots(home: &Path, personal_folders: bool) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let personal: &[&str] = if personal_folders {
        PERSONAL_ROOTS
    } else {
        &[]
    };
    PROJECT_ROOTS
        .iter()
        .chain(personal.iter())
        .map(|name| home.join(name))
        .filter(|path| path.is_dir())
        // Case-insensitive volumes report `Code` and `code` as the same folder.
        .filter(|path| {
            path.canonicalize()
                .map(|real| seen.insert(real))
                .unwrap_or(false)
        })
        .collect()
}

fn artifact_named(name: &str) -> Option<&'static Artifact> {
    ARTIFACTS.iter().find(|artifact| artifact.name == name)
}

/// The artifact rule that `path` matches: right name, a manifest next to it,
/// and its marker file inside when the rule has one.
fn matching_artifact(path: &Path) -> Option<&'static Artifact> {
    let artifact = artifact_named(path.file_name()?.to_str()?)?;
    let project = path.parent()?;
    if !artifact
        .manifests
        .iter()
        .any(|manifest| project.join(manifest).is_file())
    {
        return None;
    }
    if let Some(marker) = artifact.marker {
        if !path.join(marker).is_file() {
            return None;
        }
    }
    Some(artifact)
}

fn is_bundle(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, extension)| {
        BUNDLE_EXTENSIONS
            .iter()
            .any(|bundle| extension.eq_ignore_ascii_case(bundle))
    })
}

/// The project root (from [`project_roots`]) that contains `path`, if any.
/// Containment is decided on real paths; the root is returned as the scan
/// walks it, so Git lookups stop at the same boundary in scan and clean.
fn containing_project_root(home: &Path, personal: bool, path: &Path) -> Option<PathBuf> {
    let real = path.canonicalize().ok()?;
    project_roots(home, personal).into_iter().find(|root| {
        root.canonicalize()
            .map(|real_root| real.starts_with(&real_root) && real != real_root)
            .unwrap_or(false)
    })
}

/// Everything that can rule out one project artifact, shared by the scan and
/// the clean so the two can never disagree.
fn assess_artifact(
    env: &ScanEnv,
    path: &Path,
    artifact: &Artifact,
    root: &Path,
) -> Result<Stats, (SkipReason, String, Stats)> {
    let id = format!("projects:{}", path.to_string_lossy());
    if env.ignored.contains(&id) {
        return Err((
            SkipReason::NeverClean,
            "You marked this Never clean".to_string(),
            stats(path, env.deadline),
        ));
    }
    let part = stats(path, env.deadline);
    if part.files == 0 && part.unreadable > 0 {
        return Err((
            SkipReason::Unreadable,
            "This folder could not be read".to_string(),
            part,
        ));
    }
    if part.has_git {
        return Err((
            SkipReason::Sensitive,
            "Contains a Git repository".to_string(),
            part,
        ));
    }
    if part.has_key {
        return Err((
            SkipReason::Sensitive,
            "Contains a private key".to_string(),
            part,
        ));
    }
    if let Some(newest) = part.newest {
        if SystemTime::now()
            .duration_since(newest)
            .map(|elapsed| elapsed < RECENT_ACTIVITY)
            .unwrap_or(true)
        {
            return Err((
                SkipReason::RecentActivity,
                "Changed in the last few minutes — probably in use".to_string(),
                part,
            ));
        }
    }
    if let Some(reason) = busy_reason(env, artifact.busy_if) {
        return Err((SkipReason::AppRunning, reason, part));
    }
    let project = path.parent().unwrap_or(path);
    if let Some(repo) = repository_root(project, root) {
        let tracked = env.git.and_then(|git| {
            let real_repo = repo.canonicalize().ok()?;
            let real_path = path.canonicalize().ok()?;
            git_tracks(git, &real_repo, &real_path)
        });
        match tracked {
            Some(false) => {}
            Some(true) => {
                return Err((
                    SkipReason::GitTracked,
                    "Git tracks files inside it".to_string(),
                    part,
                ))
            }
            None => {
                return Err((
                    SkipReason::GitTracked,
                    "Git could not confirm it is untracked".to_string(),
                    part,
                ))
            }
        }
    }
    Ok(part)
}

#[derive(Default)]
struct Collector {
    items: Vec<JunkItem>,
    skips: Vec<JunkSkip>,
    unreadable: u64,
    timed_out: bool,
    unavailable: Option<String>,
    off: Option<String>,
}

impl Collector {
    #[allow(clippy::too_many_arguments)]
    fn skip(
        &mut self,
        id: String,
        category: JunkCategory,
        label: String,
        path: &Path,
        bytes: u64,
        reason: SkipReason,
        message: String,
    ) {
        self.skips.push(JunkSkip {
            id,
            category,
            label,
            path: path.to_string_lossy().into_owned(),
            bytes,
            reason,
            message,
        });
    }

    fn finish(mut self, category: JunkCategory) -> JunkCategoryReport {
        self.items.sort_by_key(|item| std::cmp::Reverse(item.bytes));
        self.skips.sort_by_key(|skip| std::cmp::Reverse(skip.bytes));
        let (status, status_message) = if let Some(message) = self.off {
            (ScanStatus::Off, Some(message))
        } else if let Some(message) = self.unavailable {
            (ScanStatus::Unavailable, Some(message))
        } else if self.timed_out {
            (
                ScanStatus::Partial,
                Some("The scan stopped early, so totals may be low.".to_string()),
            )
        } else if self.unreadable > 0 {
            (
                ScanStatus::Partial,
                Some(format!(
                    "{} {} could not be read, so totals may be low. Full Disk Access lets VistoGallery see them.",
                    self.unreadable,
                    if self.unreadable == 1 { "entry" } else { "entries" }
                )),
            )
        } else {
            (ScanStatus::Complete, None)
        };
        let total_bytes = self.items.iter().map(|item| item.bytes).sum();
        JunkCategoryReport {
            category,
            status,
            status_message,
            items: self.items,
            skips: self.skips,
            total_bytes,
            scanned_at: now_ms(),
        }
    }
}

/// Existing targets of a static rule and their combined stats. A protected
/// target is dropped from the scan (it is never shown at all).
fn static_targets(env: &ScanEnv, def: &StaticJunk) -> (Vec<PathBuf>, Stats) {
    let mut total = Stats::default();
    let mut paths = Vec::new();
    for target in def.targets {
        let path = env.home.join(target);
        if !path.is_dir() || is_protected(&path, env.protected) {
            continue;
        }
        let part = stats(&path, env.deadline);
        if part.files == 0 && part.unreadable == 0 {
            continue;
        }
        total.add(part);
        paths.push(path);
    }
    (paths, total)
}

fn scan_static(env: &ScanEnv, category: JunkCategory, out: &mut Collector) {
    for def in STATIC_JUNK.iter().filter(|def| def.category == category) {
        let (paths, total) = static_targets(env, def);
        out.timed_out |= total.timed_out;
        let Some(path) = paths.first() else {
            continue;
        };
        let skip = |reason, message: String, out: &mut Collector| {
            out.skip(
                def.key.to_string(),
                def.category,
                def.label.to_string(),
                path,
                total.bytes,
                reason,
                message,
            );
        };
        if env.ignored.contains(def.key) {
            skip(
                SkipReason::NeverClean,
                "You marked this Never clean".to_string(),
                out,
            );
            continue;
        }
        if total.files == 0 {
            out.unreadable += total.unreadable;
            skip(
                SkipReason::Unreadable,
                "This folder could not be read".to_string(),
                out,
            );
            continue;
        }
        out.unreadable += total.unreadable;
        if let Some(reason) = busy_reason(env, def.busy_if) {
            skip(SkipReason::AppRunning, reason, out);
            continue;
        }
        out.items.push(JunkItem {
            id: def.key.to_string(),
            category: def.category,
            label: def.label.to_string(),
            detail: def.detail.to_string(),
            path: path.to_string_lossy().into_owned(),
            bytes: total.bytes,
            shared_bytes: total.shared_bytes,
            file_count: total.files,
            last_used_at: total.newest.map(to_ms),
            tier: def.tier,
        });
    }
}

fn scan_projects(env: &ScanEnv, out: &mut Collector) {
    let mut items = Vec::new();
    'roots: for root in project_roots(env.home, env.personal_folders) {
        let mut walker = WalkDir::new(&root)
            .max_depth(PROJECT_SCAN_DEPTH)
            .follow_links(false)
            .into_iter();
        while let Some(entry) = walker.next() {
            if past_deadline(env.deadline) {
                out.timed_out = true;
                break 'roots;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    out.unreadable += 1;
                    continue;
                }
            };
            if entry.depth() == 0 || !entry.file_type().is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str() else {
                walker.skip_current_dir();
                continue;
            };
            let path = entry.path();
            // A library folder can hold hundreds of thousands of photos; none
            // of them can be junk, so the walk never goes in. (Safety does
            // not depend on this: candidates are checked on real paths.)
            if env.protected.iter().any(|root| path.starts_with(root)) {
                walker.skip_current_dir();
                continue;
            }
            if let Some(artifact) = matching_artifact(path) {
                // An artifact's own contents (nested node_modules and the
                // like) belong to it, so they are never walked separately.
                walker.skip_current_dir();
                if is_protected(path, env.protected) {
                    continue;
                }
                let id = format!("projects:{}", path.to_string_lossy());
                let project = path
                    .parent()
                    .and_then(Path::file_name)
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "project".to_string());
                let label = format!("{project}/{name}");
                match assess_artifact(env, path, artifact, &root) {
                    Ok(part) => {
                        out.unreadable += part.unreadable;
                        out.timed_out |= part.timed_out;
                        if part.files == 0 {
                            continue;
                        }
                        let relative = path
                            .parent()
                            .and_then(|parent| parent.strip_prefix(env.home).ok())
                            .unwrap_or(path)
                            .to_string_lossy()
                            .to_string();
                        items.push(JunkItem {
                            id,
                            category: JunkCategory::Projects,
                            label,
                            detail: format!(
                                "{} in ~/{relative} — {}",
                                artifact.tool, artifact.recover
                            ),
                            path: path.to_string_lossy().into_owned(),
                            bytes: part.bytes,
                            shared_bytes: part.shared_bytes,
                            file_count: part.files,
                            last_used_at: part.newest.map(to_ms),
                            tier: JunkTier::Rebuildable,
                        });
                    }
                    Err((reason, message, part)) => {
                        out.timed_out |= part.timed_out;
                        if part.files == 0 && reason != SkipReason::Unreadable {
                            continue;
                        }
                        out.skip(
                            id,
                            JunkCategory::Projects,
                            label,
                            path,
                            part.bytes,
                            reason,
                            message,
                        );
                    }
                }
                continue;
            }
            if name.starts_with('.')
                || PROJECT_WALK_SKIP.contains(&name)
                || artifact_named(name).is_some()
                || is_bundle(name)
            {
                walker.skip_current_dir();
            }
        }
    }
    items.sort_by_key(|item: &JunkItem| std::cmp::Reverse(item.bytes));
    items.truncate(MAX_PROJECT_ITEMS);
    out.items.extend(items);
}

fn is_installer(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            INSTALLER_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

fn older_than(modified: SystemTime, age: Duration) -> bool {
    SystemTime::now()
        .duration_since(modified)
        .map(|elapsed| elapsed >= age)
        .unwrap_or(false)
}

fn scan_downloads(env: &ScanEnv, out: &mut Collector) {
    if !env.personal_folders {
        out.off = Some(
            "Turn on scanning of Documents, Desktop and Downloads to find old installers."
                .to_string(),
        );
        return;
    }
    let downloads = env.home.join("Downloads");
    let entries = match std::fs::read_dir(&downloads) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            out.unavailable = Some(
                "VistoGallery can't read your Downloads folder. Allow it in System Settings › Privacy & Security › Files and Folders."
                    .to_string(),
            );
            return;
        }
    };
    let mut items = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            out.unreadable += 1;
            continue;
        };
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            out.unreadable += 1;
            continue;
        };
        if !metadata.is_file() || !is_installer(&path) {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if !older_than(modified, INSTALLER_MIN_AGE) || is_protected(&path, env.protected) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let id = format!("downloads:{}", path.to_string_lossy());
        let part = stats(&path, None);
        if env.ignored.contains(&id) {
            out.skip(
                id,
                JunkCategory::Downloads,
                name,
                &path,
                part.bytes,
                SkipReason::NeverClean,
                "You marked this Never clean".to_string(),
            );
            continue;
        }
        let days = SystemTime::now()
            .duration_since(modified)
            .map(|elapsed| elapsed.as_secs() / 86_400)
            .unwrap_or(0);
        items.push(JunkItem {
            id,
            category: JunkCategory::Downloads,
            label: name,
            detail: format!(
                "Installer downloaded {days} days ago — download it again if you need it"
            ),
            path: path.to_string_lossy().into_owned(),
            bytes: part.bytes,
            shared_bytes: part.shared_bytes,
            file_count: 1,
            last_used_at: Some(to_ms(modified)),
            tier: JunkTier::Rebuildable,
        });
    }
    items.sort_by_key(|item: &JunkItem| std::cmp::Reverse(item.bytes));
    items.truncate(MAX_DOWNLOAD_ITEMS);
    out.items.extend(items);
}

/// Scan one category. Read-only.
pub(crate) fn scan_category(env: &ScanEnv, category: JunkCategory) -> JunkCategoryReport {
    let mut out = Collector::default();
    match category {
        JunkCategory::Xcode | JunkCategory::Packages => scan_static(env, category, &mut out),
        JunkCategory::Projects => scan_projects(env, &mut out),
        JunkCategory::Downloads => scan_downloads(env, &mut out),
    }
    out.finish(category)
}

struct CleanPlanEntry {
    id: String,
    paths: Vec<PathBuf>,
    bytes: u64,
}

/// Validate every selected id and turn it into the real paths to trash.
///
/// Invalid ids become failures instead of aborting the run, so one stale row
/// cannot block the rest of the cleanup.
fn plan_clean(env: &ScanEnv, ids: &[String]) -> (Vec<CleanPlanEntry>, Vec<JunkFailure>) {
    let mut plan = Vec::new();
    let mut failed = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            continue;
        }
        match resolve_selection(env, id, true) {
            Ok(entry) => plan.push(entry),
            Err(message) => failed.push(JunkFailure {
                id: id.clone(),
                message,
            }),
        }
    }
    (plan, failed)
}

const LIBRARY_REFUSAL: &str = "That folder is part of a library source and is never cleaned.";

/// Re-validate one id. With `strict`, every pre-flight check applies (busy
/// tools, Never clean, Git, recent activity); without it only the structural
/// checks do, which is what revealing an item in Finder needs.
fn resolve_selection(env: &ScanEnv, id: &str, strict: bool) -> Result<CleanPlanEntry, String> {
    if strict && env.ignored.contains(id) {
        return Err("You marked this Never clean.".to_string());
    }
    if let Some(def) = STATIC_JUNK.iter().find(|def| def.key == id) {
        for target in def.targets {
            let path = env.home.join(target);
            if path.exists() && is_protected(&path, env.protected) {
                return Err(LIBRARY_REFUSAL.to_string());
            }
        }
        if strict {
            if let Some(reason) = busy_reason(env, def.busy_if) {
                return Err(format!("{reason} — quit it and try again."));
            }
        }
        let (paths, total) = static_targets(env, def);
        if paths.is_empty() || total.files == 0 {
            return Err("Nothing to remove — it is already empty or gone.".to_string());
        }
        return Ok(CleanPlanEntry {
            id: id.to_string(),
            paths,
            bytes: total.bytes,
        });
    }

    let Some((kind, raw_path)) = id.split_once(':') else {
        return Err("Unknown cleanup item.".to_string());
    };
    let path = PathBuf::from(raw_path);
    if !path.is_absolute()
        || raw_path.chars().any(char::is_control)
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Unknown cleanup item.".to_string());
    }
    if is_protected(&path, env.protected) {
        return Err(LIBRARY_REFUSAL.to_string());
    }

    match kind {
        "projects" => {
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                return Err("That folder is already gone.".to_string());
            };
            if !metadata.is_dir() {
                return Err("Only build folders inside a project can be cleaned here.".to_string());
            }
            let Some(artifact) = matching_artifact(&path) else {
                return Err(
                    "Only build folders next to their project manifest can be cleaned.".to_string(),
                );
            };
            let Some(root) = containing_project_root(env.home, env.personal_folders, &path) else {
                return Err(
                    "Only build folders inside your project folders can be cleaned.".to_string(),
                );
            };
            let part = if strict {
                assess_artifact(env, &path, artifact, &root)
                    .map_err(|(_, message, _)| format!("{message}."))?
            } else {
                stats(&path, env.deadline)
            };
            Ok(CleanPlanEntry {
                id: id.to_string(),
                paths: vec![path],
                bytes: part.bytes,
            })
        }
        "downloads" => {
            if !env.personal_folders {
                return Err("Scanning Downloads is turned off.".to_string());
            }
            let downloads = env.home.join("Downloads");
            let same_folder = path
                .parent()
                .and_then(|parent| parent.canonicalize().ok())
                .zip(downloads.canonicalize().ok())
                .is_some_and(|(parent, root)| parent == root);
            if !same_folder {
                return Err("Only files directly inside Downloads can be cleaned.".to_string());
            }
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                return Err("That installer is already gone.".to_string());
            };
            if !metadata.is_file() {
                return Err("That installer is already gone.".to_string());
            }
            if !is_installer(&path) {
                return Err("Only .dmg, .pkg, .iso and .xip installers can be cleaned.".to_string());
            }
            let age_ok = metadata
                .modified()
                .map(|modified| older_than(modified, INSTALLER_MIN_AGE))
                .unwrap_or(false);
            if !age_ok {
                return Err("That installer is newer than 30 days.".to_string());
            }
            Ok(CleanPlanEntry {
                id: id.to_string(),
                bytes: stats(&path, None).bytes,
                paths: vec![path],
            })
        }
        _ => Err("Unknown cleanup item.".to_string()),
    }
}

/// True for ids the Never clean list may store: a known rule key, or a
/// project/download id with an absolute path.
fn is_ignorable_id(id: &str) -> bool {
    if id.len() > 4096 || id.chars().any(char::is_control) {
        return false;
    }
    if STATIC_JUNK.iter().any(|def| def.key == id) {
        return true;
    }
    matches!(
        id.split_once(':'),
        Some(("projects" | "downloads", path)) if Path::new(path).is_absolute()
    )
}

async fn library_roots(pool: &sqlx::SqlitePool) -> Result<Vec<PathBuf>, CommandError> {
    let paths: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(pool)
        .await?;
    Ok(protected_roots(&paths))
}

/// The Never clean list. An error here aborts the scan or clean: running
/// without the user's exclusions would be worse than not running.
async fn ignored_ids(pool: &sqlx::SqlitePool) -> Result<HashSet<String>, CommandError> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM cleanup_ignored")
        .fetch_all(pool)
        .await
        .map_err(|error| {
            CommandError::database(format!(
                "The Never clean list could not be read, so nothing was cleaned: {error}"
            ))
        })?;
    Ok(ids.into_iter().collect())
}

fn home_dir() -> Result<PathBuf, CommandError> {
    dirs::home_dir().ok_or_else(|| CommandError::internal("The home folder is unavailable."))
}

struct OwnedEnv {
    home: PathBuf,
    protected: Vec<PathBuf>,
    running: Option<HashSet<String>>,
    ignored: HashSet<String>,
    git: Option<PathBuf>,
    personal_folders: bool,
}

/// Whether the user turned on scanning of Documents, Desktop and Downloads.
async fn personal_folders_enabled(pool: &sqlx::SqlitePool) -> Result<bool, CommandError> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(PERSONAL_SETTING)
        .fetch_optional(pool)
        .await?;
    Ok(value.as_deref() == Some("1"))
}

impl OwnedEnv {
    async fn load(catalog: &crate::Catalog) -> Result<Self, CommandError> {
        let pool = catalog.pool()?;
        let protected = library_roots(&pool).await?;
        let ignored = ignored_ids(&pool).await?;
        let personal_folders = personal_folders_enabled(&pool).await?;
        Ok(Self {
            home: home_dir()?,
            protected,
            running: None,
            ignored,
            git: None,
            personal_folders,
        })
    }

    /// Process list and Git lookup are blocking; call inside spawn_blocking.
    fn probe(&mut self) {
        self.running = running_processes();
        self.git = find_git();
    }

    fn env(&self, deadline: Option<Instant>) -> ScanEnv<'_> {
        ScanEnv {
            home: &self.home,
            protected: &self.protected,
            running: self.running.as_ref(),
            ignored: &self.ignored,
            git: self.git.as_deref(),
            deadline,
            personal_folders: self.personal_folders,
        }
    }
}

/// Inventory of one category of system and developer junk. Read-only.
#[tauri::command]
pub async fn scan_junk(
    catalog: State<'_, crate::Catalog>,
    category: JunkCategory,
) -> Result<JunkCategoryReport, CommandError> {
    let mut owned = OwnedEnv::load(&catalog).await?;
    tokio::task::spawn_blocking(move || {
        owned.probe();
        scan_category(&owned.env(Some(Instant::now() + CATEGORY_BUDGET)), category)
    })
    .await
    .map_err(|error| CommandError::internal(format!("Junk scan failed: {error}")))
}

/// Reveal one cleanup candidate in Finder. The id is validated structurally,
/// like a cleanup, so revealing cannot be used to poke at arbitrary paths.
#[tauri::command]
pub async fn reveal_junk(
    catalog: State<'_, crate::Catalog>,
    id: String,
) -> Result<(), CommandError> {
    let owned = OwnedEnv::load(&catalog).await?;
    tokio::task::spawn_blocking(move || {
        let entry = resolve_selection(&owned.env(None), &id, false).map_err(CommandError::path)?;
        let target = entry
            .paths
            .first()
            .cloned()
            .ok_or_else(|| CommandError::not_found("Nothing to reveal.".to_string()))?;
        Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&target)
            .status()
            .map_err(|error| CommandError::io(format!("Could not reveal the item: {error}")))?;
        Ok(())
    })
    .await
    .map_err(|error| CommandError::internal(format!("Reveal failed: {error}")))?
}

/// Open the user's Trash in Finder, so the space can actually be reclaimed.
#[tauri::command]
pub async fn open_trash() -> Result<(), CommandError> {
    let trash = home_dir()?.join(".Trash");
    tokio::task::spawn_blocking(move || {
        Command::new("/usr/bin/open")
            .arg(&trash)
            .status()
            .map(|_| ())
            .map_err(|error| CommandError::io(format!("Could not open the Trash: {error}")))
    })
    .await
    .map_err(|error| CommandError::internal(format!("Open Trash failed: {error}")))?
}

/// Move the selected junk to the Trash. Every id is re-validated first, and
/// the run is recorded in the cleanup history.
#[tauri::command]
pub async fn clean_junk(
    catalog: State<'_, crate::Catalog>,
    items: Vec<String>,
) -> Result<JunkCleanResult, CommandError> {
    if items.is_empty() {
        return Err(CommandError::invalid(
            "Choose at least one item to clean.".to_string(),
        ));
    }
    if items.len() > MAX_SELECTION {
        return Err(CommandError::invalid(
            "Too many items in one cleanup.".to_string(),
        ));
    }
    let mut owned = OwnedEnv::load(&catalog).await?;

    let result = tokio::task::spawn_blocking(move || {
        owned.probe();
        let env = owned.env(None);
        let (plan, mut failed) = plan_clean(&env, &items);
        if plan.is_empty() {
            return JunkCleanResult {
                removed_items: 0,
                moved_bytes: 0,
                failed,
            };
        }
        let paths: Vec<String> = plan
            .iter()
            .flat_map(|entry| entry.paths.iter())
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        match super::media::trash_external_paths(&paths) {
            Ok(()) => JunkCleanResult {
                removed_items: plan.len() as u64,
                moved_bytes: plan.iter().map(|entry| entry.bytes).sum(),
                failed,
            },
            Err(error) => {
                for entry in &plan {
                    failed.push(JunkFailure {
                        id: entry.id.clone(),
                        message: error.message.clone(),
                    });
                }
                JunkCleanResult {
                    removed_items: 0,
                    moved_bytes: 0,
                    failed,
                }
            }
        }
    })
    .await
    .map_err(|error| CommandError::internal(format!("Cleanup failed: {error}")))?;

    // History is a convenience: a failed write must not turn a successful
    // cleanup into an error.
    if result.removed_items > 0 || !result.failed.is_empty() {
        if let Ok(pool) = catalog.pool() {
            if let Err(error) = record_run(&pool, &result).await {
                tracing::warn!("could not record cleanup history: {error}");
            }
        }
    }
    Ok(result)
}

async fn record_run(pool: &sqlx::SqlitePool, result: &JunkCleanResult) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO cleanup_runs (finished_at, removed_items, moved_bytes, failed_items) VALUES (?, ?, ?, ?)",
    )
    .bind(now_ms())
    .bind(result.removed_items as i64)
    .bind(result.moved_bytes as i64)
    .bind(result.failed.len() as i64)
    .execute(pool)
    .await?;
    sqlx::query(
        "DELETE FROM cleanup_runs WHERE id NOT IN (SELECT id FROM cleanup_runs ORDER BY id DESC LIMIT ?)",
    )
    .bind(HISTORY_LIMIT)
    .execute(pool)
    .await?;
    Ok(())
}

/// Add an id to, or remove it from, the Never clean list.
#[tauri::command]
pub async fn set_junk_ignored(
    catalog: State<'_, crate::Catalog>,
    id: String,
    label: String,
    ignored: bool,
) -> Result<(), CommandError> {
    if !is_ignorable_id(&id) {
        return Err(CommandError::invalid("Unknown cleanup item.".to_string()));
    }
    let pool = catalog.pool()?;
    if ignored {
        let label: String = label
            .chars()
            .filter(|c| !c.is_control())
            .take(300)
            .collect();
        sqlx::query(
            "INSERT INTO cleanup_ignored (id, label, created_at) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET label = excluded.label",
        )
        .bind(&id)
        .bind(label)
        .bind(now_ms())
        .execute(&pool)
        .await?;
    } else {
        sqlx::query("DELETE FROM cleanup_ignored WHERE id = ?")
            .bind(&id)
            .execute(&pool)
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_junk_ignored(
    catalog: State<'_, crate::Catalog>,
) -> Result<Vec<JunkIgnoredItem>, CommandError> {
    let pool = catalog.pool()?;
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT id, label, created_at FROM cleanup_ignored ORDER BY created_at DESC",
    )
    .fetch_all(&pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, label, created_at)| JunkIgnoredItem {
            id,
            label,
            created_at,
        })
        .collect())
}

/// Free space the way Finder reports it: what is available for important
/// data, which includes purgeable space macOS frees on demand (local
/// snapshots, iCloud-evictable files). `statvfs` alone reads lower.
#[cfg(target_os = "macos")]
fn important_available_bytes(path: &Path) -> Option<u64> {
    use objc2_foundation::{
        NSArray, NSNumber, NSString, NSURLVolumeAvailableCapacityForImportantUsageKey, NSURL,
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
    // SAFETY: the key is an immutable NSString constant exported by Foundation.
    let key = unsafe { NSURLVolumeAvailableCapacityForImportantUsageKey };
    let values = url
        .resourceValuesForKeys_error(&NSArray::from_slice(&[key]))
        .ok()?;
    let value = values.objectForKey(key)?;
    let bytes = value.downcast_ref::<NSNumber>()?.longLongValue();
    (bytes > 0).then_some(bytes as u64)
}

#[cfg(not(target_os = "macos"))]
fn important_available_bytes(_path: &Path) -> Option<u64> {
    None
}

#[cfg(unix)]
fn disk_space(path: &Path) -> Option<DiskSpace> {
    use std::os::unix::ffi::OsStrExt;
    let important = important_available_bytes(path);
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is a valid NUL-terminated string and `stat` is a valid,
    // writable statvfs for the duration of the call.
    let status = unsafe { libc::statvfs(path.as_ptr(), &mut stat) };
    if status != 0 {
        return None;
    }
    let fragment = stat.f_frsize as u64;
    let total_bytes = (stat.f_blocks as u64).saturating_mul(fragment);
    let available_bytes = important
        .unwrap_or_else(|| (stat.f_bavail as u64).saturating_mul(fragment))
        .min(total_bytes);
    Some(DiskSpace {
        total_bytes,
        available_bytes,
    })
}

#[cfg(not(unix))]
fn disk_space(_path: &Path) -> Option<DiskSpace> {
    None
}

async fn library_footprint(pool: &sqlx::SqlitePool) -> Result<LibraryFootprint, CommandError> {
    let row: (i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
            COUNT(*),
            COALESCE(SUM(size), 0),
            COALESCE(SUM(CASE WHEN kind = 'photo' THEN size ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN kind = 'video' THEN size ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN kind = 'raw' THEN size ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN kind = 'video' AND size >= ?1 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN kind = 'video' AND size >= ?1 THEN size ELSE 0 END), 0)
         FROM media_items",
    )
    .bind(LARGE_VIDEO_BYTES)
    .fetch_one(pool)
    .await?;
    let positive = |value: i64| value.max(0) as u64;
    Ok(LibraryFootprint {
        total_items: positive(row.0),
        total_bytes: positive(row.1),
        photo_bytes: positive(row.2),
        video_bytes: positive(row.3),
        raw_bytes: positive(row.4),
        large_video_count: positive(row.5),
        large_video_bytes: positive(row.6),
    })
}

/// Disk space, the photo library's footprint and recent cleanup runs — the
/// context the Cleanup screen shows above the scan results.
#[tauri::command]
pub async fn get_cleanup_overview(
    catalog: State<'_, crate::Catalog>,
) -> Result<CleanupOverview, CommandError> {
    let pool = catalog.pool()?;
    let home = home_dir()?;
    let disk = tokio::task::spawn_blocking(move || disk_space(&home))
        .await
        .map_err(|error| CommandError::internal(format!("Disk check failed: {error}")))?;
    let library = library_footprint(&pool).await?;
    let rows: Vec<(i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT finished_at, removed_items, moved_bytes, failed_items
         FROM cleanup_runs ORDER BY id DESC LIMIT 5",
    )
    .fetch_all(&pool)
    .await?;
    let history = rows
        .into_iter()
        .map(|(finished_at, removed, moved, failed)| CleanupRun {
            finished_at,
            removed_items: removed.max(0) as u64,
            moved_bytes: moved.max(0) as u64,
            failed_items: failed.max(0) as u64,
        })
        .collect();
    Ok(CleanupOverview {
        disk,
        personal_folders: personal_folders_enabled(&pool).await?,
        library,
        history,
    })
}

/// Turn scanning of Documents, Desktop and Downloads on or off. macOS asks
/// for access to each of them the first time they are read.
#[tauri::command]
pub async fn set_cleanup_personal_folders(
    catalog: State<'_, crate::Catalog>,
    enabled: bool,
) -> Result<(), CommandError> {
    let pool = catalog.pool()?;
    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .bind(PERSONAL_SETTING)
        .bind(if enabled { "1" } else { "0" })
        .execute(&pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempHome(PathBuf);

    impl TempHome {
        fn new(label: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("visto-junk-{label}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("Downloads")).unwrap();
            // Canonical, so ids built from it match what the scan reports
            // (`/var` vs `/private/var` on macOS).
            Self(dir.canonicalize().unwrap())
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, relative: &str, bytes: usize) -> PathBuf {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, vec![1u8; bytes]).unwrap();
            path
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct Fixture {
        running: HashSet<String>,
        ignored: HashSet<String>,
        protected: Vec<PathBuf>,
        git: Option<PathBuf>,
        personal_folders: bool,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                running: HashSet::new(),
                ignored: HashSet::new(),
                protected: Vec::new(),
                git: None,
                personal_folders: true,
            }
        }

        fn env<'a>(&'a self, home: &'a TempHome) -> ScanEnv<'a> {
            ScanEnv {
                home: home.path(),
                protected: &self.protected,
                running: Some(&self.running),
                ignored: &self.ignored,
                git: self.git.as_deref(),
                deadline: None,
                personal_folders: self.personal_folders,
            }
        }
    }

    fn on_disk(paths: &[&PathBuf]) -> u64 {
        paths
            .iter()
            .map(|path| physical(&std::fs::metadata(path).unwrap()).0)
            .sum()
    }

    fn age(path: &Path, by: Duration) {
        let when = filetime::FileTime::from_system_time(SystemTime::now() - by);
        filetime::set_file_mtime(path, when).unwrap();
    }

    const OLD: Duration = Duration::from_secs(2 * 60 * 60);

    fn scan(env: &ScanEnv, category: JunkCategory) -> JunkCategoryReport {
        scan_category(env, category)
    }

    #[test]
    fn static_items_report_allocated_bytes_and_group_targets() {
        let home = TempHome::new("static");
        let a = home.write("Library/Developer/Xcode/DerivedData/a/build.o", 40);
        let b = home.write("Library/Developer/Xcode/DerivedData/b/build.o", 9000);
        let c = home.write("Library/Developer/Xcode/iOS DeviceSupport/17.0/symbols", 25);
        let d = home.write(
            "Library/Developer/Xcode/watchOS DeviceSupport/10.0/symbols",
            15,
        );
        let fixture = Fixture::new();

        let report = scan(&fixture.env(&home), JunkCategory::Xcode);
        assert_eq!(report.status, ScanStatus::Complete);
        let derived = report
            .items
            .iter()
            .find(|item| item.id == "xcode-derived-data")
            .expect("DerivedData is offered");
        assert_eq!(derived.file_count, 2);
        assert_eq!(derived.bytes, on_disk(&[&a, &b]));
        assert!(derived.bytes >= 9000, "allocated, not logical, bytes");
        assert_eq!(derived.tier, JunkTier::Regenerable);
        let support = report
            .items
            .iter()
            .find(|item| item.id == "xcode-device-support")
            .expect("device support is offered");
        assert_eq!(support.bytes, on_disk(&[&c, &d]));
        assert_eq!(report.total_bytes, derived.bytes + support.bytes);
    }

    #[cfg(unix)]
    #[test]
    fn hard_links_shared_outside_an_item_free_nothing() {
        let home = TempHome::new("links");
        let store = home.write("Library/pnpm/store/v3/files/aa", 8192);
        let inside = home.write("Library/Caches/Yarn/inside-a", 8192);
        std::fs::hard_link(&inside, home.path().join("Library/Caches/Yarn/inside-b")).unwrap();
        std::fs::create_dir_all(home.path().join("elsewhere")).unwrap();
        std::fs::hard_link(&store, home.path().join("elsewhere/linked")).unwrap();
        let fixture = Fixture::new();

        let report = scan(&fixture.env(&home), JunkCategory::Packages);
        let pnpm = report
            .items
            .iter()
            .find(|item| item.id == "pnpm-store")
            .unwrap();
        assert_eq!(pnpm.bytes, 0);
        assert_eq!(pnpm.shared_bytes, on_disk(&[&store]));
        let yarn = report
            .items
            .iter()
            .find(|item| item.id == "yarn-cache")
            .unwrap();
        assert_eq!(
            yarn.bytes,
            on_disk(&[&inside]),
            "both links inside: counted once"
        );
        assert_eq!(yarn.shared_bytes, 0);
    }

    #[test]
    fn empty_folders_are_not_offered() {
        let home = TempHome::new("empty");
        std::fs::create_dir_all(home.path().join("Library/Developer/Xcode/DerivedData")).unwrap();
        let fixture = Fixture::new();
        let report = scan(&fixture.env(&home), JunkCategory::Xcode);
        assert!(report.items.is_empty() && report.skips.is_empty());
        assert_eq!(report.total_bytes, 0);
    }

    #[test]
    fn a_running_tool_turns_its_rules_into_skips() {
        let home = TempHome::new("busy");
        home.write("Library/Developer/Xcode/DerivedData/a/build.o", 40);
        home.write(".npm/_cacache/index", 40);
        let mut fixture = Fixture::new();
        fixture.running.insert("xcodebuild".to_string());

        let xcode = scan(&fixture.env(&home), JunkCategory::Xcode);
        assert!(xcode.items.is_empty());
        assert_eq!(xcode.skips.len(), 1);
        assert_eq!(xcode.skips[0].reason, SkipReason::AppRunning);
        assert_eq!(xcode.skips[0].message, "xcodebuild is running");
        assert!(
            xcode.skips[0].bytes > 0,
            "the skip still says what it holds"
        );

        let env = fixture.env(&home);
        let (plan, failed) = plan_clean(&env, &["xcode-derived-data".to_string()]);
        assert!(plan.is_empty());
        assert!(failed[0].message.contains("xcodebuild is running"));

        let packages = scan(&env, JunkCategory::Packages);
        assert_eq!(packages.items.len(), 1, "npm is not busy");
    }

    #[test]
    fn an_unknown_process_list_fails_closed() {
        let home = TempHome::new("no-ps");
        home.write("Library/Developer/Xcode/DerivedData/a/build.o", 40);
        let fixture = Fixture::new();
        let mut env = fixture.env(&home);
        env.running = None;
        let report = scan(&env, JunkCategory::Xcode);
        assert!(report.items.is_empty());
        assert_eq!(report.skips[0].reason, SkipReason::AppRunning);
    }

    #[test]
    fn never_clean_is_honoured_at_scan_and_at_clean() {
        let home = TempHome::new("ignored");
        home.write("Library/Caches/Homebrew/bottle.tar.gz", 40);
        let mut fixture = Fixture::new();
        fixture.ignored.insert("homebrew-cache".to_string());
        let env = fixture.env(&home);

        let report = scan(&env, JunkCategory::Packages);
        assert!(report.items.is_empty());
        assert_eq!(report.skips[0].reason, SkipReason::NeverClean);

        let (plan, failed) = plan_clean(&env, &["homebrew-cache".to_string()]);
        assert!(plan.is_empty());
        assert!(failed[0].message.contains("Never clean"));
        assert!(
            resolve_selection(&env, "homebrew-cache", false).is_ok(),
            "reveal still works"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_folder_is_partial_not_empty() {
        use std::os::unix::fs::PermissionsExt;
        let home = TempHome::new("unreadable");
        home.write("Library/Caches/Homebrew/ok", 40);
        let locked = home.path().join("Library/Caches/Homebrew/locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("secret"), b"x").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let fixture = Fixture::new();

        let report = scan(&fixture.env(&home), JunkCategory::Packages);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Root ignores permissions; only assert when the lock took effect.
        if report.status == ScanStatus::Complete {
            return;
        }
        assert_eq!(report.status, ScanStatus::Partial);
        assert!(report.status_message.unwrap().contains("could not be read"));
        assert_eq!(report.items.len(), 1);
    }

    #[test]
    fn project_artifacts_need_their_manifest() {
        let home = TempHome::new("manifest");
        home.write("Code/web/package.json", 2);
        let modules = home.write("Code/web/node_modules/pkg/index.js", 20);
        home.write("Code/rust/Cargo.toml", 2);
        let target = home.write("Code/rust/target/debug/app", 20);
        // No manifests: an ordinary folder that happens to be called target.
        home.write("Code/notes/target/plan.txt", 20);
        // A venv without pyvenv.cfg is not a virtual environment.
        home.write("Code/py/requirements.txt", 2);
        home.write("Code/py/venv/lib/x.py", 20);
        for path in [&modules, &target] {
            age(path, OLD);
        }
        let fixture = Fixture::new();

        let report = scan(&fixture.env(&home), JunkCategory::Projects);
        let mut labels: Vec<&str> = report
            .items
            .iter()
            .map(|item| item.label.as_str())
            .collect();
        labels.sort();
        assert_eq!(labels, ["rust/target", "web/node_modules"]);
        assert!(report
            .items
            .iter()
            .all(|item| item.tier == JunkTier::Rebuildable));
        let web = report
            .items
            .iter()
            .find(|item| item.label == "web/node_modules")
            .unwrap();
        assert!(web.detail.contains("npm"));
    }

    #[test]
    fn recently_changed_or_sensitive_artifacts_are_skipped() {
        let home = TempHome::new("recent");
        home.write("Projects/live/package.json", 2);
        home.write("Projects/live/node_modules/.vite/deps", 20);
        home.write("Projects/keys/package.json", 2);
        let key = home.write("Projects/keys/node_modules/id_ed25519", 20);
        age(&key, OLD);
        home.write("Projects/nested/package.json", 2);
        let nested = home.write("Projects/nested/node_modules/dep/.git/HEAD", 20);
        age(&nested, OLD);
        let fixture = Fixture::new();

        let report = scan(&fixture.env(&home), JunkCategory::Projects);
        assert!(report.items.is_empty(), "{:?}", report.items);
        let reason = |label: &str| {
            report
                .skips
                .iter()
                .find(|skip| skip.label == label)
                .map(|skip| skip.reason)
        };
        assert_eq!(
            reason("live/node_modules"),
            Some(SkipReason::RecentActivity)
        );
        assert_eq!(reason("keys/node_modules"), Some(SkipReason::Sensitive));
        assert_eq!(reason("nested/node_modules"), Some(SkipReason::Sensitive));
    }

    #[test]
    fn a_repository_without_git_available_is_skipped() {
        let home = TempHome::new("nogit");
        std::fs::create_dir_all(home.path().join("Code/app/.git")).unwrap();
        home.write("Code/app/package.json", 2);
        let file = home.write("Code/app/node_modules/pkg/index.js", 20);
        age(&file, OLD);
        let fixture = Fixture::new();

        let report = scan(&fixture.env(&home), JunkCategory::Projects);
        assert!(report.items.is_empty());
        assert_eq!(report.skips[0].reason, SkipReason::GitTracked);
    }

    #[test]
    fn git_tracked_artifacts_are_refused_and_ignored_ones_offered() {
        let Some(git) = find_git() else {
            return;
        };
        let home = TempHome::new("git");
        let run = |dir: &Path, args: &[&str]| {
            let status = Command::new(&git)
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        };
        let tracked = home.path().join("Code/tracked");
        home.write("Code/tracked/package.json", 2);
        let fixture_file = home.write("Code/tracked/node_modules/fixture.js", 20);
        run(&tracked, &["init", "-q"]);
        run(
            &tracked,
            &["add", "-f", "package.json", "node_modules/fixture.js"],
        );
        run(&tracked, &["commit", "-qm", "init"]);
        age(&fixture_file, OLD);

        let ignored = home.path().join("Code/ignored");
        home.write("Code/ignored/package.json", 2);
        home.write("Code/ignored/.gitignore", 0);
        std::fs::write(ignored.join(".gitignore"), "node_modules\n").unwrap();
        let dep = home.write("Code/ignored/node_modules/dep/index.js", 20);
        run(&ignored, &["init", "-q"]);
        run(&ignored, &["add", "."]);
        run(&ignored, &["commit", "-qm", "init"]);
        age(&dep, OLD);

        let mut fixture = Fixture::new();
        fixture.git = Some(git.clone());
        let report = scan(&fixture.env(&home), JunkCategory::Projects);
        assert_eq!(
            report.items.len(),
            1,
            "{:?} {:?}",
            report.items,
            report.skips
        );
        assert_eq!(report.items[0].label, "ignored/node_modules");
        assert_eq!(report.skips.len(), 1);
        assert_eq!(report.skips[0].reason, SkipReason::GitTracked);
    }

    #[test]
    fn scan_skips_protected_library_roots() {
        let home = TempHome::new("protected");
        home.write("Documents/Photos/package.json", 2);
        let a = home.write("Documents/Photos/node_modules/pkg/index.js", 10);
        home.write("Documents/App/package.json", 2);
        let b = home.write("Documents/App/node_modules/pkg/index.js", 20);
        age(&a, OLD);
        age(&b, OLD);
        let mut fixture = Fixture::new();
        fixture.protected = vec![home.path().join("Documents/Photos")];

        let report = scan(&fixture.env(&home), JunkCategory::Projects);
        assert_eq!(
            report.items.len(),
            1,
            "only the non-library project is listed"
        );
        assert!(report.items[0].path.contains("Documents/App"));
    }

    #[test]
    fn stale_installers_are_offered_and_recent_ones_are_not() {
        let home = TempHome::new("downloads");
        let old = home.write("Downloads/old.dmg", 30);
        age(&old, INSTALLER_MIN_AGE + Duration::from_secs(60));
        let xip = home.write("Downloads/Xcode.xip", 30);
        age(&xip, INSTALLER_MIN_AGE + Duration::from_secs(60));
        home.write("Downloads/new.dmg", 10);
        home.write("Downloads/notes.txt", 5);
        let fixture = Fixture::new();

        let report = scan(&fixture.env(&home), JunkCategory::Downloads);
        let mut labels: Vec<&str> = report
            .items
            .iter()
            .map(|item| item.label.as_str())
            .collect();
        labels.sort();
        assert_eq!(labels, ["Xcode.xip", "old.dmg"]);
        assert!(report.items[0].detail.contains("days ago"));
    }

    #[test]
    fn cleaning_rejects_paths_outside_the_allowlist() {
        let home = TempHome::new("reject");
        let victim = home.write("Documents/secret/notes.txt", 10);
        home.write("Documents/notes/target/plan.txt", 10);
        let fixture = Fixture::new();
        let env = fixture.env(&home);

        for id in [
            "projects:/etc/node_modules".to_string(),
            "projects:/tmp/node_modules".to_string(),
            format!("downloads:{}", victim.to_string_lossy()),
            format!(
                "projects:{}",
                home.path().join("Documents").to_string_lossy()
            ),
            format!(
                "projects:{}",
                home.path().join("Documents/notes/target").to_string_lossy()
            ),
            format!(
                "projects:{}/Documents/x/../secret",
                home.path().to_string_lossy()
            ),
            "unknown:whatever".to_string(),
            "npm-cache-typo".to_string(),
        ] {
            let (plan, failed) = plan_clean(&env, std::slice::from_ref(&id));
            assert!(plan.is_empty(), "{id} must not resolve");
            assert_eq!(failed.len(), 1);
        }
    }

    #[test]
    fn cleaning_rejects_a_library_source_even_when_the_id_is_valid() {
        let home = TempHome::new("library");
        home.write("Documents/Photos/package.json", 2);
        let node_modules = home.path().join("Documents/Photos/node_modules");
        home.write("Documents/Photos/node_modules/pkg/index.js", 1);
        let mut fixture = Fixture::new();
        fixture.protected = vec![home.path().join("Documents/Photos")];
        let id = format!("projects:{}", node_modules.to_string_lossy());

        let (plan, failed) = plan_clean(&fixture.env(&home), &[id]);
        assert!(plan.is_empty());
        assert!(failed[0].message.contains("library source"));
    }

    #[test]
    fn cleaning_resolves_a_valid_artifact_and_installer() {
        let home = TempHome::new("valid");
        home.write("Documents/App/package.json", 2);
        let node_modules = home.path().join("Documents/App/node_modules");
        let file = home.write("Documents/App/node_modules/pkg/index.js", 12);
        age(&file, OLD);
        let installer = home.write("Downloads/old.pkg", 40);
        age(&installer, INSTALLER_MIN_AGE + Duration::from_secs(60));
        let fixture = Fixture::new();

        let ids = vec![
            format!("projects:{}", node_modules.to_string_lossy()),
            format!("downloads:{}", installer.to_string_lossy()),
            format!("downloads:{}", installer.to_string_lossy()),
        ];
        let (plan, failed) = plan_clean(&fixture.env(&home), &ids);
        assert!(
            failed.is_empty(),
            "{:?}",
            failed.iter().map(|f| &f.message).collect::<Vec<_>>()
        );
        assert_eq!(plan.len(), 2, "duplicates collapse");
        assert_eq!(
            plan.iter().map(|entry| entry.bytes).sum::<u64>(),
            on_disk(&[&file, &installer])
        );
    }

    #[test]
    fn a_fresh_installer_is_rejected_on_a_stale_row() {
        let home = TempHome::new("fresh-row");
        let installer = home.write("Downloads/fresh.dmg", 40);
        let id = format!("downloads:{}", installer.to_string_lossy());
        let fixture = Fixture::new();
        let (plan, failed) = plan_clean(&fixture.env(&home), &[id]);
        assert!(plan.is_empty());
        assert!(failed[0].message.contains("newer than 30 days"));
    }

    #[test]
    fn personal_folders_stay_unread_until_turned_on() {
        let home = TempHome::new("personal");
        home.write("Documents/App/package.json", 2);
        let doc = home.write("Documents/App/node_modules/pkg/index.js", 20);
        home.write("Code/Tool/package.json", 2);
        let code = home.write("Code/Tool/node_modules/pkg/index.js", 20);
        let installer = home.write("Downloads/old.dmg", 30);
        for path in [&doc, &code] {
            age(path, OLD);
        }
        age(&installer, INSTALLER_MIN_AGE + Duration::from_secs(60));
        let mut fixture = Fixture::new();
        fixture.personal_folders = false;
        let env = fixture.env(&home);

        let projects = scan(&env, JunkCategory::Projects);
        let labels: Vec<&str> = projects
            .items
            .iter()
            .map(|item| item.label.as_str())
            .collect();
        assert_eq!(labels, ["Tool/node_modules"]);

        let downloads = scan(&env, JunkCategory::Downloads);
        assert_eq!(downloads.status, ScanStatus::Off);
        assert!(downloads.items.is_empty());

        // Rows from an earlier scan with the switch on are refused now.
        let ids = vec![
            format!(
                "projects:{}",
                home.path()
                    .join("Documents/App/node_modules")
                    .to_string_lossy()
            ),
            format!("downloads:{}", installer.to_string_lossy()),
        ];
        let (plan, failed) = plan_clean(&env, &ids);
        assert!(plan.is_empty());
        assert_eq!(failed.len(), 2);
    }

    #[test]
    fn the_project_walk_never_enters_a_library_folder() {
        let home = TempHome::new("walk-library");
        // A project nested inside the library would only be found by walking it.
        home.write("Code/Photos/2024/shoot/package.json", 2);
        let file = home.write("Code/Photos/2024/shoot/node_modules/x.js", 20);
        age(&file, OLD);
        let mut fixture = Fixture::new();
        fixture.protected = vec![home.path().join("Code/Photos")];
        let report = scan(&fixture.env(&home), JunkCategory::Projects);
        assert!(report.items.is_empty() && report.skips.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn disk_space_reports_a_sane_volume() {
        let disk = disk_space(Path::new("/")).expect("the boot volume has a size");
        assert!(disk.total_bytes > 0);
        assert!(disk.available_bytes <= disk.total_bytes);
        assert!(
            important_available_bytes(Path::new("/")).is_some(),
            "Foundation reports important-usage capacity for the boot volume"
        );
    }

    /// Every deletion must go through the Trash sink. A direct unlink in the
    /// cleanup code (outside these tests) fails the build's test run.
    #[test]
    fn cleanup_code_never_deletes_directly() {
        let source = include_str!("junk.rs");
        let code = &source[..source.find("#[cfg(test)]\nmod tests").unwrap()];
        for sink in ["fs::remove_file", "fs::remove_dir", "remove_dir_all"] {
            assert!(
                !code.contains(sink),
                "junk.rs must not call {sink}; use the Trash"
            );
        }
    }

    #[test]
    fn only_known_shapes_can_be_marked_never_clean() {
        assert!(is_ignorable_id("xcode-derived-data"));
        assert!(is_ignorable_id("projects:/Users/me/Code/app/node_modules"));
        assert!(is_ignorable_id("downloads:/Users/me/Downloads/a.dmg"));
        assert!(!is_ignorable_id("projects:relative/node_modules"));
        assert!(!is_ignorable_id("other:/x"));
        assert!(!is_ignorable_id("xcode-derived-data-typo"));
        assert!(!is_ignorable_id("projects:/x\n/y"));
    }

    #[tokio::test]
    async fn history_and_ignore_tables_round_trip() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        for _ in 0..(HISTORY_LIMIT + 3) {
            record_run(
                &pool,
                &JunkCleanResult {
                    removed_items: 2,
                    moved_bytes: 10,
                    failed: vec![],
                },
            )
            .await
            .unwrap();
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cleanup_runs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, HISTORY_LIMIT);
        assert!(ignored_ids(&pool).await.unwrap().is_empty());
        let footprint = library_footprint(&pool).await.unwrap();
        assert_eq!(footprint.total_items, 0);
    }
}
