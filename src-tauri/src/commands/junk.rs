//! System and developer junk that lives outside the photo library.
//!
//! The Cleanup screen answers four questions, in this order of importance:
//!
//! 1. **Protection** — what is never offered, whatever the input. Only the
//!    fixed rules in `cleanup_rules.json`, the build artifacts listed there
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

mod rules;

use rules::{artifact_named, static_junk, Artifact, StaticJunk};

/// Old installers in Downloads have to be at least this old to be offered.
pub(crate) const INSTALLER_MIN_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Extensions treated as installers. Archives (`.zip`, `.tar.gz`) are left
/// alone: they are as likely to be a document as a download.
const INSTALLER_EXTENSIONS: &[&str] = &["dmg", "pkg", "mpkg", "iso", "xip"];
/// How deep below a project folder build artifacts are looked for.
const PROJECT_SCAN_DEPTH: usize = 6;
/// Top-level home folders that are never walked for projects: system and
/// media folders, VM and container mounts, and SDK or tool homes whose
/// contents look like projects but are not the user's.
const HOME_SKIP: &[&str] = &[
    "Library",
    "Applications",
    "Pictures",
    "Movies",
    "Music",
    "Public",
    "OrbStack",
    "Parallels",
    "VirtualBox VMs",
    "Virtual Machines.localized",
    "go",
    "opt",
    "flutter",
    "miniconda3",
    "anaconda3",
    "miniforge3",
];
/// Cloud-sync folders. Walking them can make the provider fetch files.
const CLOUD_PREFIXES: &[&str] = &[
    "Dropbox",
    "Google Drive",
    "OneDrive",
    "iCloud",
    "Creative Cloud Files",
    "Box Sync",
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
/// Re-checking a selection before trashing stops after this long; anything
/// not re-checked in time is refused rather than trashed unverified.
const CLEAN_BUDGET: Duration = Duration::from_secs(60);
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
    /// Further folders this row covers besides `path` (a rule with several
    /// targets, such as device support for each platform). The size and the
    /// cleanup include them all.
    pub extra_paths: Vec<String>,
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
    /// Neutral information about the list, such as a cap on how many rows
    /// are shown.
    pub note: Option<String>,
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
            // `.pem`/`.key` only at the item's top level: packages inside
            // node_modules ship test certificates by the hundred.
            let top_level_key =
                entry.depth() == 1 && (name.ends_with(".pem") || name.ends_with(".key"));
            if KEY_FILE_NAMES.contains(&name) || name.starts_with("deploy_key") || top_level_key {
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
fn busy_reason<S: AsRef<str>>(env: &ScanEnv, names: &[S]) -> Option<String> {
    if names.is_empty() {
        return None;
    }
    let Some(running) = env.running else {
        return Some("Running apps could not be checked".to_string());
    };
    names
        .iter()
        .map(AsRef::as_ref)
        .find(|name| running.contains(*name))
        .map(|name| format!("{name} is running"))
}

/// Package managers and build tools whose script-running subcommands do not
/// touch their download cache, so a long-running `npm run dev` or `cargo run`
/// does not block cleaning the npm cache or the Cargo registry.
const SCRIPT_RUNNERS: &[&str] = &["npm", "yarn", "pnpm", "bun", "cargo"];
const SCRIPT_SUBCOMMANDS: &[&str] = &[
    "run",
    "run-script",
    "start",
    "test",
    "dev",
    "serve",
    "preview",
    "watch",
];

fn base_name(token: &str) -> Option<&str> {
    token.rsplit('/').next().filter(|name| !name.is_empty())
}

/// Process names from `ps -o pid=,comm=` and `ps -o pid=,args=` output: each
/// executable's file name plus the file names of its first two arguments, so
/// `npm` (which sets its process title) and scripts like `brew.sh` are both
/// recognised. Script runners running a script are left out entirely.
fn names_from_ps(comm: &str, args: &str) -> HashSet<String> {
    let split = |line: &str| -> Option<(String, String)> {
        let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
        Some((pid.to_string(), rest.trim().to_string()))
    };
    let by_pid: HashMap<String, String> = args.lines().filter_map(split).collect();

    let mut names = HashSet::new();
    for (pid, exe) in comm.lines().filter_map(split) {
        let Some(exe_name) = base_name(&exe) else {
            continue;
        };
        let arguments = by_pid.get(&pid).map(String::as_str).unwrap_or("");
        let mut tokens = arguments.split_whitespace();
        let first = tokens.next().and_then(base_name);
        let second = tokens.next();
        let runner = [Some(exe_name), first]
            .into_iter()
            .flatten()
            .any(|name| SCRIPT_RUNNERS.contains(&name));
        if runner && second.is_some_and(|sub| SCRIPT_SUBCOMMANDS.contains(&sub)) {
            continue;
        }
        names.insert(exe_name.to_string());
        if let Some(first) = first {
            names.insert(first.to_string());
        }
        if let Some(second) = second
            .filter(|token| !token.starts_with('-'))
            .and_then(base_name)
        {
            names.insert(second.to_string());
        }
    }
    names
}

/// Names of running processes, or `None` when `ps` fails.
pub(crate) fn running_processes() -> Option<HashSet<String>> {
    let run = |format: &str| {
        Command::new("/bin/ps")
            .args(["-axww", "-o", format])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
    };
    let comm = run("pid=,comm=")?;
    let args = run("pid=,args=").unwrap_or_default();
    Some(names_from_ps(&comm, &args))
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
    let Ok(entries) = std::fs::read_dir(home) else {
        return Vec::new();
    };
    let home_device = device_of(home);
    let mut roots: Vec<PathBuf> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            // `file_type` does not follow symlinks, so a linked folder is never
            // a root and cannot pull another tree into the walk.
            if !entry.file_type().ok()?.is_dir() || !is_project_root_name(&name, personal_folders) {
                return None;
            }
            let path = entry.path();
            // A different device is a mount (OrbStack, a network share).
            if home_device.is_some() && device_of(&path) != home_device {
                return None;
            }
            Some(path)
        })
        .collect();
    roots.sort();
    roots
}

