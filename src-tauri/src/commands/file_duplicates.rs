//! Duplicate detection across every file type inside one folder.
//!
//! Deliberately separate from `duplicates`: this scan never reads or writes
//! `media_items`. Paths, sizes and content hashes live in memory for the
//! lifetime of the scan (and until the next one replaces them), so pointing it
//! at Documents or a project folder cannot grow the catalog or leave hashes
//! behind for files the gallery does not manage.
//!
//! A folder picked in Finder can hold hundreds of gigabytes and hundreds of
//! thousands of files, so every stage is bounded rather than open-ended:
//!
//! 1. The walk stops at `MAX_WALKED_FILES` and says so.
//! 2. Only files whose size matches another file are ever opened, so a folder
//!    of unique files costs stat calls and nothing else.
//! 3. The candidate list, and the bytes it may hash, are capped too; a folder
//!    that exceeds them reports a short scan instead of running for an hour.
//! 4. Hard links are counted once: two links to the same inode free nothing
//!    when one is trashed.
//!
//! Every stage is cancellable through the same flag as the media scan, so
//! Cancel works during a walk, a fingerprint batch, or a multi-gigabyte hash.

use super::{
    FileDuplicateGroup, FileDuplicateItem, FileDuplicateScan, FileDuplicateTrashResult, TrashError,
};
use crate::errors::{CommandError, ErrorCode};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, State, Window};
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;

/// Above this many files one scan stops walking and reports a partial result.
/// 200k paths of strings is about 30 MB -- bounded, unlike a home folder.
const MAX_WALKED_FILES: u64 = 200_000;
/// Files that share a size are the only ones worth opening; past this many the
/// scan compares the first N and says it did.
const MAX_CANDIDATES: usize = 12_000;
/// Total bytes one scan may read for full hashes.
const MAX_HASH_BYTES: u64 = 40 * 1024 * 1024 * 1024;
/// Files per blocking fingerprint task.
const FINGERPRINT_BATCH: usize = 64;
/// Paths per Finder Trash call.
const TRASH_BATCH: usize = 200;

/// Folders whose contents are never worth comparing, even inside a folder the
/// user picked: they hold caches and installs, not their own files.
const SKIP_DIR_NAMES: &[&str] = &["node_modules", "Library"];
/// Directory extensions macOS treats as a single package.
const PACKAGE_EXTENSIONS: &[&str] = &[
    "app",
    "bundle",
    "framework",
    "photoslibrary",
    "playground",
    "rtfd",
    "xcworkspace",
    "xcodeproj",
];

/// What the last any-file scan found, kept in memory only.
///
/// The renderer sends back the ids it was shown; resolving them here means a
/// compromised webview cannot ask the backend to trash an arbitrary path, and
/// the ids die with the process.
#[derive(Default)]
pub(crate) struct FileDuplicateSession {
    scope: String,
    /// Item id -> path, for the rows the user can currently see.
    items: HashMap<String, String>,
}

impl FileDuplicateSession {
    fn replace(&mut self, scope: String, items: HashMap<String, String>) {
        self.scope = scope;
        self.items = items;
    }

    fn remove(&mut self, id: &str) {
        self.items.remove(id);
    }

    /// Resolve a row id to its path and the folder that was scanned. Trashing
    /// and revealing both go through this, so the renderer never supplies a
    /// path and the two commands cannot drift apart.
    fn target(&self, id: &str) -> Result<(String, String), CommandError> {
        self.items
            .get(id)
            .map(|path| (path.clone(), self.scope.clone()))
            .ok_or_else(|| {
                CommandError::not_found(
                    "That file is no longer part of the last scan. Scan the folder again.",
                )
            })
    }
}

/// Native folder picker for an any-file scan. The folder does not have to be a
/// library source: this scan reads it in memory and never imports it, so the
/// picker can point anywhere the user chooses. The pick is granted for the
/// session, like every other folder the app is allowed to open.
#[tauri::command]
pub async fn choose_file_duplicate_folder(
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
) -> Result<Option<String>, CommandError> {
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Choose a folder to compare every file type in")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| CommandError::new(ErrorCode::Dialog, error.to_string()))?;
    let canonical = path.canonicalize().unwrap_or(path);
    state.grants.grant([&canonical]);
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

/// Show one file from the last any-file scan in Finder.
///
/// The renderer sends a scan id, never a path: the path is resolved from the
/// in-memory session and re-validated, so a compromised webview cannot ask
/// Finder to reveal an arbitrary file.
#[tauri::command]
pub async fn reveal_file_duplicate(
    state: State<'_, crate::AppState>,
    id: String,
) -> Result<(), CommandError> {
    let (path, scope) = {
        let session = state
            .file_duplicates
            .lock()
            .map_err(|_| CommandError::internal("The last file scan is unavailable."))?;
        session.target(&id)?
    };
    // Same boundary as trashing: a regular file, still inside the scanned
    // folder, never a symlink.
    validate_trash_target(&path, &scope)?;
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|error| CommandError::io(format!("Could not show {path} in Finder: {error}")))?;
    Ok(())
}