/// Whether a top-level home folder may hold the user's projects.
fn is_project_root_name(name: &str, personal_folders: bool) -> bool {
    if name.starts_with('.') || HOME_SKIP.contains(&name) {
        return false;
    }
    if name == "Box" || CLOUD_PREFIXES.iter().any(|prefix| name.starts_with(prefix)) {
        return false;
    }
    personal_folders || !PERSONAL_ROOTS.contains(&name)
}

#[cfg(unix)]
fn device_of(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path)
        .ok()
        .map(|metadata| metadata.dev())
}

#[cfg(not(unix))]
fn device_of(_path: &Path) -> Option<u64> {
    None
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
    if let Some(marker) = artifact.marker.as_deref() {
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
    allow_in_use: bool,
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
    // "In use" is the one class the user can override per item, and only
    // explicitly: a folder that changed minutes ago, or one whose tool is
    // running. Everything below still runs, so a Git-tracked or sensitive
    // folder stays refused even when the user forces the row.
    if !allow_in_use {
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
        if let Some(reason) = busy_reason(env, &artifact.busy_if) {
            return Err((SkipReason::AppRunning, reason, part));
        }
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
    note: Option<String>,
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
            note: self.note,
            items: self.items,
            skips: self.skips,
            total_bytes,
            scanned_at: now_ms(),
        }
    }
}

/// Keep the `limit` largest items (already sorted) and say so when some were
/// left out, so a long list is never silently shortened.
fn cap(items: &mut Vec<JunkItem>, limit: usize, out: &mut Collector) {
    if items.len() > limit {
        out.note = Some(format!(
            "Showing the {limit} largest of {} found. Clean some and rescan to see the rest.",
            items.len()
        ));
        items.truncate(limit);
    }
}