/// Compare every regular file inside `scope`, keeping the hashes in memory.
#[tauri::command]
pub async fn find_file_duplicates(
    state: State<'_, crate::AppState>,
    window: Window,
    scope: String,
) -> Result<FileDuplicateScan, CommandError> {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
        return Err(CommandError::invalid(
            "Choose a folder to compare files in.".to_string(),
        ));
    }
    let root = PathBuf::from(trimmed);
    let metadata = std::fs::symlink_metadata(&root)
        .map_err(|_| CommandError::not_found("That folder is no longer on disk."))?;
    if !metadata.is_dir() {
        return Err(CommandError::invalid(
            "Only folders can be compared for duplicate files.".to_string(),
        ));
    }
    let trimmed_scope = root.to_string_lossy().trim_end_matches('/').to_string();
    // "/" is its own case: trimming a root path leaves nothing.
    let scope_path = if trimmed_scope.is_empty() {
        "/".to_string()
    } else {
        trimmed_scope
    };

    let cancel = state.duplicate_cancel.start();
    let flag = cancel.flag();

    let _ = window.emit(
        "file-duplicates-progress",
        json!({
            "phase": "walking",
            "processed": 0,
            "total": 0,
            "currentFile": "Listing files…",
        }),
    );

    // Pass 1: every regular file once, with its size. Nothing is opened yet.
    let walk_root = PathBuf::from(&scope_path);
    let walk_flag = Arc::clone(&flag);
    let (files, walk_stopped) =
        tokio::task::spawn_blocking(move || walk_scope(&walk_root, walk_flag.as_ref()))
            .await
            .map_err(|error| {
                CommandError::internal(format!("Listing the folder failed: {error}"))
            })?;
    let files_scanned = files.len() as u64;

    if cancel.is_cancelled() {
        remember(&state, &scope_path, HashMap::new());
        return Ok(FileDuplicateScan {
            scope: scope_path,
            groups: Vec::new(),
            files_scanned,
            files_compared: 0,
            bytes_hashed: 0,
            stopped_early: walk_stopped,
            cancelled: true,
        });
    }

    // Only files that share a size with another file can be exact copies, so
    // a folder of unique files is never read at all.
    let mut size_counts: HashMap<u64, u32> = HashMap::new();
    for (_, size) in &files {
        *size_counts.entry(*size).or_default() += 1;
    }
    let mut candidates: Vec<(String, u64)> = files
        .iter()
        .filter(|(_, size)| size_counts.get(size).copied().unwrap_or(0) > 1)
        .cloned()
        .collect();
    drop(files);

    let mut stopped_early = walk_stopped;
    if candidates.len() > MAX_CANDIDATES {
        candidates.truncate(MAX_CANDIDATES);
        stopped_early = Some(format!(
            "Only the first {MAX_CANDIDATES} files that share a size with another file were compared. Pick a smaller folder for a complete scan."
        ));
    }
    // Bound the reading too: thousands of video-sized files would otherwise be
    // hours of hashing behind a Cancel the user has to find first.
    let mut running = 0u64;
    let mut over_budget = None;
    for (index, (_, size)) in candidates.iter().enumerate() {
        if running.saturating_add(*size) > MAX_HASH_BYTES {
            over_budget = Some(index);
            break;
        }
        running = running.saturating_add(*size);
    }
    if let Some(cutoff) = over_budget {
        candidates.truncate(cutoff);
        stopped_early = Some(format!(
            "The files that share a size add up to more than {} GB, so the comparison stopped there. Pick a smaller folder for a complete scan.",
            MAX_HASH_BYTES / (1024 * 1024 * 1024)
        ));
    }

    let total_candidates = candidates.len();

    // Phase 2: a 64 KiB fingerprint per candidate. This already dismisses
    // almost every same-size pair, and costs 64 KiB per file.
    let _ = window.emit(
        "file-duplicates-progress",
        json!({
            "phase": "hashing",
            "processed": 0,
            "total": total_candidates,
            "currentFile": "Comparing file headers…",
        }),
    );

    let mut fingerprints: Vec<(usize, String)> = Vec::with_capacity(total_candidates);
    for (batch, chunk) in candidates.chunks(FINGERPRINT_BATCH).enumerate() {
        if cancel.is_cancelled() {
            break;
        }
        let paths: Vec<(usize, String, u64)> = chunk
            .iter()
            .enumerate()
            .map(|(offset, (path, size))| (batch * FINGERPRINT_BATCH + offset, path.clone(), *size))
            .collect();
        let batch_flag = Arc::clone(&flag);
        let found = tokio::task::spawn_blocking(move || {
            paths
                .into_iter()
                .filter_map(|(index, path, size)| {
                    quick_fingerprint(&path, size, batch_flag.as_ref()).map(|fp| (index, fp))
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|error| {
            CommandError::internal(format!("Comparing file headers failed: {error}"))
        })?;
        fingerprints.extend(found);

        let _ = window.emit(
            "file-duplicates-progress",
            json!({
                "phase": "hashing",
                "processed": fingerprints.len(),
                "total": total_candidates,
                "currentFile": "Comparing file headers…",
            }),
        );
        tokio::task::yield_now().await;
    }

    let mut by_fingerprint: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, fingerprint) in fingerprints {
        by_fingerprint.entry(fingerprint).or_default().push(index);
    }

    // Phase 3: full SHA-256, only for files that still match after the header.
    let mut to_hash: Vec<usize> = by_fingerprint
        .into_values()
        .filter(|indices| indices.len() > 1)
        .flatten()
        .collect();
    to_hash.sort_unstable();
    let files_compared = to_hash.len() as u64;

    let _ = window.emit(
        "file-duplicates-progress",
        json!({
            "phase": "hashing",
            "processed": 0,
            "total": to_hash.len(),
            "currentFile": "Comparing full contents…",
        }),
    );

    let mut hashes: HashMap<usize, String> = HashMap::new();
    let mut bytes_hashed = 0u64;
    let mut last_emit = std::time::Instant::now();
    for (position, index) in to_hash.iter().enumerate() {
        if cancel.is_cancelled() {
            break;
        }
        let path = candidates[*index].0.clone();
        let hash_flag = Arc::clone(&flag);
        let result = tokio::task::spawn_blocking(move || hash_file(&path, hash_flag.as_ref()))
            .await
            .ok()
            .flatten();
        if let Some((hash, bytes)) = result {
            bytes_hashed = bytes_hashed.saturating_add(bytes);
            hashes.insert(*index, hash);
        }

        if position + 1 == to_hash.len()
            || last_emit.elapsed() >= std::time::Duration::from_millis(250)
        {
            let _ = window.emit(
                "file-duplicates-progress",
                json!({
                    "phase": "hashing",
                    "processed": position + 1,
                    "total": to_hash.len(),
                    "currentFile": candidates[*index].0,
                    "bytesProcessed": bytes_hashed,
                }),
            );
            last_emit = std::time::Instant::now();
        }
        tokio::task::yield_now().await;
    }

    // Group by content, in memory. Nothing is written anywhere.
    let mut by_hash: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, hash) in hashes {
        by_hash.entry(hash).or_default().push(index);
    }

    let mut groups: Vec<FileDuplicateGroup> = Vec::new();
    let mut session_items: HashMap<String, String> = HashMap::new();
    for (hash, mut indices) in by_hash {
        if indices.len() < 2 {
            continue;
        }
        // Keeper name preference first, then the shallowest path: an original
        // nested a level deeper still beats a "copy" sitting at the root.
        indices.sort_by(|a, b| compare_keeper_paths(&candidates[*a].0, &candidates[*b].0));
        let size = candidates[indices[0]].1 as i64;
        let items: Vec<FileDuplicateItem> = indices
            .iter()
            .enumerate()
            .map(|(position, index)| {
                let (path, size) = &candidates[*index];
                let id = format!("{hash}:{index}");
                session_items.insert(id.clone(), path.clone());
                let name = path.rsplit('/').next().unwrap_or(path).to_string();
                FileDuplicateItem {
                    extension: name
                        .rsplit_once('.')
                        .map(|(_, extension)| extension.to_lowercase())
                        .unwrap_or_default(),
                    id,
                    path: path.clone(),
                    name,
                    size: *size as i64,
                    keeper: position == 0,
                }
            })
            .collect();
        groups.push(FileDuplicateGroup {
            id: hash,
            size,
            items,
        });
    }

    // Largest reclaimable group first, like the media scan.
    groups.sort_by(|a, b| {
        let saving = |group: &FileDuplicateGroup| {
            group
                .size
                .saturating_mul((group.items.len() as i64 - 1).max(0))
        };
        saving(b).cmp(&saving(a))
    });

    remember(&state, &scope_path, session_items);

    Ok(FileDuplicateScan {
        scope: scope_path,
        groups,
        files_scanned,
        files_compared,
        bytes_hashed,
        stopped_early,
        cancelled: cancel.is_cancelled(),
    })
}

fn remember(state: &State<'_, crate::AppState>, scope: &str, items: HashMap<String, String>) {
    if let Ok(mut session) = state.file_duplicates.lock() {
        session.replace(scope.to_string(), items);
    }
}

/// Move the files the last scan produced to the Finder Trash.
///
/// The renderer sends ids from that scan, not paths; each id is resolved back
/// to a path that must still be inside the scanned folder and still be a
/// regular file. Ids are dropped once trashed, so a stale click cannot move a
/// second copy of something already gone.
#[tauri::command]
pub async fn trash_file_duplicates(
    state: State<'_, crate::AppState>,
    catalog: State<'_, crate::Catalog>,
    window: Window,
    ids: Vec<String>,
) -> Result<FileDuplicateTrashResult, CommandError> {
    let mut seen = HashSet::new();
    let requested: Vec<String> = ids
        .into_iter()
        .filter(|id| !id.is_empty())
        .filter(|id| seen.insert(id.clone()))
        .collect();
    if requested.is_empty() {
        return Ok(FileDuplicateTrashResult {
            trashed: Vec::new(),
            failed: Vec::new(),
        });
    }

    let mut failed: Vec<TrashError> = Vec::new();
    let mut targets: Vec<(String, String)> = Vec::new();
    let scope = {
        let session = state
            .file_duplicates
            .lock()
            .map_err(|_| CommandError::internal("The last file scan is unavailable."))?;
        for id in requested {
            match session.target(&id) {
                Ok((path, _)) => targets.push((id, path)),
                Err(error) => failed.push(TrashError {
                    id,
                    code: error.code,
                    error: error.message,
                }),
            }
        }
        session.scope.clone()
    };

    let mut eligible: Vec<(String, String)> = Vec::new();
    for (id, path) in targets {
        match validate_trash_target(&path, &scope) {
            Ok(()) => eligible.push((id, path)),
            Err(error) => failed.push(TrashError {
                id,
                code: error.code,
                error: error.message,
            }),
        }
    }

    let mut trashed: Vec<String> = Vec::new();
    for chunk in eligible.chunks(TRASH_BATCH) {
        let paths: Vec<PathBuf> = chunk.iter().map(|(_, path)| PathBuf::from(path)).collect();
        let batch_ok = tokio::task::spawn_blocking(move || trash::delete_all(&paths).is_ok())
            .await
            .unwrap_or(false);
        if batch_ok {
            trashed.extend(chunk.iter().map(|(id, _)| id.clone()));
            continue;
        }
        // One file in the batch refused, so retry them individually to report
        // exactly which ones stayed. `delete_all` stops at the first failure,
        // so a path that is already gone was moved by the batch and is not a
        // failure.
        for (id, path) in chunk {
            let target = PathBuf::from(path);
            let attempt = target.clone();
            let moved = tokio::task::spawn_blocking(move || {
                trash::delete(&attempt).is_ok() || !attempt.exists()
            })
            .await
            .unwrap_or(false);
            if moved {
                trashed.push(id.clone());
            } else {
                failed.push(TrashError {
                    id: id.clone(),
                    code: ErrorCode::Io,
                    error: "Finder could not move this file to Trash.".to_string(),
                });
            }
        }
    }

    if let Ok(mut session) = state.file_duplicates.lock() {
        for id in &trashed {
            session.remove(id);
        }
    }

    // A photo or video in the folder is also a catalog row. Removing its file
    // has to remove the row too, or Library keeps showing a file that is gone.
    // The files are already in the Trash, so a catalog failure is not reported
    // as a trash failure; the next scan of the source prunes the row.
    if !trashed.is_empty() {
        let path_by_id: HashMap<&str, &str> = eligible
            .iter()
            .map(|(id, path)| (id.as_str(), path.as_str()))
            .collect();
        let paths: Vec<String> = trashed
            .iter()
            .filter_map(|id| path_by_id.get(id.as_str()).map(|path| path.to_string()))
            .collect();
        if let Ok(db) = super::get_db(&catalog) {
            if let Ok(item_ids) = remove_catalog_rows(&db, &paths).await {
                if !item_ids.is_empty() {
                    let _ = window.emit(
                        "library-changed",
                        json!({ "type": "removed", "itemIds": item_ids }),
                    );
                }
            }
        }
    }

    Ok(FileDuplicateTrashResult { trashed, failed })
}