/// Existing targets of a static rule and their combined stats. A protected
/// target is dropped from the scan (it is never shown at all).
fn static_targets(env: &ScanEnv, def: &StaticJunk) -> (Vec<PathBuf>, Stats) {
    let mut total = Stats::default();
    let mut paths = Vec::new();
    for target in &def.targets {
        let path = env.home.join(target);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {}
            // A denied ancestor hides the target; that is "could not read",
            // not "nothing there".
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                total.unreadable += 1;
                continue;
            }
            _ => continue,
        }
        if is_protected(&path, env.protected) {
            continue;
        }
        let part = stats(&path, env.deadline);
        // A walk cut short proves nothing about emptiness: keep the target so
        // the caller sees `timed_out` instead of "already empty".
        if part.files == 0 && part.unreadable == 0 && !part.timed_out {
            continue;
        }
        total.add(part);
        paths.push(path);
    }
    (paths, total)
}

fn scan_static(env: &ScanEnv, category: JunkCategory, out: &mut Collector) {
    for def in static_junk().iter().filter(|def| def.category == category) {
        let (paths, total) = static_targets(env, def);
        out.timed_out |= total.timed_out;
        if !env.ignored.contains(&def.key) {
            out.unreadable += total.unreadable;
        }
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
        if env.ignored.contains(&def.key) {
            skip(
                SkipReason::NeverClean,
                "You marked this Never clean".to_string(),
                out,
            );
            continue;
        }
        if total.files == 0 {
            skip(
                SkipReason::Unreadable,
                "This folder could not be read".to_string(),
                out,
            );
            continue;
        }
        if let Some(reason) = busy_reason(env, &def.busy_if) {
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
            extra_paths: paths[1..]
                .iter()
                .map(|extra| extra.to_string_lossy().into_owned())
                .collect(),
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
                match assess_artifact(env, path, artifact, &root, false) {
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
                            extra_paths: Vec::new(),
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
    cap(&mut items, MAX_PROJECT_ITEMS, out);
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
            extra_paths: Vec::new(),
        });
    }
    items.sort_by_key(|item: &JunkItem| std::cmp::Reverse(item.bytes));
    cap(&mut items, MAX_DOWNLOAD_ITEMS, out);
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
/// `forced` holds the ids the user explicitly chose to clean even though the
/// scan reported them as in use. It only unlocks the busy and recent-activity
/// checks; structural refusals (allowlist, library roots, Git, keys, Never
/// clean) stay in force.
///
/// Invalid ids become failures instead of aborting the run, so one stale row
/// cannot block the rest of the cleanup.
fn plan_clean(
    env: &ScanEnv,
    ids: &[String],
    forced: &HashSet<String>,
) -> (Vec<CleanPlanEntry>, Vec<JunkFailure>) {
    let mut plan = Vec::new();
    let mut failed = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            continue;
        }
        match resolve_selection(env, id, true, forced.contains(id)) {
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
const UNVERIFIED: &str =
    "Ran out of time re-checking this item, so it was left alone. Clean it on its own.";

/// Re-validate one id. With `strict`, every pre-flight check applies (busy
/// tools, Never clean, Git, recent activity); without it only the structural
/// checks do, which is what revealing an item in Finder needs. With
/// `allow_in_use`, the two "in use" refusals are waived because the user
/// picked the item out by name.
fn resolve_selection(
    env: &ScanEnv,
    id: &str,
    strict: bool,
    allow_in_use: bool,
) -> Result<CleanPlanEntry, String> {
    if strict && env.ignored.contains(id) {
        return Err("You marked this Never clean.".to_string());
    }
    if let Some(def) = static_junk().iter().find(|def| def.key == id) {
        for target in &def.targets {
            let path = env.home.join(target);
            if path.exists() && is_protected(&path, env.protected) {
                return Err(LIBRARY_REFUSAL.to_string());
            }
        }
        if strict && !allow_in_use {
            if let Some(reason) = busy_reason(env, &def.busy_if) {
                return Err(format!("{reason} — quit it and try again."));
            }
        }
        let (paths, total) = static_targets(env, def);
        if strict && total.timed_out {
            return Err(UNVERIFIED.to_string());
        }
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
                let part = assess_artifact(env, &path, artifact, &root, allow_in_use)
                    .map_err(|(_, message, _)| format!("{message}."))?;
                // A walk cut short may have missed a nested repository or a
                // key; that item is refused, never trashed unverified.
                if part.timed_out {
                    return Err(UNVERIFIED.to_string());
                }
                part
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
    if static_junk().iter().any(|def| def.key == id) {
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
        let entry =
            resolve_selection(&owned.env(None), &id, false, false).map_err(CommandError::path)?;
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

/// True when `path` no longer exists (it was moved to the Trash). Any other
/// error counts as still present: it is never claimed as moved unverified.
fn is_gone(path: &Path) -> bool {
    matches!(
        std::fs::symlink_metadata(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}

/// Trash every planned entry and report exactly what moved.
///
/// Finder processes a `delete {a, b, c}` list in order and stops at the
/// first item it refuses, so a failed call may still have moved some items.
/// After a failure the disk is checked: entries whose folders are all gone
/// are counted as moved, and the rest are retried in halves until the refused
/// entry is alone and reported with Finder's message. A result is never
/// claimed without checking the disk.
fn trash_entries<F>(plan: Vec<CleanPlanEntry>, trash: F) -> (Vec<CleanPlanEntry>, Vec<JunkFailure>)
where
    F: Fn(&[String]) -> Result<(), CommandError>,
{
    let mut moved = Vec::new();
    let mut failed = Vec::new();
    let mut pending = vec![plan];
    while let Some(part) = pending.pop() {
        if part.is_empty() {
            continue;
        }
        let paths: Vec<String> = part
            .iter()
            .flat_map(|entry| entry.paths.iter())
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let error = match trash(&paths) {
            Ok(()) => {
                moved.extend(part);
                continue;
            }
            Err(error) => error,
        };
        let size = part.len();
        let mut remaining = Vec::new();
        for mut entry in part {
            entry.paths.retain(|path| !is_gone(path));
            if entry.paths.is_empty() {
                moved.push(entry);
            } else {
                remaining.push(entry);
            }
        }
        match remaining.len() {
            0 => {}
            // Alone (or the only one left after the rest moved): this is the
            // entry Finder refused.
            1 if size == 1 || remaining.len() < size => {
                let entry = remaining.pop().expect("one entry");
                failed.push(JunkFailure {
                    id: entry.id,
                    message: format!("Could not move to the Trash: {}", error.message.trim()),
                });
            }
            _ => {
                let back = remaining.split_off(remaining.len() / 2);
                pending.push(back);
                pending.push(remaining);
            }
        }
    }
    (moved, failed)
}

/// Move the selected junk to the Trash. Every id is re-validated first, and
/// the run is recorded in the cleanup history.
///
/// `force` lists the ids the user chose to clean despite their being in use.
/// It cannot widen what may be cleaned: the allowlist, library roots, Git,
/// private keys and the Never clean list are still checked.
#[tauri::command]
pub async fn clean_junk(
    catalog: State<'_, crate::Catalog>,
    items: Vec<String>,
    force: Vec<String>,
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
        let env = owned.env(Some(Instant::now() + CLEAN_BUDGET));
        let forced: HashSet<String> = force.into_iter().collect();
        let (plan, mut failed) = plan_clean(&env, &items, &forced);
        let (moved, refused) = trash_entries(plan, super::media::trash_external_paths);
        failed.extend(refused);
        JunkCleanResult {
            removed_items: moved.len() as u64,
            moved_bytes: moved.iter().map(|entry| entry.bytes).sum(),
            failed,
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
mod tests;