/// Delete the catalog rows for files an any-file scan just trashed, returning
/// their ids for `library-changed`. Files that were never in the catalog are
/// simply not found.
async fn remove_catalog_rows(
    db: &sqlx::SqlitePool,
    paths: &[String],
) -> Result<Vec<String>, CommandError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut builder =
        sqlx::QueryBuilder::<sqlx::Sqlite>::new("SELECT id FROM media_items WHERE path IN (");
    let mut values = builder.separated(", ");
    for path in paths {
        values.push_bind(path);
    }
    values.push_unseparated(")");
    let ids = builder
        .build_query_scalar::<String>()
        .fetch_all(db)
        .await
        .map_err(|error| {
            CommandError::database(format!(
                "could not match trashed files to catalog rows: {error}"
            ))
        })?;
    if ids.is_empty() {
        return Ok(ids);
    }
    let backups = super::media::remove_trashed_rows(db, &ids).await?;
    super::media::remove_edit_backup_files(&backups);
    Ok(ids)
}

/// A path may be trashed only while it is still inside the scanned folder and
/// still a regular file, never a symlink.
fn validate_trash_target(path: &str, scope: &str) -> Result<(), CommandError> {
    if !path_is_inside(path, scope) {
        return Err(CommandError::path(
            "That file is outside the folder that was scanned.".to_string(),
        ));
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| CommandError::not_found("File no longer exists on disk."))?;
    if metadata.file_type().is_symlink() {
        return Err(CommandError::invalid(
            "Refusing to move a symbolic link to Trash.".to_string(),
        ));
    }
    if !metadata.is_file() {
        return Err(CommandError::invalid(
            "Only regular files can be moved to Trash.".to_string(),
        ));
    }
    Ok(())
}

/// Boundary-safe containment: `/shoot/` covers `/shoot/a.jpg` but not
/// `/shoot-2024/a.jpg`.
fn path_is_inside(path: &str, scope: &str) -> bool {
    let scope = scope.trim_end_matches('/');
    if scope.is_empty() {
        return path.starts_with('/');
    }
    path.strip_prefix(scope)
        .is_some_and(|rest| rest.starts_with('/'))
}

/// The reason a walk stops once it has counted `walked` files. Always reports,
/// never silently samples: a truncated list has to say so.
fn walk_stop_reason(walked: usize) -> Option<String> {
    (walked as u64 >= MAX_WALKED_FILES).then(|| {
        format!(
            "Stopped after {MAX_WALKED_FILES} files, so this scan is not complete. Pick a smaller folder to compare all of it."
        )
    })
}

/// Every regular file under `root`, with its size, subject to the walk limits.
///
/// Hidden entries, packages and `node_modules` are skipped: they are not the
/// user's files to compare, and walking them turns a folder scan into a disk
/// scan. Hard links are listed once each — trashing one link frees nothing.
fn walk_scope(root: &Path, cancel: &AtomicBool) -> (Vec<(String, u64)>, Option<String>) {
    let mut files: Vec<(String, u64)> = Vec::new();
    let mut seen_files: HashSet<(u64, u64)> = HashSet::new();
    let mut stopped: Option<String> = None;

    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(is_walkable);

    for entry in walker {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let size = metadata.len();
        // Empty files are identical to each other and reclaim nothing.
        if size == 0 {
            continue;
        }
        if let Some(identity) = file_identity(&metadata) {
            if !seen_files.insert(identity) {
                continue;
            }
        }
        if let Some(reason) = walk_stop_reason(files.len()) {
            stopped = Some(reason);
            break;
        }
        files.push((entry.path().to_string_lossy().into_owned(), size));
    }

    (files, stopped)
}

/// Whether the walk may enter this entry. The root itself is always allowed,
/// even when it is a hidden folder the user deliberately picked.
fn is_walkable(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    if name.starts_with('.') {
        return false;
    }
    if entry.file_type().is_dir() {
        if SKIP_DIR_NAMES
            .iter()
            .any(|skip| name.eq_ignore_ascii_case(skip))
        {
            return false;
        }
        if let Some(extension) = entry.path().extension().and_then(|ext| ext.to_str()) {
            if PACKAGE_EXTENSIONS
                .iter()
                .any(|package| extension.eq_ignore_ascii_case(package))
            {
                return false;
            }
        }
    }
    true
}

#[cfg(unix)]
fn file_identity(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_identity(_metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

/// First 64 KiB plus the size: enough to dismiss a same-size pair without
/// reading either file to the end.
fn quick_fingerprint(path: &str, size: u64, cancel: &AtomicBool) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 64 * 1024];
    let read = file.read(&mut buf).ok()?;
    if read == 0 || cancel.load(Ordering::SeqCst) {
        return None;
    }
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    ctx.update(&buf[..read]);
    ctx.update(&size.to_le_bytes());
    Some(hex::encode(ctx.finish().as_ref()))
}

/// Full SHA-256 of one file, checked against Cancel between blocks so a huge
/// file can still be abandoned.
fn hash_file(path: &str, cancel: &AtomicBool) -> Option<(String, u64)> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 512 * 1024];
    let mut bytes = 0u64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return None;
        }
        let read = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => return None,
        };
        ctx.update(&buf[..read]);
        bytes = bytes.saturating_add(read as u64);
    }
    Some((hex::encode(ctx.finish().as_ref()), bytes))
}

/// Compare two filenames for keeper preference.
/// 1. Prefer names without a " copy" suffix (e.g., "file.jp2" over "file copy 2.jp2" or "file copy.jp2")
/// 2. Then prefer shorter names
/// 3. Then alphabetical
fn compare_keeper_name(a: &str, b: &str) -> std::cmp::Ordering {
    // macOS Finder names the first duplicate as "name copy.ext" and subsequent ones
    // as "name copy N.ext". Check for both patterns.
    let a_has_copy = a.contains(" copy ") || a.contains(" copy.");
    let b_has_copy = b.contains(" copy ") || b.contains(" copy.");
    match (a_has_copy, b_has_copy) {
        (false, true) => std::cmp::Ordering::Less,
        (true, false) => std::cmp::Ordering::Greater,
        _ => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
    }
}

/// Keeper order inside one duplicate group: a name without a copy suffix
/// wins outright, then the file closest to the folder root breaks ties.
fn compare_keeper_paths(a: &str, b: &str) -> std::cmp::Ordering {
    let name_a = a.rsplit('/').next().unwrap_or(a);
    let name_b = b.rsplit('/').next().unwrap_or(b);
    compare_keeper_name(name_a, name_b)
        .then_with(|| a.matches('/').count().cmp(&b.matches('/').count()))
}

#[cfg(test)]
mod tests {
    use super::{
        compare_keeper_name, compare_keeper_paths, is_walkable, path_is_inside,
        remove_catalog_rows, validate_trash_target, walk_scope, walk_stop_reason, MAX_WALKED_FILES,
    };
    use std::sync::atomic::AtomicBool;
    use walkdir::WalkDir;

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "visto-file-duplicates-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create scratch folder");
        path
    }

    fn write(path: &std::path::Path, contents: &[u8]) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        std::fs::write(path, contents).expect("write file");
    }

    #[test]
    fn the_walk_skips_hidden_packages_and_developer_folders() {
        let root = scratch_dir("walk");
        write(&root.join("shoot/a.jpg"), b"aaaa");
        write(&root.join("shoot/sub/b.jpg"), b"aaaa");
        write(&root.join("shoot/.DS_Store"), b"x");
        write(&root.join("shoot/.hidden/c.jpg"), b"aaaa");
        write(&root.join("shoot/node_modules/d.js"), b"aaaa");
        write(&root.join("shoot/App.app/Contents/e"), b"aaaa");
        write(&root.join("shoot/empty.txt"), b"");

        let cancel = AtomicBool::new(false);
        let prefix = root.to_string_lossy().into_owned();
        let mut files: Vec<String> = walk_scope(&root, &cancel)
            .0
            .into_iter()
            .map(|(path, _)| path.trim_start_matches(&prefix).to_string())
            .collect();
        files.sort();

        assert_eq!(files, ["/shoot/a.jpg", "/shoot/sub/b.jpg"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_root_itself_is_always_walked() {
        let root = scratch_dir("root");
        write(&root.join("file.txt"), b"content");

        let entries: Vec<walkdir::DirEntry> = WalkDir::new(&root)
            .into_iter()
            .filter_entry(is_walkable)
            .filter_map(Result::ok)
            .collect();
        // Root plus the file it holds; a hidden root would otherwise prune
        // everything the user asked for.
        assert_eq!(entries.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn containment_stops_at_the_folder_boundary() {
        assert!(path_is_inside("/shoots/rain/a.jpg", "/shoots/rain"));
        assert!(path_is_inside("/shoots/rain/sub/b.jpg", "/shoots/rain/"));
        assert!(!path_is_inside("/shoots/rain-2024/a.jpg", "/shoots/rain"));
        assert!(!path_is_inside("/shoots/rainbow/a.jpg", "/shoots/rain"));
        assert!(path_is_inside("/tmp/a", "/"));
    }

    #[test]
    fn cancel_stops_the_walk() {
        let root = scratch_dir("cancel");
        write(&root.join("a.bin"), b"aaaa");
        let cancel = AtomicBool::new(true);
        assert!(walk_scope(&root, &cancel).0.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_walk_limit_is_reported_rather_than_silently_sampled() {
        // The limit is far too large to fill in a test, so exercise the check
        // itself plus the complete-walk case it must stay quiet for.
        assert_eq!(walk_stop_reason(MAX_WALKED_FILES as usize - 1), None);
        let reason = walk_stop_reason(MAX_WALKED_FILES as usize).expect("limit message");
        assert!(reason.contains(&MAX_WALKED_FILES.to_string()));

        let root = scratch_dir("limit");
        write(&root.join("a.bin"), b"aaaa");
        assert_eq!(walk_scope(&root, &AtomicBool::new(false)).1, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn keeper_name_prefers_original_over_copy_suffix() {
        // "sample1.jp2" should be preferred over "sample1 copy 2.jp2"
        assert_eq!(
            compare_keeper_name("sample1.jp2", "sample1 copy 2.jp2"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_keeper_name("sample1 copy 2.jp2", "sample1.jp2"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn keeper_name_prefers_shorter_when_both_have_or_lack_copy() {
        // Neither has " copy " -> shorter wins
        assert_eq!(
            compare_keeper_name("a.jpg", "aa.jpg"),
            std::cmp::Ordering::Less
        );
        // Both have " copy " -> shorter wins
        assert_eq!(
            compare_keeper_name("a copy 2.jpg", "aa copy 3.jpg"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn keeper_name_falls_back_to_alphabetical() {
        // Same length, neither has " copy "
        assert_eq!(
            compare_keeper_name("a.jpg", "b.jpg"),
            std::cmp::Ordering::Less
        );
        // Same length, both have " copy "
        assert_eq!(
            compare_keeper_name("a copy 2.jpg", "b copy 2.jpg"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn keeper_name_beats_depth_within_a_group() {
        // An original one folder down still beats a "copy" at the root.
        assert_eq!(
            compare_keeper_paths("/shoot/session/a.jpg", "/shoot/a copy.jpg"),
            std::cmp::Ordering::Less
        );
        // Same name: the copy nearer the root is the one to keep.
        assert_eq!(
            compare_keeper_paths("/shoot/b.jpg", "/shoot/session/b.jpg"),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn keeper_name_catches_finder_copy_suffix() {
        // macOS Finder names first duplicate as "name copy.ext"
        assert_eq!(
            compare_keeper_name("file.jp2", "file copy.jp2"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_keeper_name("file copy.jp2", "file.jp2"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn trash_targets_must_be_regular_files_inside_the_scope() {
        let root = scratch_dir("trash-targets");
        let file = root.join("a.jpg");
        write(&file, b"aaaa");
        let scope = root.to_string_lossy();

        assert!(validate_trash_target(file.to_str().expect("utf-8 path"), &scope).is_ok());
        // A file outside the folder that was scanned.
        assert!(validate_trash_target("/etc/hosts", &scope).is_err());

        // A package or folder is not a file...
        let folder = root.join("sub");
        std::fs::create_dir_all(&folder).expect("create folder");
        assert!(validate_trash_target(folder.to_str().expect("utf-8 path"), &scope).is_err());

        // ...and a symlink is never followed, even inside the scope.
        #[cfg(unix)]
        {
            let link = root.join("link.jpg");
            std::os::unix::fs::symlink(&file, &link).expect("create symlink");
            assert!(validate_trash_target(link.to_str().expect("utf-8 path"), &scope).is_err());
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn only_catalogued_trashed_paths_leave_the_catalog() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory catalog");
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create media table");
        sqlx::query("CREATE TABLE edit_backups (media_id TEXT, backup_path TEXT)")
            .execute(&db)
            .await
            .expect("create edit backups table");
        for (id, path) in [
            ("a", "/shoot/a.jpg"),
            ("b", "/shoot/b.jpg"),
            ("c", "/other/c.jpg"),
        ] {
            sqlx::query("INSERT INTO media_items (id, path) VALUES (?, ?)")
                .bind(id)
                .bind(path)
                .execute(&db)
                .await
                .expect("insert media row");
        }

        let removed = remove_catalog_rows(&db, &["/shoot/a.jpg".to_string()])
            .await
            .expect("remove matched rows");
        assert_eq!(removed, ["a"]);

        let left: Vec<String> = sqlx::query_scalar("SELECT id FROM media_items ORDER BY id")
            .fetch_all(&db)
            .await
            .expect("read remaining rows");
        assert_eq!(left, ["b", "c"]);
    }
}
