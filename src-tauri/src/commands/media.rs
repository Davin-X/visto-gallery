use super::*;
use crate::errors::CommandError;
use image::{DynamicImage, ImageEncoder};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State, Window};

/// Resolve catalog ids to their on-disk paths.
///
/// The renderer never supplies a path to `move_to_trash`; it supplies ids.
/// That makes the operation independent of however many rows the UI happens
/// to have paged into memory, and it means a compromised webview cannot ask
/// the backend to trash an arbitrary file.
async fn catalog_paths_by_id(
    db: &sqlx::SqlitePool,
    ids: &[String],
) -> Result<HashMap<String, String>, CommandError> {
    let mut found = HashMap::new();
    // Keep the IN list below SQLite's default parameter limit.
    for chunk in ids.chunks(400) {
        let mut query = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT id, path FROM media_items WHERE id IN (",
        );
        {
            let mut separated = query.separated(", ");
            for id in chunk {
                separated.push_bind(id);
            }
        }
        query.push(")");
        let rows: Vec<(String, String)> = query
            .build_query_as::<(String, String)>()
            .fetch_all(db)
            .await?;
        found.extend(rows);
    }
    Ok(found)
}

/// Decide whether a single path may be moved to Trash.
///
/// A path is eligible only when it is a regular file (never a symlink) and it
/// is either a catalog row or canonically inside one of the registered library
/// folders. This stops a renderer bug or a compromised webview from trashing
/// arbitrary user files through a single IPC call.
fn validate_trash_path(
    path: &str,
    cataloged: &HashSet<String>,
    registered: &[String],
) -> Result<(), CommandError> {
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
    if cataloged.contains(path) {
        return Ok(());
    }
    if registered.is_empty() {
        return Err(CommandError::path(
            "File is not in the catalog and no library folders are registered.".to_string(),
        ));
    }
    if is_path_under_registered_roots(path, registered) {
        Ok(())
    } else {
        Err(CommandError::path(
            "Path is outside registered library folders and not in the catalog.".to_string(),
        ))
    }
}

/// Resolve requested catalog ids into validated `(id, path)` targets.
///
/// This is deliberately independent of any UI page: the renderer sends ids,
/// and the database is the single source of truth for paths. Rejected ids are
/// returned as failures instead of being silently dropped, so the UI can
/// explain exactly what did not happen.
async fn resolve_trash_targets(
    db: &sqlx::SqlitePool,
    ids: Vec<String>,
    registered: &[String],
) -> Result<(Vec<(String, String)>, Vec<TrashError>), CommandError> {
    // De-duplicate ids while preserving caller order.
    let mut seen = HashSet::new();
    let requested: Vec<String> = ids
        .into_iter()
        .filter(|id| !id.is_empty())
        .filter(|id| seen.insert(id.clone()))
        .collect();
    if requested.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }

    let resolved = catalog_paths_by_id(db, &requested).await?;

    let mut failed = Vec::new();
    let cataloged: HashSet<String> = resolved.values().cloned().collect();
    let mut targets: Vec<(String, String)> = Vec::with_capacity(requested.len());
    for id in requested {
        let Some(path) = resolved.get(&id) else {
            failed.push(TrashError {
                id,
                code: ErrorCode::NotFound,
                error: "Item is no longer in the catalog.".to_string(),
            });
            continue;
        };
        match validate_trash_path(path, &cataloged, registered) {
            Ok(()) => targets.push((id, path.clone())),
            Err(error) => failed.push(TrashError {
                id,
                code: error.code,
                error: error.message,
            }),
        }
    }
    Ok((targets, failed))
}

/// The OS-level Trash operation, behind a trait so tests can drive the whole
/// flow without moving real user files.
trait TrashSink: Send + Sync {
    /// Trashes multiple paths in a single OS operation where possible.
    /// On macOS this is one AppleScript `tell Finder delete` call per batch —
    /// Finder's native Trash supports "Put Back" and a single invocation
    /// avoids per-file deletion sounds.
    fn delete_all(&self, paths: &[String]) -> Result<(), CommandError>;
}

struct OsTrash;

impl OsTrash {
    fn new() -> Self {
        Self
    }
}

#[cfg(target_os = "macos")]
fn escape_applescript_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// AppleScript reports a refused Automation permission as `-1743`
/// (errAEEventNotPermitted) or with one of these messages. Nothing has moved at
/// that point, so it is safe to retry the batch through a non-AppleScript path.
#[cfg(target_os = "macos")]
fn is_apple_events_denied(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    message.contains("-1743")
        || lower.contains("not authorized to send apple events")
        || lower.contains("not allowed to send apple events")
}

#[cfg(target_os = "macos")]
fn trash_via_finder(paths: &[String]) -> Result<(), CommandError> {
    // One osascript call tells Finder to delete every path in this batch.
    // Finder's native Trash supports "Put Back", and batching many paths in
    // one AppleScript invocation means one sound for the whole batch instead
    // of one sound per file.
    let items: Vec<String> = paths
        .iter()
        .map(|p| format!("POSIX file \"{}\"", escape_applescript_string(p)))
        .collect();
    let script = format!(
        "tell application \"Finder\"\ndelete {{{}}}\nend tell",
        items.join(", ")
    );

    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| CommandError::internal(format!("osascript failed: {}", e)))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(CommandError::internal(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn trash_via_finder(_paths: &[String]) -> Result<(), CommandError> {
    Err(CommandError::internal(
        "Finder trash is only available on macOS.".to_string(),
    ))
}

impl TrashSink for OsTrash {
    fn delete_all(&self, paths: &[String]) -> Result<(), CommandError> {
        #[cfg(target_os = "macos")]
        {
            match trash_via_finder(paths) {
                Ok(()) => Ok(()),
                // Finder Automation is a TCC permission the user can refuse, and
                // it is the only path that supports "Put Back". Falling back to
                // NSFileManager keeps deleting working instead of failing every
                // batch (and the per-file retry) with a permission error.
                Err(error) if is_apple_events_denied(&error.message) => {
                    eprintln!(
                        "Finder automation is unavailable ({}); trashing with NSFileManager instead.",
                        error.message.trim()
                    );
                    trash::delete_all(paths).map_err(CommandError::from)
                }
                Err(error) => Err(error),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            trash::delete_all(paths).map_err(CommandError::from)
        }
    }
}

/// Move validated targets to Trash, then remove their catalog rows (and the
/// journaled edit originals that only existed for those rows).
///
/// Files are trashed in batches via one AppleScript `tell Finder delete`
/// call per batch on macOS — Finder's native Trash supports "Put Back" and a
/// single invocation per batch means one sound per batch instead of one per
/// file. The run's own cancel token is checked between batches, so Cancel is
/// responsive without touching other trash operations.
async fn execute_trash<P>(
    db: &sqlx::SqlitePool,
    targets: Vec<(String, String)>,
    sink: Arc<dyn TrashSink>,
    cancel: &super::CancelToken<'_>,
    progress: P,
) -> Result<TrashResult, CommandError>
where
    P: Fn(usize, usize, Option<&str>),
{
    let mut trashed: Vec<String> = Vec::new();
    let mut failed = Vec::new();
    let total = targets.len();
    let mut processed = 0usize;

    // One AppleScript call per batch keeps the sound count low while still
    // allowing Cancel between batches. 50 paths per AppleScript call means
    // Cancel is checked every ~50 files — responsive enough for 4000+ file
    // operations without excessive Finder sounds.
    const TRASH_BATCH: usize = 50;

    for chunk in targets.chunks(TRASH_BATCH) {
        if cancel.is_cancelled() {
            for (id, _) in chunk {
                failed.push(TrashError {
                    id: id.clone(),
                    code: ErrorCode::Cancelled,
                    error: "Operation cancelled".to_string(),
                });
            }
            processed += chunk.len();
            continue;
        }

        progress(
            processed,
            total,
            chunk.first().map(|(_, path)| path.as_str()),
        );

        let batch_sink = Arc::clone(&sink);
        let batch_paths: Vec<String> = chunk.iter().map(|(_, path)| path.clone()).collect();
        let result = tokio::task::spawn_blocking(move || batch_sink.delete_all(&batch_paths)).await;

        match result {
            Ok(Ok(())) => {
                trashed.extend(chunk.iter().map(|(id, _)| id.clone()));
            }
            Ok(Err(_batch_err)) => {
                // Batch failed: try each file individually so partial
                // successes still count and failures are reported per-id.
                for (id, path) in chunk {
                    if cancel.is_cancelled() {
                        failed.push(TrashError {
                            id: id.clone(),
                            code: ErrorCode::Cancelled,
                            error: "Operation cancelled".to_string(),
                        });
                        continue;
                    }
                    let single_sink = Arc::clone(&sink);
                    let single_path = path.clone();
                    match tokio::task::spawn_blocking(move || {
                        single_sink.delete_all(&[single_path])
                    })
                    .await
                    {
                        Ok(Ok(())) => trashed.push(id.clone()),
                        Ok(Err(e)) => failed.push(TrashError {
                            id: id.clone(),
                            code: ErrorCode::Io,
                            error: format!("Could not move to Trash: {}", e),
                        }),
                        Err(e) => failed.push(TrashError {
                            id: id.clone(),
                            code: ErrorCode::Internal,
                            error: format!("Trash task failed: {}", e),
                        }),
                    }
                }
            }
            Err(e) => {
                // The blocking task panicked or was cancelled mid-batch, so we
                // cannot claim any of these files moved. Report every id in the
                // chunk: dropping them would leave rows that the UI believes
                // are still deletable attached to files that may be gone.
                for (id, _) in chunk {
                    failed.push(TrashError {
                        id: id.clone(),
                        code: ErrorCode::Internal,
                        error: format!("Trash task failed: {}", e),
                    });
                }
            }
        }

        processed += chunk.len();
    }

    progress(total, total, None);

    // The files are already in the Trash at this point, so a catalog failure
    // must be reported as a warning rather than an error: returning Err would
    // tell the user the delete failed while their files are gone, and the UI
    // would keep rows that can no longer be trashed.
    let mut catalog_error = None;
    if !trashed.is_empty() {
        match remove_trashed_rows(db, &trashed).await {
            Ok(backup_files) => {
                for backup in backup_files {
                    let _ = std::fs::remove_file(backup);
                }
            }
            Err(error) => catalog_error = Some(error.message),
        }
    }

    Ok(TrashResult {
        trashed,
        failed,
        catalog_error,
    })
}

/// Delete the catalog rows for `trashed` ids in one transaction, returning the
/// journaled edit originals that were attached to them.
async fn remove_trashed_rows(
    db: &sqlx::SqlitePool,
    trashed: &[String],
) -> Result<Vec<String>, CommandError> {
    let mut transaction = db
        .begin()
        .await
        .map_err(|e| CommandError::database(format!("could not update the catalog: {}", e)))?;
    let mut backup_files = Vec::new();
    for id in trashed {
        // Collect journaled originals before the FK cascade removes their rows,
        // so the files do not linger in app data forever.
        let backups: Vec<String> =
            sqlx::query_scalar("SELECT backup_path FROM edit_backups WHERE media_id = ?")
                .bind(id)
                .fetch_all(&mut *transaction)
                .await
                .map_err(|e| {
                    CommandError::database(format!("could not read edit backups: {}", e))
                })?;
        backup_files.extend(backups);

        sqlx::query("DELETE FROM media_items WHERE id = ?")
            .bind(id)
            .execute(&mut *transaction)
            .await
            .map_err(|e| CommandError::database(format!("could not delete catalog row: {}", e)))?;
    }
    transaction.commit().await.map_err(|e| {
        CommandError::database(format!("could not commit the catalog update: {}", e))
    })?;
    Ok(backup_files)
}

#[tauri::command]
pub async fn move_to_trash(
    ids: Vec<String>,
    catalog: State<'_, crate::Catalog>,
    state: State<'_, crate::AppState>,
    window: Window,
) -> Result<TrashResult, CommandError> {
    // Per-invocation flag: a second trash run cannot clear this one's Cancel.
    let cancel = state.trash_cancel.start();

    let db = super::get_db(&catalog)?;
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await?;

    let (targets, mut failed) = resolve_trash_targets(&db, ids, &registered).await?;
    if targets.is_empty() {
        return Ok(TrashResult {
            trashed: Vec::new(),
            failed,
            catalog_error: None,
        });
    }

    let _ = window.emit(
        "import-progress",
        json!({
            "phase": "trashing",
            "processed": 0,
            "total": targets.len(),
        }),
    );

    let outcome = execute_trash(
        &db,
        targets,
        Arc::new(OsTrash::new()),
        &cancel,
        |processed, total, current| {
            let mut payload = json!({
                "phase": "trashing",
                "processed": processed,
                "total": total,
            });
            if let Some(current) = current {
                payload["currentFile"] = json!(current);
            }
            let _ = window.emit("import-progress", payload);
        },
    )
    .await?;

    failed.extend(outcome.failed);

    // Notify the frontend that catalog rows were removed so stats and views
    // refresh (e.g. library counts after trash).
    if !outcome.trashed.is_empty() {
        let _ = window.emit(
            "library-changed",
            serde_json::json!({
                "type": "removed",
                "itemIds": outcome.trashed,
            }),
        );
    }

    Ok(TrashResult {
        trashed: outcome.trashed,
        failed,
        catalog_error: outcome.catalog_error,
    })
}

#[tauri::command]
pub async fn reveal_in_finder(
    path: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    let exists: Option<String> = sqlx::query_scalar("SELECT path FROM media_items WHERE path = ?")
        .bind(&path)
        .fetch_optional(&db)
        .await?;
    if exists.is_none() {
        return Err(CommandError::path(
            "Path is not part of the catalog.".to_string(),
        ));
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| CommandError::io(format!("Could not reveal {}: {}", path, e)))?;
    Ok(())
}

#[tauri::command]
pub async fn open_file(
    path: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    let exists: Option<String> = sqlx::query_scalar("SELECT path FROM media_items WHERE path = ?")
        .bind(&path)
        .fetch_optional(&db)
        .await?;
    if exists.is_none() {
        return Err(CommandError::path(
            "Path is not part of the catalog.".to_string(),
        ));
    }
    std::process::Command::new("open")
        .arg(&path)
        .status()
        .map_err(|e| CommandError::io(format!("Could not open {}: {}", path, e)))?;
    Ok(())
}

/// A desktop video player that can decode containers WebKit cannot (notably
/// Matroska/`.mkv` and `.avi`), exposed to the viewer so unsupported videos can
/// be handed off instead of failing silently.
#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPlayer {
    name: String,
    path: String,
}

/// Apps commonly installed on macOS that play Matroska/AVI. Order is
/// preference, so the first installed app becomes the primary action.
const EXTERNAL_VIDEO_APPS: &[(&str, &str)] = &[
    ("IINA", "IINA.app"),
    ("VLC", "VLC.app"),
    ("Elmedia Video Player", "Elmedia Video Player.app"),
    ("Infuse", "Infuse.app"),
    ("mpv", "mpv.app"),
    ("QuickTime Player", "QuickTime Player.app"),
];

fn playable_app_locations(app: &str) -> Vec<PathBuf> {
    let mut locations = vec![
        PathBuf::from("/Applications").join(app),
        PathBuf::from("/System/Applications").join(app),
    ];
    if let Some(home) = dirs::home_dir() {
        locations.push(home.join("Applications").join(app));
    }
    locations
}

/// List installed external players, most preferred first. The viewer uses this
/// to offer "Open in <player>" for in-app-unsupported video formats.
#[tauri::command]
pub fn external_video_players() -> Vec<ExternalPlayer> {
    EXTERNAL_VIDEO_APPS
        .iter()
        .filter_map(|(name, app)| {
            playable_app_locations(app)
                .into_iter()
                .find(|path| path.is_dir())
                .map(|path| ExternalPlayer {
                    name: (*name).to_string(),
                    path: path.to_string_lossy().into_owned(),
                })
        })
        .collect()
}

/// Open a cataloged item in a specific installed player (e.g. a `.mkv` in VLC).
#[tauri::command]
pub async fn open_with_player(
    path: String,
    player: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    let exists: Option<String> = sqlx::query_scalar("SELECT path FROM media_items WHERE path = ?")
        .bind(&path)
        .fetch_optional(&db)
        .await?;
    if exists.is_none() {
        return Err(CommandError::path(
            "Path is not part of the catalog.".to_string(),
        ));
    }

    let player_path = PathBuf::from(&player);
    if player_path.extension().and_then(|ext| ext.to_str()) != Some("app") || !player_path.is_dir()
    {
        return Err(CommandError::invalid(
            "Requested player is not an installed application.".to_string(),
        ));
    }

    std::process::Command::new("open")
        .arg("-a")
        .arg(&player_path)
        .arg(&path)
        .status()
        .map_err(|e| CommandError::io(format!("Could not open {} with {}: {}", path, player, e)))?;
    Ok(())
}

/// Open a folder in Finder. Used by Batch export results.
#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), CommandError> {
    // Unlike `open -R` (which selects a file in its parent), this opens the
    // folder itself in Finder. Used by Batch export results.
    if !std::path::Path::new(&path).is_dir() {
        return Err(CommandError::invalid(
            "Path is not a directory.".to_string(),
        ));
    }
    std::process::Command::new("open")
        .arg(&path)
        .status()
        .map_err(|e| CommandError::io(format!("Could not open {}: {}", path, e)))?;
    Ok(())
}

/// One item the caller wants pulled out of the Trash and put back. The
/// restore never reads from or deletes catalog rows — the caller re-imports
/// the restored paths afterwards.
#[derive(serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct TrashRestoreItem {
    /// Absolute path the file lived at before it was trashed.
    pub path: String,
    /// `file_name()` of the trashed entry (trash holds flat entries).
    pub name: String,
    /// Size in bytes; used to disambiguate same-named trash entries.
    pub size: Option<i64>,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct TrashRestoreFailure {
    pub path: String,
    pub error: String,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct TrashRestoreResult {
    pub restored: Vec<String>,
    pub failed: Vec<TrashRestoreFailure>,
}

struct TrashEntry {
    path: PathBuf,
    size: u64,
}

fn list_trash_entries(trash: &std::path::Path) -> Vec<TrashEntry> {
    let mut entries = Vec::new();
    let Ok(dir) = std::fs::read_dir(trash) else {
        return entries;
    };
    for entry in dir.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        entries.push(TrashEntry {
            path,
            size: metadata.len(),
        });
    }
    entries
}

/// Pick the trash entry that belongs to a restore request: exact name match,
/// and size match when the caller knows one. A sizeless request with a single
/// candidate is accepted; several candidates without a size are ambiguous and
/// refuse rather than guess.
fn select_trash_match<'a>(
    entries: &'a [TrashEntry],
    name: &str,
    size: Option<i64>,
) -> Option<&'a TrashEntry> {
    let mut named = entries.iter().filter(|entry| {
        entry
            .path
            .file_name()
            .map(|file_name| file_name == std::ffi::OsStr::new(name))
            .unwrap_or(false)
    });
    if let Some(size) = size {
        return named.find(|entry| entry.size == size.max(0) as u64);
    }
    let first = named.next()?;
    if named.next().is_some() {
        return None; // ambiguous
    }
    Some(first)
}

fn move_back(entry: &std::path::Path, target: &std::path::Path) -> Result<(), CommandError> {
    if std::fs::rename(entry, target).is_ok() {
        return Ok(());
    }
    // Cross-filesystem fallback (e.g. trash on another volume).
    std::fs::copy(entry, target)
        .map_err(|e| CommandError::io(format!("Could not restore {}: {}", target.display(), e)))?;
    std::fs::remove_file(entry)
        .map_err(|e| CommandError::io(format!("Could not restore {}: {}", target.display(), e)))?;
    Ok(())
}

/// Move items out of the user's Trash back to the paths they were trashed
/// from. This deliberately avoids Finder automation: a plain filesystem move
/// works no matter which sink trashed the file (Finder script or NSFileManager
/// fallback) and it is testable without driving Finder. The caller re-imports
/// the restored paths into the catalog afterwards.
fn restore_from_trash(trash: &std::path::Path, items: &[TrashRestoreItem]) -> TrashRestoreResult {
    let entries = list_trash_entries(trash);
    let mut restored = Vec::new();
    let mut failed = Vec::new();
    for item in items {
        let fail = |error: String| TrashRestoreFailure {
            path: item.path.clone(),
            error,
        };
        let target = PathBuf::from(&item.path);
        if item.name.is_empty() || item.name.contains(std::path::MAIN_SEPARATOR) {
            failed.push(fail("Invalid file name.".to_string()));
            continue;
        }
        if let Some(parent) = target.parent() {
            if !parent.is_dir() {
                failed.push(fail(format!(
                    "Folder {} no longer exists.",
                    parent.display()
                )));
                continue;
            }
        }
        if target.exists() {
            // Nothing to restore — the file is already back in place.
            restored.push(item.path.clone());
            continue;
        }
        match select_trash_match(&entries, &item.name, item.size) {
            Some(entry) => match move_back(&entry.path, &target) {
                Ok(()) => restored.push(item.path.clone()),
                Err(error) => failed.push(fail(error.to_string())),
            },
            None => failed.push(fail(format!(
                "Could not find {} in the Trash (it may have been purged).",
                item.name
            ))),
        }
    }
    TrashRestoreResult { restored, failed }
}

#[tauri::command]
pub async fn restore_trashed_items(
    items: Vec<TrashRestoreItem>,
) -> Result<TrashRestoreResult, CommandError> {
    // restore is deliberately not scoped to the catalog: these files are by
    // definition the user's trashed items and going back to the original
    // location is the only thing this function does.
    let trash = dirs::home_dir()
        .map(|home| home.join(".Trash"))
        .ok_or_else(|| CommandError::io("Could not locate the Trash folder.".to_string()))?;
    Ok(restore_from_trash(&trash, &items))
}

/// Extract EXIF metadata from a file. Reusable by the scan path and the
/// `read_exif` command. Returns an `ExifData` with `metadata_error` set on
/// failure instead of propagating the error.
pub(crate) fn extract_exif(path: &std::path::Path) -> ExifData {
    let mut data = ExifData {
        captured_at: None,
        camera: None,
        lens: None,
        exposure: None,
        iso: None,
        latitude: None,
        longitude: None,
        width: None,
        height: None,
        metadata_error: None,
    };

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            data.metadata_error = Some(e.to_string());
            return data;
        }
    };
    let mut buf = std::io::BufReader::new(file);
    let exif_reader = exif::Reader::new();
    let exif = match exif_reader.read_from_container(&mut buf) {
        Ok(e) => e,
        Err(e) => {
            data.metadata_error = Some(e.to_string());
            return data;
        }
    };

    // Text fields are read as raw ASCII: `display_value()` wraps strings in
    // quotes and reformats dates, which broke both the stored names and the
    // capture-date parse.
    data.captured_at = [
        exif::Tag::DateTimeOriginal,
        exif::Tag::DateTimeDigitized,
        exif::Tag::DateTime,
    ]
    .into_iter()
    .find_map(|tag| exif_ascii(&exif, tag).and_then(|s| parse_exif_datetime(&s)));
    data.camera = camera_name(
        exif_ascii(&exif, exif::Tag::Make),
        exif_ascii(&exif, exif::Tag::Model),
    );
    data.lens = exif_ascii(&exif, exif::Tag::LensModel);
    if let Some(f) = exif.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY) {
        data.exposure = Some(f.display_value().to_string());
    }
    if let Some(f) = exif.get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY) {
        if let exif::Value::Short(ref v) = f.value {
            if let Some(&x) = v.first() {
                data.iso = Some(x as i32);
            }
        }
    }
    if let Some(f) = exif.get_field(exif::Tag::PixelXDimension, exif::In::PRIMARY) {
        if let exif::Value::Long(ref v) = f.value {
            data.width = v.first().map(|&x| x as i32);
        }
    }
    if let Some(f) = exif.get_field(exif::Tag::PixelYDimension, exif::In::PRIMARY) {
        if let exif::Value::Long(ref v) = f.value {
            data.height = v.first().map(|&x| x as i32);
        }
    }

    // GPS: convert DMS rationals to decimal degrees.
    if let (Some(lat), Some(lon)) = (
        exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY),
        exif.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY),
    ) {
        let lat_ref =
            exif_ascii(&exif, exif::Tag::GPSLatitudeRef).unwrap_or_else(|| "N".to_string());
        let lon_ref =
            exif_ascii(&exif, exif::Tag::GPSLongitudeRef).unwrap_or_else(|| "E".to_string());

        // Some cameras (DJI action cams, for one) write 0,0 when they have
        // no fix; that is "no location", not a point in the Gulf of Guinea.
        let has_fix = |la: f64, lo: f64| la.abs() > 1e-9 || lo.abs() > 1e-9;
        let coords = match (dms_to_decimal(lat), dms_to_decimal(lon)) {
            (Some(la), Some(lo)) if has_fix(la, lo) => Some((la, lo)),
            _ => None,
        };
        if let Some((la, lo)) = coords {
            data.latitude = Some(if lat_ref.trim().eq_ignore_ascii_case("S") {
                -la
            } else {
                la
            });
            data.longitude = Some(if lon_ref.trim().eq_ignore_ascii_case("W") {
                -lo
            } else {
                lo
            });
        }
    }

    data
}

/// The text of an ASCII EXIF field, without quotes, NUL padding or empty
/// components. Some cameras pad Make/Model with dozens of empty strings.
fn exif_ascii(exif: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let field = exif.get_field(tag, exif::In::PRIMARY)?;
    let exif::Value::Ascii(ref parts) = field.value else {
        return None;
    };
    clean_ascii_parts(parts)
}

pub(crate) fn clean_ascii_parts(parts: &[Vec<u8>]) -> Option<String> {
    let text = parts
        .iter()
        .map(|part| {
            String::from_utf8_lossy(part)
                .trim_matches(|c: char| c == '\0' || c.is_whitespace())
                .to_string()
        })
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty()).then_some(text)
}

/// "Make Model", without repeating the make when the model already starts
/// with it ("Canon" + "Canon EOS R5" is "Canon EOS R5").
pub(crate) fn camera_name(make: Option<String>, model: Option<String>) -> Option<String> {
    match (make, model) {
        (Some(make), Some(model)) => {
            if model.to_lowercase().starts_with(&make.to_lowercase()) {
                Some(model)
            } else {
                Some(format!("{make} {model}"))
            }
        }
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    }
}

/// Parse an EXIF date ("2024:05:17 14:03:09"). Like the rest of the catalog,
/// the wall-clock time is stored as if it were UTC.
pub(crate) fn parse_exif_datetime(text: &str) -> Option<i64> {
    let text = text.trim();
    let head = text.get(..19)?;
    chrono::NaiveDateTime::parse_from_str(head, "%Y:%m:%d %H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(head, "%Y-%m-%d %H:%M:%S"))
        .ok()
        .filter(|dt| dt.and_utc().timestamp() > 0)
        .map(|dt| dt.and_utc().timestamp_millis())
}

#[cfg(test)]
mod exif_text_tests {
    use super::{camera_name, clean_ascii_parts, parse_exif_datetime};

    #[test]
    fn ascii_parts_lose_padding_and_empty_components() {
        assert_eq!(
            clean_ascii_parts(&[b"SONY\0".to_vec()]),
            Some("SONY".into())
        );
        let mut padded = vec![b"samsung".to_vec()];
        padded.extend(std::iter::repeat_n(Vec::new(), 24));
        assert_eq!(clean_ascii_parts(&padded), Some("samsung".into()));
        assert_eq!(clean_ascii_parts(&[b"  ".to_vec()]), None);
    }

    #[test]
    fn camera_name_avoids_repeating_the_make() {
        let name = |a: &str, b: &str| camera_name(Some(a.into()), Some(b.into()));
        assert_eq!(name("SONY", "DSC-RX10M3"), Some("SONY DSC-RX10M3".into()));
        assert_eq!(name("Canon", "Canon EOS R5"), Some("Canon EOS R5".into()));
        assert_eq!(
            camera_name(None, Some("AC006".into())),
            Some("AC006".into())
        );
    }

    #[test]
    fn exif_dates_parse_with_and_without_padding() {
        assert_eq!(
            parse_exif_datetime("2024:05:17 14:03:09"),
            Some(1_715_954_589_000)
        );
        assert_eq!(
            parse_exif_datetime("2024:05:17 14:03:09\0"),
            Some(1_715_954_589_000)
        );
        assert_eq!(parse_exif_datetime("0000:00:00 00:00:00"), None);
        assert_eq!(parse_exif_datetime("    :  :     :  :  "), None);
    }
}

/// Convert an EXIF GPS DMS field (three rationals) to decimal degrees.
fn dms_to_decimal(field: &exif::Field) -> Option<f64> {
    let exif::Value::Rational(ref vals) = field.value else {
        return None;
    };
    if vals.len() < 3 {
        return None;
    }
    let deg = vals[0].to_f64();
    let min = vals[1].to_f64();
    let sec = vals[2].to_f64();
    Some(deg + min / 60.0 + sec / 3600.0)
}

/// Compute the SHA-256 digest of a file's contents as a hex string.
/// Used during backfill to populate `sha256` for items that lack it.
pub(crate) fn compute_sha256(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = [0u8; 1024 * 1024]; // 1 MiB buffer
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Some(hex::encode(ctx.finish()))
}

#[tauri::command]
pub async fn read_exif(
    path: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<ExifData, CommandError> {
    let db = super::get_db(&catalog)?;
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await?;
    validate_path_under_registered_roots(&path, &registered)?;
    let path_buf = std::path::PathBuf::from(&path);
    let data = tokio::task::spawn_blocking(move || extract_exif(&path_buf)).await?;
    Ok(data)
}

/// In-place edits re-encode the source and atomically replace it. Only
/// formats we can round-trip safely are eligible; anything else (HEIC, TIFF,
/// AVIF, …) would lose data silently, so it must go through "Save a copy".
pub(crate) fn validate_in_place_format(source_path: &str) -> Result<(), CommandError> {
    let ext = source_path
        .rsplit('.')
        .next()
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
        return Ok(());
    }
    Err(CommandError::new(
        ErrorCode::UnsupportedFormat,
        format!(
            "In-place export supports JPEG, PNG and WebP (refusing .{ext}). Use \"Save a copy\" to keep the original untouched."
        ),
    ))
}

/// Journal the original bytes of `source_path` before an in-place edit.
///
/// The first call copies the file into `backup_dir` and records it in
/// `edit_backups`. Later calls reuse that record without overwriting it, so
/// editing twice can never replace the true original with the first edit.
async fn ensure_edit_backup_in_dir(
    db: &sqlx::SqlitePool,
    backup_dir: &std::path::Path,
    media_id: &str,
    source_path: &str,
) -> Result<PathBuf, CommandError> {
    if let Some(row) = sqlx::query("SELECT backup_path FROM edit_backups WHERE media_id = ?")
        .bind(media_id)
        .fetch_optional(db)
        .await?
    {
        let recorded: String = row.get("backup_path");
        if std::path::Path::new(&recorded).is_file() {
            return Ok(PathBuf::from(recorded));
        }
        return Err(CommandError::not_found(
            "The journaled original for this item is missing; use \"Save a copy\" instead of replacing it."
                .to_string(),
        ));
    }

    std::fs::create_dir_all(backup_dir).map_err(|e| {
        format!(
            "Could not create the edit backup folder {}: {e}",
            backup_dir.display()
        )
    })?;

    // `validate_in_place_format` guarantees a supported extension. Including
    // it keeps the backup openable by external tools.
    let extension = std::path::Path::new(source_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())
        .unwrap_or_else(|| "bin".to_string());
    let backup_path = backup_dir.join(format!("{media_id}.{extension}"));

    let source = source_path.to_string();
    let destination = backup_path.clone();
    tokio::task::spawn_blocking(move || std::fs::copy(&source, &destination))
        .await
        .map_err(|e| CommandError::internal(format!("Backup task failed: {e}")))?
        .map_err(|e| {
            CommandError::internal(format!(
                "Failed to journal the original before editing: {e}"
            ))
        })?;

    let size = std::fs::metadata(&backup_path)
        .map_err(|e| CommandError::io(format!("Could not read the journaled original: {e}")))?
        .len() as i64;
    let hash_path = backup_path.clone();
    let hash = tokio::task::spawn_blocking(move || compute_sha256(&hash_path))
        .await
        .map_err(|e| CommandError::internal(format!("Hash task failed: {e}")))?;

    sqlx::query(
        "INSERT INTO edit_backups (media_id, original_path, backup_path, size, sha256, created_at) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(media_id) DO NOTHING",
    )
    .bind(media_id)
    .bind(source_path)
    .bind(backup_path.to_string_lossy().into_owned())
    .bind(size)
    .bind(&hash)
    .bind(super::now_ms())
    .execute(db)
    .await
    ?;

    // If a concurrent edit won the race, keep its record and drop our copy.
    let recorded: String =
        sqlx::query_scalar("SELECT backup_path FROM edit_backups WHERE media_id = ?")
            .bind(media_id)
            .fetch_one(db)
            .await?;
    if recorded != backup_path.to_string_lossy() {
        let _ = std::fs::remove_file(&backup_path);
        return Ok(PathBuf::from(recorded));
    }

    Ok(backup_path)
}

async fn ensure_edit_backup(
    app: &tauri::AppHandle,
    db: &sqlx::SqlitePool,
    media_id: &str,
    source_path: &str,
) -> Result<PathBuf, CommandError> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::io(format!("Could not locate the app data folder: {e}")))?;
    ensure_edit_backup_in_dir(db, &app_dir.join("edit-originals"), media_id, source_path).await
}

#[tauri::command]
pub async fn render_edited(
    request: RenderRequest,
    app: tauri::AppHandle,
    catalog: State<'_, crate::Catalog>,
) -> Result<ExportResult, CommandError> {
    // Validate the source path against registered library folders before doing
    // any work, so a crafted request cannot read arbitrary files. With no
    // folders registered the catalog is the only thing that can vouch for a
    // path, and `validate_path_under_registered_roots` enforces that.
    let db = super::get_db(&catalog)?;
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await?;
    super::validate_path_under_registered_roots(&request.source_path, &registered)?;

    let in_place = request.output_format == "in_place";
    let backup_path = if in_place {
        validate_in_place_format(&request.source_path)?;
        let media_id = request
            .media_id
            .clone()
            .ok_or_else(|| "In-place edits require a media id.".to_string())?;
        let catalog_path: Option<String> =
            sqlx::query_scalar("SELECT path FROM media_items WHERE id = ?")
                .bind(&media_id)
                .fetch_optional(&db)
                .await?;
        match catalog_path {
            Some(path) if path == request.source_path => {}
            Some(_) => {
                return Err(CommandError::path(
                    "The requested file does not match the catalog entry for this item."
                        .to_string(),
                ))
            }
            None => {
                return Err(CommandError::path(
                    "Item is not in the catalog; in-place edits are not allowed.".to_string(),
                ))
            }
        }
        Some(ensure_edit_backup(&app, &db, &media_id, &request.source_path).await?)
    } else {
        None
    };
    let source_path = request.source_path.clone();

    // Offload CPU-intensive image processing to blocking pool
    let result =
        tauri::async_runtime::spawn_blocking(move || render_edited_blocking(request, backup_path))
            .await
            .map_err(|e| CommandError::internal(format!("Task failed: {}", e)))??;

    // After a successful in-place replace, refresh the catalog row so the
    // thumbnail cache key (which includes modified_at) changes and the stale
    // thumbnail is regenerated on the next request.
    if in_place {
        if let Ok(meta) = std::fs::metadata(&source_path) {
            let size = meta.len() as i64;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or_else(super::now_ms);
            let _ = sqlx::query(
                "UPDATE media_items SET size = ?, modified_at = ?, updated_at = ? WHERE path = ?",
            )
            .bind(size)
            .bind(modified)
            .bind(super::now_ms())
            .bind(&source_path)
            .execute(&db)
            .await;
        }
    }

    Ok(result)
}

/// Core image editing pipeline - runs in blocking pool
fn render_edited_blocking(
    request: RenderRequest,
    backup_path: Option<PathBuf>,
) -> Result<ExportResult, CommandError> {
    use std::path::PathBuf;

    let source_path = PathBuf::from(&request.source_path);

    // 1. Load image with metadata
    let reader = image::ImageReader::open(&source_path)
        .map_err(|e| CommandError::io(format!("Could not open image: {}", e)))?
        .with_guessed_format()
        .map_err(|e| {
            CommandError::new(
                ErrorCode::UnsupportedFormat,
                format!("Could not identify image format: {}", e),
            )
        })?;

    let _format = reader
        .format()
        .ok_or_else(|| CommandError::new(ErrorCode::UnsupportedFormat, "Unknown image format"))?;
    // Orientation must be baked in once, before cropping, so the pixel
    // space matches the oriented preview the editor shows. Otherwise crop and
    // rotate get applied to the wrong axis and the file saves sideways.
    let mut decoder = reader.into_decoder().map_err(|e| {
        CommandError::new(
            ErrorCode::UnsupportedFormat,
            format!("Could not decode image: {}", e),
        )
    })?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| {
        CommandError::new(
            ErrorCode::UnsupportedFormat,
            format!("Could not decode image: {}", e),
        )
    })?;
    img.apply_orientation(orientation);

    let (orig_width, orig_height) = (img.width(), img.height());

    // 2. Read EXIF data before any modifications, and clear the Orientation
    // tag so EXIF-aware viewers do not rotate the already-oriented pixels
    // a second time.
    let exif_data =
        read_exif_bytes(&source_path).and_then(|bytes| rewrite_orientation_to_one(&bytes));

    // 3. Apply crop in SOURCE space (before rotation/flip)
    // CropRect is normalized (0-1) against source dimensions
    if let Some(crop) = request.crop {
        let crop_x = (crop.x * orig_width as f32).round() as u32;
        let crop_y = (crop.y * orig_height as f32).round() as u32;
        let crop_w = (crop.width * orig_width as f32).round() as u32;
        let crop_h = (crop.height * orig_height as f32).round() as u32;

        // Clamp to image bounds
        let crop_x = crop_x.min(orig_width.saturating_sub(1));
        let crop_y = crop_y.min(orig_height.saturating_sub(1));
        let crop_w = crop_w.min(orig_width - crop_x).max(1);
        let crop_h = crop_h.min(orig_height - crop_y).max(1);

        img = img.crop_imm(crop_x, crop_y, crop_w, crop_h);
    }

    // 4. Apply rotation (in 90-degree increments)
    let rotation = ((request.edits.rotation % 360) + 360) % 360;
    match rotation {
        90 => img = img.rotate90(),
        180 => img = img.rotate180(),
        270 => img = img.rotate270(),
        _ => {}
    }

    // 5. Apply horizontal flip
    if request.edits.flip {
        img = img.fliph();
    }

    // 6. Apply color adjustments
    // exposure, contrast, warmth, shadows, highlights, saturation
    // These are applied as linear RGB adjustments
    if has_color_adjustments(&request.edits) {
        img = apply_color_adjustments(img, &request.edits);
    }

    let (final_width, final_height) = (img.width(), img.height());

    // 7. Determine output format for writing (preserve source format for in-place edits)
    let write_format = if request.output_format == "in_place" {
        match source_path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .as_deref()
        {
            Some("png") => "image/png".to_string(),
            Some("webp") => "image/webp".to_string(),
            _ => "image/jpeg".to_string(),
        }
    } else {
        request.output_format.clone()
    };

    // 8. Determine output path
    let output_path = if request.output_format == "in_place" {
        // In-place: the original was already journaled by the caller. Write to
        // a temp file next to the source, then atomically replace it.
        if backup_path.is_none() {
            return Err(CommandError::invalid(
                "Missing journaled original for in-place edit.".to_string(),
            ));
        }

        let mut guard = super::TempFileGuard::new(
            source_path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4())),
        );

        // Write to temp
        write_image(
            &img,
            guard.path(),
            &write_format,
            request.quality,
            request.strip_metadata,
            &exif_data,
        )?;

        // The rename below swaps the inode, so carry over what would otherwise
        // be lost: POSIX mode, Finder tags, quarantine and other xattrs.
        super::preserve_metadata(&source_path, guard.path());

        // Atomic rename. If it fails, the source is untouched; keep the
        // journaled original intact for a later revert.
        std::fs::rename(guard.path(), &source_path)
            .map_err(|e| CommandError::io(format!("Failed to replace original: {}", e)))?;
        guard.commit();

        source_path.to_string_lossy().into_owned()
    } else {
        // Save a copy - caller handles path via dialog
        // We write to a temp location and return the path
        let tmp_dir = export_staging_dir()?;
        let output_name = format!(
            "{}_edited.{}",
            source_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("image"),
            match request.output_format.as_str() {
                "image/png" => "png",
                "image/webp" => "webp",
                _ => "jpg",
            }
        );
        let output_path = tmp_dir.join(output_name);

        // Hold the staging file with an RAII guard so a failure while
        // writing cannot leave a 0- or partial-byte render behind.
        let mut staging_guard = super::TempFileGuard::new(output_path.clone());

        write_image(
            &img,
            &output_path,
            &write_format,
            request.quality,
            request.strip_metadata,
            &exif_data,
        )?;

        // Render succeeded; the file must survive until the user picks a
        // destination (or discards it).
        staging_guard.commit();
        output_path.to_string_lossy().into_owned()
    };

    // 8. Verify output
    let metadata = std::fs::metadata(&output_path)
        .map_err(|e| CommandError::io(format!("Output verification failed: {}", e)))?;
    let size = metadata.len() as i64;

    Ok(ExportResult {
        output_path,
        size,
        width: final_width as i32,
        height: final_height as i32,
    })
}

/// Folder that holds "save a copy" renders until the user picks a
/// destination. Only files inside it may be handed to `save_exported_file`.
pub(crate) fn export_staging_dir() -> Result<PathBuf, CommandError> {
    let dir = std::env::temp_dir().join("visto-export");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::io(format!("Could not create export staging folder: {}", e)))?;
    Ok(dir)
}

/// Resolve `source` and require it to be a regular file directly inside the
/// export staging folder. Canonicalizing first means `..` segments and
/// symlinks cannot point the move at a file elsewhere on disk.
pub(crate) fn validate_export_source(
    source: &str,
    staging: &Path,
) -> Result<PathBuf, CommandError> {
    let staging = staging
        .canonicalize()
        .map_err(|e| CommandError::io(format!("Export staging folder is unavailable: {}", e)))?;
    let src = Path::new(source)
        .canonicalize()
        .map_err(|_| CommandError::not_found("Exported file no longer exists."))?;
    if src.parent() != Some(staging.as_path()) || !src.is_file() {
        return Err(CommandError::path(
            "Source is not an app-generated export.".to_string(),
        ));
    }
    Ok(src)
}

/// Move a staged export to a destination the user picks in a native save
/// dialog. The backend owns the destination, so the webview can neither name
/// an arbitrary target nor move a file that the app did not render.
///
/// Returns the saved path, or `None` when the user cancels the dialog.
#[tauri::command]
pub async fn save_exported_file(
    app: tauri::AppHandle,
    source_path: String,
    suggested_name: String,
) -> Result<Option<String>, CommandError> {
    use tauri_plugin_dialog::DialogExt;

    let src = validate_export_source(&source_path, &export_staging_dir()?)?;
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();
    let (label, exts): (&str, &[&str]) = match ext.as_str() {
        "png" => ("PNG image", &["png"]),
        "webp" => ("WebP image", &["webp"]),
        _ => ("JPEG image", &["jpg", "jpeg"]),
    };
    let Some(picked) = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter(label, exts)
        .blocking_save_file()
    else {
        let _ = std::fs::remove_file(&src);
        return Ok(None);
    };
    let dst = picked
        .into_path()
        .map_err(|e| CommandError::new(ErrorCode::Dialog, e.to_string()))?;

    tokio::task::spawn_blocking(move || {
        // Prefer an atomic rename; fall back to copy+remove across volumes.
        if std::fs::rename(&src, &dst).is_err() {
            std::fs::copy(&src, &dst)
                .map_err(|e| CommandError::io(format!("Could not copy exported file: {}", e)))?;
            let _ = std::fs::remove_file(&src);
        }
        Ok(Some(dst.to_string_lossy().into_owned()))
    })
    .await?
}

#[cfg(test)]
mod export_source_tests {
    use super::validate_export_source;
    use crate::errors::ErrorCode;
    use std::fs;

    fn staging() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("visto-export-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_file_inside_staging() {
        let dir = staging();
        let file = dir.join("a_edited.jpg");
        fs::write(&file, b"x").unwrap();
        assert!(validate_export_source(file.to_str().unwrap(), &dir).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_dotdot_escape_from_staging() {
        let dir = staging();
        let outside =
            std::env::temp_dir().join(format!("visto-outside-{}.jpg", uuid::Uuid::new_v4()));
        fs::write(&outside, b"secret").unwrap();
        let sneaky = dir.join("..").join(outside.file_name().unwrap());
        let error = validate_export_source(sneaky.to_str().unwrap(), &dir)
            .expect_err("escape should be rejected");
        assert_eq!(error.code, ErrorCode::PathNotAllowed);
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_pointing_outside_staging() {
        let dir = staging();
        let outside =
            std::env::temp_dir().join(format!("visto-outside-{}.jpg", uuid::Uuid::new_v4()));
        fs::write(&outside, b"secret").unwrap();
        let link = dir.join("link.jpg");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(validate_export_source(link.to_str().unwrap(), &dir).is_err());
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_nested_and_directory_paths() {
        let dir = staging();
        let nested = dir.join("sub");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("b.jpg"), b"x").unwrap();
        assert!(validate_export_source(nested.join("b.jpg").to_str().unwrap(), &dir).is_err());
        assert!(validate_export_source(nested.to_str().unwrap(), &dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}

/// Check if any color adjustments are non-zero
fn has_color_adjustments(edits: &EditValues) -> bool {
    edits.exposure != 0
        || edits.contrast != 0
        || edits.warmth != 0
        || edits.shadows != 0
        || edits.highlights != 0
        || edits.saturation != 0
}

/// Apply color adjustments to image
fn apply_color_adjustments(img: DynamicImage, edits: &EditValues) -> DynamicImage {
    // Convert to RGBA for pixel manipulation
    let mut rgba = img.to_rgba8();

    // Precompute factors
    let exposure = edits.exposure as f32 / 100.0;
    let contrast = edits.contrast as f32 / 100.0;
    let warmth = edits.warmth as f32 / 100.0;
    let shadows = edits.shadows as f32 / 100.0;
    let highlights = edits.highlights as f32 / 100.0;
    let saturation = edits.saturation as f32 / 100.0;

    // Combined brightness factor
    let brightness = 1.0 + exposure + shadows * 0.22 + highlights * 0.1;
    let contrast_factor = 1.0 + contrast - shadows * 0.08 + highlights * 0.12;
    let saturation_factor = 1.0 + saturation;

    for pixel in rgba.pixels_mut() {
        let mut r = pixel[0] as f32 / 255.0;
        let mut g = pixel[1] as f32 / 255.0;
        let mut b = pixel[2] as f32 / 255.0;

        // Brightness
        r *= brightness;
        g *= brightness;
        b *= brightness;

        // Contrast (around 0.5 midpoint)
        r = (r - 0.5) * contrast_factor + 0.5;
        g = (g - 0.5) * contrast_factor + 0.5;
        b = (b - 0.5) * contrast_factor + 0.5;

        // Saturation
        let gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * saturation_factor;
        g = gray + (g - gray) * saturation_factor;
        b = gray + (b - gray) * saturation_factor;

        // Warmth
        if warmth > 0.0 {
            r += warmth * 0.3;
            b -= warmth * 0.3;
        } else if warmth < 0.0 {
            b += -warmth * 0.3;
            r -= -warmth * 0.3;
        }

        // Clamp and convert back
        pixel[0] = (r.clamp(0.0, 1.0) * 255.0).round() as u8;
        pixel[1] = (g.clamp(0.0, 1.0) * 255.0).round() as u8;
        pixel[2] = (b.clamp(0.0, 1.0) * 255.0).round() as u8;
    }

    DynamicImage::ImageRgba8(rgba)
}

/// Read EXIF bytes from a JPEG for preservation.
///
/// Returns only the APP1 *payload* (the `Exif\0\0` signature followed by the
/// TIFF block), not the `FF E1 <len>` segment header. Returns `None` for
/// non-JPEG files or files with no EXIF APP1 segment.
pub(crate) fn read_exif_bytes(path: &PathBuf) -> Option<Vec<u8>> {
    let mut file = std::fs::File::open(path).ok()?;
    use std::io::Read;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;

    if buffer.len() < 4 || buffer[0] != 0xFF || buffer[1] != 0xD8 {
        return None;
    }

    // Walk JPEG segments instead of scanning byte-by-byte.
    let mut i = 2usize;
    while i < buffer.len() {
        if buffer[i] != 0xFF {
            break; // reached scan data / EOI
        }
        let mut j = i;
        while j < buffer.len() && buffer[j] == 0xFF {
            j += 1;
        }
        if j >= buffer.len() {
            break;
        }
        let marker = buffer[j];
        // Standalone markers carry no length field.
        if marker == 0xD8 || marker == 0xD9 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i = j + 1;
            continue;
        }
        if j + 2 > buffer.len() {
            break;
        }
        let len = ((buffer[j + 1] as usize) << 8) | (buffer[j + 2] as usize);
        let seg_end = j + 1 + len;
        if seg_end > buffer.len() {
            break;
        }

        if marker == 0xE1 {
            let payload_start = j + 3; // skip marker(1) + length(2)
                                       // payload_start..seg_end is the APP1 payload; require Exif\0\0.
            if payload_start + 6 <= seg_end
                && buffer[payload_start..payload_start + 4] == *b"Exif"
                && buffer[payload_start + 4] == 0
                && buffer[payload_start + 5] == 0
            {
                return Some(buffer[payload_start..seg_end].to_vec());
            }
        }

        i = seg_end;
    }
    None
}

/// Clear the EXIF `Orientation` (0x0112) tag to `1` in place.
///
/// Edit writes the pixels the renderer already oriented, so a stale
/// `Orientation` would make EXIF-aware viewers rotate the image a second
/// time. Rewriting the tag in place keeps the APP1 layout, all offsets
/// inside the TIFF block, and every unrelated tag intact.
/// Returns `None` if the payload is not a recognizable EXIF TIFF block.
pub(crate) fn rewrite_orientation_to_one(exif: &[u8]) -> Option<Vec<u8>> {
    let mut buf = exif.to_vec();
    if buf.len() < 14 || &buf[0..4] != b"Exif" {
        return None;
    }
    let little_endian = match &buf[6..8] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |buf: &[u8], at: usize| -> Option<u16> {
        let end = at.checked_add(2)?;
        buf.get(at..end).map(|b| {
            if little_endian {
                u16::from_le_bytes([b[0], b[1]])
            } else {
                u16::from_be_bytes([b[0], b[1]])
            }
        })
    };
    let u32_at = |buf: &[u8], at: usize| -> Option<u32> {
        let end = at.checked_add(4)?;
        buf.get(at..end).map(|b| {
            if little_endian {
                u32::from_le_bytes([b[0], b[1], b[2], b[3]])
            } else {
                u32::from_be_bytes([b[0], b[1], b[2], b[3]])
            }
        })
    };
    // TIFF header: byte order (2) | magic (2) | IFD0 offset (4).
    let ifd0_offset = u32_at(&buf, 10)? as usize;
    let ifd0_pos = 6usize.checked_add(ifd0_offset)?;
    let entry_count = u16_at(&buf, ifd0_pos)? as usize;
    let entries_start = ifd0_pos.checked_add(2)?;
    for index in 0..entry_count {
        let entry = entries_start.checked_add(index.checked_mul(12)?)?;
        if entry.checked_add(12)? > buf.len() {
            break;
        }
        let tag = u16_at(&buf, entry)?;
        if tag != 0x0112 {
            continue;
        }
        // SHORT (type 3), count 1: the value lives in the first two bytes of
        // the 4-byte value cell, so rewriting in place never moves any
        // offset elsewhere in the TIFF block.
        if little_endian {
            buf[entry + 8] = 0x01;
            buf[entry + 9] = 0x00;
        } else {
            buf[entry + 8] = 0x00;
            buf[entry + 9] = 0x01;
        }
        return Some(buf);
    }
    Some(buf)
}

/// Write image with format-specific options, optionally preserving EXIF
fn write_image(
    img: &DynamicImage,
    path: &Path,
    format: &str,
    quality: f32,
    strip_metadata: bool,
    exif_data: &Option<Vec<u8>>,
) -> Result<(), CommandError> {
    let quality = (quality * 100.0).round().clamp(1.0, 100.0) as u8;

    match format {
        "image/png" => {
            let encoder = image::codecs::png::PngEncoder::new_with_quality(
                std::fs::File::create(path)?,
                image::codecs::png::CompressionType::Default,
                image::codecs::png::FilterType::default(),
            );
            encoder.write_image(
                img.as_bytes(),
                img.width(),
                img.height(),
                img.color().into(),
            )?;
        }
        "image/webp" => {
            let encoder =
                image::codecs::webp::WebPEncoder::new_lossless(std::fs::File::create(path)?);
            encoder.write_image(
                img.as_bytes(),
                img.width(),
                img.height(),
                img.color().into(),
            )?;
        }
        _ => {
            // JPEG default
            // For JPEG, we can preserve EXIF by injecting it
            let mut file = std::fs::File::create(path)?;

            // JPEG only supports RGB; flatten any alpha channel.
            let rgb = img.to_rgb8();

            if !strip_metadata {
                if let Some(exif) = exif_data {
                    // Write JPEG with EXIF injection
                    write_jpeg_with_exif(&mut file, &rgb, quality, exif)?;
                } else {
                    // No EXIF to preserve, write normally
                    let encoder =
                        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, quality);
                    encoder.write_image(
                        rgb.as_raw(),
                        rgb.width(),
                        rgb.height(),
                        image::ExtendedColorType::Rgb8,
                    )?;
                }
            } else {
                // Strip metadata explicitly requested
                let encoder =
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, quality);
                encoder.write_image(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    image::ExtendedColorType::Rgb8,
                )?;
            }
            file.flush()?;
        }
    }
    Ok(())
}

/// Write JPEG with EXIF injection.
///
/// Walks the encoded JPEG's segments so APP0 (JFIF) is written exactly once and
/// any pre-existing APP1 (EXIF) segment is replaced rather than duplicated.
pub(crate) fn write_jpeg_with_exif(
    file: &mut std::fs::File,
    img: &image::RgbImage,
    quality: u8,
    exif: &[u8],
) -> Result<(), CommandError> {
    use std::io::Write;

    // Encode to a memory buffer first.
    let mut buffer = Vec::new();
    {
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality);
        encoder.write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgb8,
        )?;
    }

    // Inject APP1 segment bytes (marker + length + payload).
    let mut app1 = Vec::with_capacity(exif.len() + 4);
    app1.extend_from_slice(&[0xFF, 0xE1]);
    let exif_len = exif.len() + 2;
    app1.extend_from_slice(&[(exif_len >> 8) as u8, (exif_len & 0xFF) as u8]);
    app1.extend_from_slice(exif);

    let mut output = Vec::with_capacity(buffer.len() + app1.len());

    // SOI
    if buffer.len() < 2 || buffer[0] != 0xFF || buffer[1] != 0xD8 {
        return Err(CommandError::internal(
            "Encoded JPEG is missing SOI marker.".to_string(),
        ));
    }
    output.extend_from_slice(&[0xFF, 0xD8]);

    let mut i = 2usize;
    let mut injected = false;

    while i < buffer.len() {
        if buffer[i] != 0xFF {
            // Trailing data (should not happen mid-header); copy and stop.
            if !injected {
                output.extend_from_slice(&app1);
                injected = true;
            }
            output.extend_from_slice(&buffer[i..]);
            break;
        }

        let mut j = i;
        while j < buffer.len() && buffer[j] == 0xFF {
            j += 1;
        }
        if j >= buffer.len() {
            break;
        }
        let marker = buffer[j];

        // EOI: inject if missing, then copy the rest.
        if marker == 0xD9 {
            if !injected {
                output.extend_from_slice(&app1);
                injected = true;
            }
            output.extend_from_slice(&buffer[i..]);
            break;
        }

        // Standalone markers carry no length.
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            output.push(0xFF);
            output.push(marker);
            i = j + 1;
            continue;
        }

        if j + 2 > buffer.len() {
            break;
        }
        let len = ((buffer[j + 1] as usize) << 8) | (buffer[j + 2] as usize);
        let seg_end = j + 1 + len;
        if seg_end > buffer.len() {
            break;
        }

        match marker {
            0xE0 => {
                // APP0 (JFIF): copy once, then inject APP1 right after it.
                output.extend_from_slice(&buffer[i..seg_end]);
                if !injected {
                    output.extend_from_slice(&app1);
                    injected = true;
                }
            }
            0xE1 => {
                // Skip any pre-existing APP1 (EXIF); we inject our own.
            }
            0xDA => {
                // SOS: inject (if not yet) then copy the rest verbatim.
                if !injected {
                    output.extend_from_slice(&app1);
                    injected = true;
                }
                output.extend_from_slice(&buffer[i..]);
                i = buffer.len();
                continue;
            }
            _ => {
                // Inject before the first non-APP0 segment if no APP0 was seen.
                if !injected && marker != 0xE0 {
                    output.extend_from_slice(&app1);
                    injected = true;
                }
                output.extend_from_slice(&buffer[i..seg_end]);
            }
        }

        i = seg_end;
    }

    if !injected {
        // Fallback: append before EOI was already handled; if still missing,
        // append at the end (shouldn't happen for a valid JPEG).
        output.extend_from_slice(&app1);
    }

    file.write_all(&output)?;
    Ok(())
}

#[cfg(test)]
mod exif_tests {
    use super::{
        compute_sha256, read_exif_bytes, rewrite_orientation_to_one, write_jpeg_with_exif,
    };
    use image::ImageEncoder;
    use image::RgbImage;

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "visto-exif-test-{}-{}.jpg",
            label,
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn read_exif_bytes_returns_none_for_plain_jpeg() {
        let path = temp_path("plain");
        let img = RgbImage::new(4, 4);
        let mut buf = Vec::new();
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
        enc.write_image(img.as_raw(), 4, 4, image::ExtendedColorType::Rgb8)
            .unwrap();
        std::fs::write(&path, &buf).unwrap();

        assert!(read_exif_bytes(&path).is_none());
        let _ = std::fs::remove_file(&path);
    }

    fn exif_with_orientation(orientation: u16) -> Vec<u8> {
        // "Exif\0\0" + little-endian TIFF header with one SHORT entry:
        // tag 0x0112 (Orientation), type 3 (SHORT), count 1, value `orientation`.
        let mut exif = b"Exif\0\0II*\0\x08\0\0\0".to_vec();
        exif.extend(&1u16.to_le_bytes()); // one entry
        exif.extend(&0x0112u16.to_le_bytes()); // tag
        exif.extend(&3u16.to_le_bytes()); // type SHORT
        exif.extend(&1u32.to_le_bytes()); // count
        exif.extend(&orientation.to_le_bytes()); // value cell
        exif.extend(&[0, 0]); // value cell padding
        exif
    }

    #[test]
    fn rewrite_orientation_to_one_sets_orientation_to_one() {
        let exif = exif_with_orientation(6);
        let out = rewrite_orientation_to_one(&exif).expect("valid payload");
        // Orientation value is at offset 14 + 8 = 22 (TIFF header 8 bytes, entry 12).
        let entry = 6 + 8 + 2;
        assert_eq!(&out[entry + 8..entry + 10], &[0x01, 0x00]);
        assert_eq!(out.len(), exif.len());
    }

    #[test]
    fn rewrite_orientation_to_one_preserves_unrelated_tags_and_length() {
        let mut exif = exif_with_orientation(8);
        // Add a second entry: tag 0x010F (Make), type ASCII, count 4, value "x86\0".
        exif.extend(&0x010Fu16.to_le_bytes());
        exif.extend(&2u16.to_le_bytes());
        exif.extend(&4u32.to_le_bytes());
        exif.extend(b"x86\0");
        let out = rewrite_orientation_to_one(&exif).expect("valid payload");
        assert_eq!(out.len(), exif.len());
        assert_eq!(&out[0..6], b"Exif\0\0");
    }

    #[test]
    fn rewrite_orientation_to_one_rejects_malformed_payloads() {
        assert!(rewrite_orientation_to_one(b"not-exif").is_none());
        assert!(rewrite_orientation_to_one(b"").is_none());
    }

    #[test]
    fn write_jpeg_with_exif_produces_decodable_jpeg() {
        let path = temp_path("out");
        let img = RgbImage::new(4, 4);
        // An APP1 payload: "Exif\0\0" + minimal TIFF header (II + 42 + offset 8).
        let exif: &[u8] = b"Exif\0\0II*\0\x08\0\0\0";
        let mut file = std::fs::File::create(&path).unwrap();
        write_jpeg_with_exif(&mut file, &img, 80, exif).unwrap();
        drop(file);

        // Must decode as a valid JPEG.
        let decoded = image::ImageReader::open(&path)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!(decoded.width(), 4);
        assert_eq!(decoded.height(), 4);

        // And the EXIF must be recoverable.
        let recovered = read_exif_bytes(&path).expect("exif should be recoverable");
        assert!(recovered.starts_with(b"Exif\0\0"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_jpeg_with_exif_has_single_app0_and_app1() {
        let path = temp_path("seg");
        let img = RgbImage::new(2, 2);
        let exif: &[u8] = b"Exif\0\0II*\0\x08\0\0\0";
        let mut file = std::fs::File::create(&path).unwrap();
        write_jpeg_with_exif(&mut file, &img, 80, exif).unwrap();
        drop(file);

        let data = std::fs::read(&path).unwrap();
        // Count APP0 and APP1 markers.
        let mut app0 = 0;
        let mut app1 = 0;
        let mut i = 2;
        while i + 1 < data.len() {
            if data[i] == 0xFF {
                match data[i + 1] {
                    0xE0 => app0 += 1,
                    0xE1 => app1 += 1,
                    0xDA => break, // SOS: rest is scan data
                    _ => {}
                }
            }
            i += 1;
        }
        assert_eq!(app0, 1, "APP0 (JFIF) must appear exactly once");
        assert_eq!(app1, 1, "APP1 (EXIF) must appear exactly once");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn compute_sha256_produces_deterministic_hex() {
        let path =
            std::env::temp_dir().join(format!("visto-sha256-test-{}.bin", uuid::Uuid::new_v4()));
        let contents = b"hello world";
        std::fs::write(&path, contents).unwrap();

        let hash = compute_sha256(&path).expect("sha256 should be computed");
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert_eq!(hash, expected);

        // Same file → same hash.
        let hash2 = compute_sha256(&path).expect("sha256 should be computed");
        assert_eq!(hash, hash2);

        // Different content → different hash.
        std::fs::write(&path, b"goodbye world").unwrap();
        let hash3 = compute_sha256(&path).expect("sha256 should be computed");
        assert_ne!(hash, hash3);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn compute_sha256_returns_none_for_missing_file() {
        let path = std::path::Path::new("/tmp/does-not-exist-xyz123.bin");
        assert!(compute_sha256(path).is_none());
    }
}

#[tauri::command]
pub async fn backfill_metadata(catalog: State<'_, crate::Catalog>) -> Result<i64, CommandError> {
    let db = super::get_db(&catalog)?;
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, path FROM media_items WHERE captured_at IS NULL OR camera IS NULL OR sha256 IS NULL",
    )
    .fetch_all(&db)
    .await
    ?;

    let mut updated = 0i64;
    for (id, path) in rows {
        let path_buf = std::path::PathBuf::from(&path);
        let exif_path = path_buf.clone();
        let exif = tokio::task::spawn_blocking(move || extract_exif(&exif_path)).await?;
        if exif.metadata_error.is_some() && exif.captured_at.is_none() && exif.camera.is_none() {
            continue;
        }
        // Compute SHA-256 only when it's missing; skip if file is unreadable.
        let sha256 = if path_buf.exists() {
            tokio::task::spawn_blocking(move || compute_sha256(&path_buf)).await?
        } else {
            None
        };
        sqlx::query(
            "UPDATE media_items SET captured_at = COALESCE(?, captured_at), camera = COALESCE(?, camera), lens = COALESCE(?, lens), exposure = COALESCE(?, exposure), iso = COALESCE(?, iso), latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude), sha256 = COALESCE(?, sha256), updated_at = ? WHERE id = ?",
        )
        .bind(exif.captured_at)
        .bind(&exif.camera)
        .bind(&exif.lens)
        .bind(&exif.exposure)
        .bind(exif.iso)
        .bind(exif.latitude)
        .bind(exif.longitude)
        .bind(&sha256)
        .bind(super::now_ms())
        .bind(&id)
        .execute(&db)
        .await
        ?;
        updated += 1;
    }
    Ok(updated)
}

#[cfg(test)]
mod in_place_format_tests {
    use super::validate_in_place_format;

    #[test]
    fn writable_formats_pass() {
        for path in ["a.jpg", "b.JPEG", "c.png", "d.webp", "/photos/e.Jpg"] {
            assert!(validate_in_place_format(path).is_ok(), "{path} should pass");
        }
    }

    #[test]
    fn unsupported_formats_are_rejected_with_save_a_copy_guidance() {
        for path in [
            "a.heic",
            "b.HEIC",
            "c.tif",
            "d.tiff",
            "e.avif",
            "f.bmp",
            "/x/g.unknown",
        ] {
            let err = validate_in_place_format(path).expect_err("should be rejected");
            assert!(
                err.message.contains("Save a copy"),
                "error for {path} should mention Save a copy, got: {err}"
            );
        }
    }

    #[test]
    fn files_without_extension_are_rejected() {
        assert!(validate_in_place_format("no_extension").is_err());
    }
}

#[cfg(test)]
mod trash_validation_tests {
    use super::{catalog_paths_by_id, validate_trash_path};
    use crate::errors::ErrorCode;
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("visto-trash-test-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn write_file(path: &Path) {
        std::fs::write(path, b"data").expect("write file");
    }

    fn cataloged(paths: &[&Path]) -> HashSet<String> {
        paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn cataloged_file_is_allowed_even_outside_roots() {
        let dir = temp_dir("cataloged");
        let file = dir.join("a.jpg");
        write_file(&file);
        let registered = vec!["/some/other/root".to_string()];

        assert!(
            validate_trash_path(file.to_str().unwrap(), &cataloged(&[&file]), &registered).is_ok()
        );
    }

    #[test]
    fn uncataloged_file_inside_registered_root_is_allowed() {
        let dir = temp_dir("inside-root");
        let file = dir.join("a.jpg");
        write_file(&file);
        let registered = vec![dir.to_string_lossy().into_owned()];

        assert!(validate_trash_path(file.to_str().unwrap(), &HashSet::new(), &registered).is_ok());
    }

    #[test]
    fn uncataloged_file_outside_registered_root_is_rejected() {
        let root = temp_dir("root");
        let outside = temp_dir("outside");
        let file = outside.join("a.jpg");
        write_file(&file);
        let registered = vec![root.to_string_lossy().into_owned()];

        let error = validate_trash_path(file.to_str().unwrap(), &HashSet::new(), &registered)
            .expect_err("outside root should be rejected");
        assert_eq!(error.code, ErrorCode::PathNotAllowed);
        assert!(error.message.contains("outside registered library folders"));
    }

    #[test]
    fn missing_file_is_reported_as_not_found() {
        let dir = temp_dir("missing");
        let file = dir.join("gone.jpg");
        let error = validate_trash_path(file.to_str().unwrap(), &HashSet::new(), &[])
            .expect_err("missing file should be rejected");
        assert_eq!(error.code, ErrorCode::NotFound);
    }

    #[test]
    fn symlink_is_reported_as_invalid_input() {
        let dir = temp_dir("symlink");
        let file = dir.join("a.jpg");
        write_file(&file);
        let link = dir.join("link.jpg");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let error = validate_trash_path(link.to_str().unwrap(), &HashSet::new(), &[])
            .expect_err("symlink should be rejected");
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn path_traversal_cannot_escape_a_root() {
        let root = temp_dir("traversal-root");
        let outside = temp_dir("traversal-outside");
        let file = outside.join("a.jpg");
        write_file(&file);
        let registered = vec![root.to_string_lossy().into_owned()];
        let escaped = root
            .join("..")
            .join(outside.file_name().unwrap())
            .join("a.jpg");

        assert!(
            validate_trash_path(escaped.to_str().unwrap(), &HashSet::new(), &registered).is_err()
        );
    }

    #[test]
    fn missing_file_is_rejected() {
        let dir = temp_dir("missing");
        let file = dir.join("gone.jpg");

        let error = validate_trash_path(file.to_str().unwrap(), &HashSet::new(), &[])
            .expect_err("missing file should be rejected");
        assert!(error.message.contains("no longer exists"));
    }

    #[test]
    fn symlinks_are_rejected() {
        let dir = temp_dir("symlink");
        let target = dir.join("target.jpg");
        write_file(&target);
        let link = dir.join("link.jpg");
        std::os::unix::fs::symlink(&target, &link).expect("create symlink");
        let registered = vec![dir.to_string_lossy().into_owned()];

        let error = validate_trash_path(link.to_str().unwrap(), &HashSet::new(), &registered)
            .expect_err("symlink should be rejected");
        assert!(error.message.contains("symbolic link"));
    }

    #[test]
    fn directories_are_rejected() {
        let dir = temp_dir("directories");
        let registered = vec![dir.to_string_lossy().into_owned()];

        let error = validate_trash_path(dir.to_str().unwrap(), &HashSet::new(), &registered)
            .expect_err("directory should be rejected");
        assert!(error.message.contains("Only regular files"));
    }

    #[tokio::test]
    async fn catalog_lookup_resolves_ids_and_drops_unknown_ids() {
        use sqlx::sqlite::SqlitePoolOptions;

        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create media_items");
        sqlx::query(
            "INSERT INTO media_items (id, path) VALUES ('a', '/tmp/a.jpg'), ('b', '/tmp/b.jpg')",
        )
        .execute(&db)
        .await
        .expect("insert rows");

        let resolved = catalog_paths_by_id(&db, &["b".to_string(), "missing".to_string()])
            .await
            .expect("resolve ids");

        assert_eq!(resolved.get("b").map(String::as_str), Some("/tmp/b.jpg"));
        assert!(!resolved.contains_key("missing"));
        assert_eq!(resolved.len(), 1);
    }
}

#[cfg(test)]
mod trash_restore_tests {
    use super::{list_trash_entries, restore_from_trash, select_trash_match, TrashRestoreItem};
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("visto-trash-restore-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn request(path: &Path, size: Option<i64>) -> TrashRestoreItem {
        let name = path
            .file_name()
            .expect("target file name")
            .to_string_lossy()
            .into_owned();
        TrashRestoreItem {
            path: path.to_string_lossy().into_owned(),
            name,
            size,
        }
    }

    #[test]
    fn select_trash_match_prefers_the_exact_name_and_size() {
        let trash = temp_dir("match-exact");
        let small = trash.join("photo.jpg");
        let big = trash.join("photo.jpg.moved");
        std::fs::write(&small, b"small").unwrap();
        std::fs::write(&big, b"big content here").unwrap();

        let entries = list_trash_entries(&trash);
        let matched = select_trash_match(&entries, "photo.jpg", Some(5));
        match matched {
            Some(entry) => assert_eq!(entry.path, small, "exact name and size must win"),
            None => panic!("exact name and size must win"),
        }
    }

    #[test]
    fn select_trash_match_accepts_sizeless_unique_name() {
        let trash = temp_dir("match-sizeless");
        let only = trash.join("only.jpg");
        std::fs::write(&only, b"data").unwrap();

        let entries = list_trash_entries(&trash);
        assert!(select_trash_match(&entries, "only.jpg", None).is_some());
    }

    #[test]
    fn select_trash_match_refuses_ambiguous_sizeless_requests() {
        let entries = vec![
            super::TrashEntry {
                path: PathBuf::from("/trash/photo.jpg"),
                size: 10,
            },
            super::TrashEntry {
                path: PathBuf::from("/trash/photo.jpg"),
                size: 20,
            },
        ];
        assert!(select_trash_match(&entries, "photo.jpg", None).is_none());
        assert_eq!(
            select_trash_match(&entries, "photo.jpg", Some(20)).map(|entry| entry.size),
            Some(20),
            "a size that matches disambiguates the pair"
        );
    }

    #[test]
    fn select_trash_match_rejects_size_mismatch_and_missing_name() {
        let trash = temp_dir("match-mismatch");
        let entry = trash.join("photo.jpg");
        std::fs::write(&entry, b"12345").unwrap();

        let entries = list_trash_entries(&trash);
        assert!(select_trash_match(&entries, "photo.jpg", Some(6)).is_none());
        assert!(select_trash_match(&entries, "other.jpg", Some(5)).is_none());
    }

    #[test]
    fn restore_from_trash_moves_the_file_back_home() {
        let trash = temp_dir("restore-move");
        let home = temp_dir("restore-home");
        let trashed = trash.join("vacation.jpg");
        std::fs::write(&trashed, b"image bytes").unwrap();
        let target = home.join("vacation.jpg");

        let result = restore_from_trash(&trash, &[request(&target, Some(11))]);
        assert_eq!(result.restored, vec![target.to_string_lossy().into_owned()]);
        assert!(result.failed.is_empty());
        assert_eq!(std::fs::read(&target).unwrap(), b"image bytes");
        assert!(!trashed.exists(), "the trash entry must be gone after a restore");
    }

    #[test]
    fn restore_from_trash_reports_missing_files() {
        let trash = temp_dir("restore-missing");
        let home = temp_dir("restore-missing-home");
        let target = home.join("gone.jpg");

        let result = restore_from_trash(&trash, &[request(&target, None)]);
        assert!(result.restored.is_empty());
        assert_eq!(result.failed.len(), 1);
    }

    #[test]
    fn restore_from_trash_never_overwrites_an_existing_file() {
        let trash = temp_dir("restore-exists");
        let home = temp_dir("restore-exists-home");
        let trashed = trash.join("keep.jpg");
        std::fs::write(&trashed, b"trashed bytes").unwrap();
        let target = home.join("keep.jpg");
        std::fs::write(&target, b"keep me").unwrap();

        let result = restore_from_trash(&trash, &[request(&target, Some(13))]);
        assert_eq!(result.restored.len(), 1, "already-present file counts as restored");
        assert_eq!(std::fs::read(&target).unwrap(), b"keep me");
        assert!(trashed.exists(), "the trash entry is left untouched");
    }

    #[test]
    fn restore_from_trash_refuses_names_with_separators() {
        let trash = temp_dir("restore-traversal");
        let home = temp_dir("restore-traversal-home");
        let target = home.join("nested").join("photo.jpg");

        let result = restore_from_trash(
            &trash,
            &[TrashRestoreItem {
                path: target.to_string_lossy().into_owned(),
                name: "../photo.jpg".to_string(),
                size: None,
            }],
        );
        assert!(result.restored.is_empty());
        assert_eq!(result.failed.len(), 1);
    }
}

#[cfg(test)]
mod trash_flow_tests {
    use super::{execute_trash, resolve_trash_targets, TrashSink};
    use crate::errors::CommandError;
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    async fn test_db() -> sqlx::SqlitePool {
        use sqlx::sqlite::SqlitePoolOptions;

        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create media_items");
        sqlx::query(
            "CREATE TABLE edit_backups (media_id TEXT PRIMARY KEY, original_path TEXT NOT NULL, backup_path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT, created_at INTEGER NOT NULL)",
        )
        .execute(&db)
        .await
        .expect("create edit_backups");
        db
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("visto-trash-flow-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn write_file(path: &Path) {
        std::fs::write(path, b"data").expect("write file");
    }

    async fn insert_item(db: &sqlx::SqlitePool, id: &str, path: &Path) {
        sqlx::query("INSERT INTO media_items (id, path) VALUES (?, ?)")
            .bind(id)
            .bind(path.to_string_lossy().into_owned())
            .execute(db)
            .await
            .expect("insert media item");
    }

    async fn catalog_ids(db: &sqlx::SqlitePool) -> Vec<String> {
        sqlx::query_scalar("SELECT id FROM media_items ORDER BY id")
            .fetch_all(db)
            .await
            .expect("read catalog")
    }

    /// Records trashed paths; rejects individual paths to exercise
    /// partial-failure reporting.
    #[derive(Default)]
    struct FakeTrash {
        fail_paths: HashSet<String>,
        moved: Mutex<Vec<String>>,
    }

    impl FakeTrash {
        fn moved(&self) -> Vec<String> {
            self.moved.lock().unwrap().clone()
        }
    }

    impl TrashSink for FakeTrash {
        fn delete_all(&self, paths: &[String]) -> Result<(), CommandError> {
            // If any path in the batch is a known failure, the whole batch
            // fails (mirrors a single osascript call failing partway).
            if paths.iter().any(|p| self.fail_paths.contains(p)) {
                return Err(CommandError::internal("permission denied".to_string()));
            }
            self.moved.lock().unwrap().extend(paths.iter().cloned());
            Ok(())
        }
    }

    /// Regression guard for the duplicate-delete bug: the renderer only sends
    /// ids, so a copy that is not in the currently loaded library page must
    /// still resolve to its real path and become a trash target.
    #[tokio::test]
    async fn resolves_a_duplicate_that_is_not_in_the_loaded_page() {
        let db = test_db().await;
        let dir = temp_dir("resolve");
        let copy = dir.join("copy.jpg");
        write_file(&copy);
        insert_item(&db, "copy", &copy).await;

        let (targets, failed) = resolve_trash_targets(&db, vec!["copy".to_string()], &[])
            .await
            .expect("resolve targets");

        assert!(failed.is_empty(), "unexpected failures: {failed:?}");
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].0, "copy");
        assert_eq!(targets[0].1, copy.to_string_lossy().into_owned());
    }

    #[tokio::test]
    async fn unresolved_and_unreadable_ids_are_reported_without_targets() {
        let db = test_db().await;
        let dir = temp_dir("bad-ids");
        let missing = dir.join("gone.jpg");
        insert_item(&db, "missing", &missing).await;

        let (targets, failed) =
            resolve_trash_targets(&db, vec!["ghost".to_string(), "missing".to_string()], &[])
                .await
                .expect("resolve targets");

        assert!(targets.is_empty());
        let ids: Vec<&str> = failed.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["ghost", "missing"]);
        assert!(failed[0].error.contains("no longer in the catalog"));
        assert!(failed[1].error.contains("no longer exists"));
    }

    #[tokio::test]
    async fn symlinked_catalog_rows_are_rejected() {
        let db = test_db().await;
        let dir = temp_dir("symlink");
        let target = dir.join("target.jpg");
        write_file(&target);
        let link = dir.join("link.jpg");
        std::os::unix::fs::symlink(&target, &link).expect("create symlink");
        insert_item(&db, "linked", &link).await;

        let (targets, failed) = resolve_trash_targets(&db, vec!["linked".to_string()], &[])
            .await
            .expect("resolve targets");

        assert!(targets.is_empty());
        assert_eq!(failed.len(), 1);
        assert!(failed[0].error.contains("symbolic link"));
    }

    #[tokio::test]
    async fn duplicate_ids_are_collapsed_preserving_order() {
        let db = test_db().await;
        let dir = temp_dir("dedupe");
        let a = dir.join("a.jpg");
        let b = dir.join("b.jpg");
        write_file(&a);
        write_file(&b);
        insert_item(&db, "a", &a).await;
        insert_item(&db, "b", &b).await;

        let (targets, failed) = resolve_trash_targets(
            &db,
            vec![
                "b".to_string(),
                "a".to_string(),
                "b".to_string(),
                String::new(),
            ],
            &[],
        )
        .await
        .expect("resolve targets");

        assert!(failed.is_empty());
        let ids: Vec<&str> = targets.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }

    /// Full flow: trash the files, delete only the trashed catalog rows, and
    /// remove journaled originals that belonged to them.
    #[tokio::test]
    async fn successful_trash_removes_rows_and_edit_backups() {
        let db = test_db().await;
        let dir = temp_dir("success");
        let a = dir.join("a.jpg");
        let b = dir.join("b.jpg");
        let keep = dir.join("keep.jpg");
        write_file(&a);
        write_file(&b);
        write_file(&keep);
        insert_item(&db, "a", &a).await;
        insert_item(&db, "b", &b).await;
        insert_item(&db, "keep", &keep).await;

        let backup = dir.join("a-original.jpg");
        write_file(&backup);
        sqlx::query(
            "INSERT INTO edit_backups (media_id, original_path, backup_path, size, sha256, created_at) VALUES ('a', ?, ?, 4, NULL, 1)",
        )
        .bind(a.to_string_lossy().into_owned())
        .bind(backup.to_string_lossy().into_owned())
        .execute(&db)
        .await
        .expect("insert edit backup");

        let fake = Arc::new(FakeTrash::default());
        let sink: Arc<dyn TrashSink> = fake.clone();
        let group = super::super::CancelGroup::default();
        let cancel = group.start();
        let outcome = execute_trash(
            &db,
            vec![
                ("a".to_string(), a.to_string_lossy().into_owned()),
                ("b".to_string(), b.to_string_lossy().into_owned()),
            ],
            sink,
            &cancel,
            |_, _, _| {},
        )
        .await
        .expect("trash targets");

        assert_eq!(outcome.trashed, vec!["a".to_string(), "b".to_string()]);
        assert!(outcome.failed.is_empty());
        assert_eq!(
            fake.moved(),
            vec![
                a.to_string_lossy().into_owned(),
                b.to_string_lossy().into_owned()
            ]
        );
        // Only the trashed rows are gone; unrelated items survive.
        assert_eq!(catalog_ids(&db).await, vec!["keep"]);
        // The journaled original was cleaned up.
        assert!(!backup.exists(), "edit backup should be removed");
    }

    /// Per-file failures are reported and leave failed rows in the catalog
    /// for a retry.
    #[tokio::test]
    async fn partial_failures_keep_their_rows_and_report_ids() {
        let db = test_db().await;
        let dir = temp_dir("partial");
        let good = dir.join("good.jpg");
        let bad = dir.join("bad.jpg");
        write_file(&good);
        write_file(&bad);
        insert_item(&db, "good", &good).await;
        insert_item(&db, "bad", &bad).await;

        let fake = Arc::new(FakeTrash {
            fail_paths: HashSet::from([bad.to_string_lossy().into_owned()]),
            moved: Mutex::new(Vec::new()),
        });
        let sink: Arc<dyn TrashSink> = fake.clone();
        let group = super::super::CancelGroup::default();
        let cancel = group.start();
        let outcome = execute_trash(
            &db,
            vec![
                ("good".to_string(), good.to_string_lossy().into_owned()),
                ("bad".to_string(), bad.to_string_lossy().into_owned()),
            ],
            sink,
            &cancel,
            |_, _, _| {},
        )
        .await
        .expect("trash targets");

        assert_eq!(outcome.trashed, vec!["good".to_string()]);
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].id, "bad");
        assert!(outcome.failed[0].error.contains("permission denied"));
        assert_eq!(catalog_ids(&db).await, vec!["bad"]);
    }

    /// A panicking sink makes `spawn_blocking` return a JoinError. Every id in
    /// that chunk must be reported, otherwise the rows stay in the catalog
    /// while the UI believes nothing happened to them.
    struct PanickingTrash;

    impl TrashSink for PanickingTrash {
        fn delete_all(&self, _paths: &[String]) -> Result<(), CommandError> {
            panic!("trash backend panicked");
        }
    }

    #[tokio::test]
    async fn a_panicking_trash_reports_every_id_in_the_chunk() {
        let db = test_db().await;
        let dir = temp_dir("panic");
        let mut targets = Vec::new();
        for name in ["a", "b", "c"] {
            let path = dir.join(format!("{name}.jpg"));
            write_file(&path);
            insert_item(&db, name, &path).await;
            targets.push((name.to_string(), path.to_string_lossy().into_owned()));
        }

        let sink: Arc<dyn TrashSink> = Arc::new(PanickingTrash);
        let group = super::super::CancelGroup::default();
        let cancel = group.start();
        let outcome = execute_trash(&db, targets, sink, &cancel, |_, _, _| {})
            .await
            .expect("trash targets");

        assert!(outcome.trashed.is_empty());
        let ids: Vec<&str> = outcome.failed.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"], "every id must be reported");
        assert!(outcome.failed[0].error.contains("Trash task failed"));
        // Nothing was reported as trashed, so every row must still be there.
        assert_eq!(catalog_ids(&db).await, vec!["a", "b", "c"]);
    }

    /// The files are already in the Trash when the catalog update runs, so a
    /// failure there is a warning, not a failed delete.
    #[tokio::test]
    async fn a_catalog_failure_is_a_warning_not_a_failed_delete() {
        let db = test_db().await;
        let dir = temp_dir("catalog");
        let a = dir.join("a.jpg");
        write_file(&a);
        insert_item(&db, "a", &a).await;
        sqlx::query("DROP TABLE edit_backups")
            .execute(&db)
            .await
            .expect("drop edit_backups");

        let sink: Arc<dyn TrashSink> = Arc::new(FakeTrash::default());
        let group = super::super::CancelGroup::default();
        let cancel = group.start();
        let outcome = execute_trash(
            &db,
            vec![("a".to_string(), a.to_string_lossy().into_owned())],
            sink,
            &cancel,
            |_, _, _| {},
        )
        .await
        .expect("a catalog failure must not fail the delete");

        assert_eq!(outcome.trashed, vec!["a".to_string()]);
        let warning = outcome.catalog_error.expect("catalog warning expected");
        assert!(
            warning.contains("could not"),
            "warning should explain the failure: {warning}"
        );
    }

    /// Cancel must stop a trash run between batches — and only that run.
    #[tokio::test]
    async fn cancelling_a_trash_run_stops_between_batches_and_spares_other_runs() {
        let db = test_db().await;
        let dir = temp_dir("cancel");
        let group = Arc::new(super::super::CancelGroup::default());

        // 51 targets cross the 50-file batch boundary exactly once.
        let mut targets = Vec::new();
        for index in 0..51 {
            let id = format!("item-{index:02}");
            let path = dir.join(format!("{id}.jpg"));
            write_file(&path);
            insert_item(&db, &id, &path).await;
            targets.push((id, path.to_string_lossy().into_owned()));
        }

        let fake = Arc::new(FakeTrash::default());
        let sink: Arc<dyn TrashSink> = fake.clone();
        let cancel = group.start();
        // `execute_trash`'s progress callback is `Fn`, so count with an atomic.
        let batches = std::sync::atomic::AtomicUsize::new(0);
        let outcome = execute_trash(&db, targets.clone(), sink, &cancel, |_, _, current| {
            // The final summary call passes no current file; only count batches.
            if current.is_some() {
                batches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // Cancel after the first batch has been handed to Finder.
                group.cancel_all();
            }
        })
        .await
        .expect("trash targets");

        assert_eq!(
            batches.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the cancel is seen before the second batch"
        );
        assert_eq!(outcome.trashed.len(), 50);
        assert_eq!(
            fake.moved().len(),
            50,
            "the cancelled batch must never reach the trash backend"
        );
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].id, "item-50");
        assert_eq!(outcome.failed[0].code, crate::errors::ErrorCode::Cancelled);

        // A run that starts after the cancel owns a fresh flag and completes.
        let after = group.start();
        assert!(!after.is_cancelled());
        let extra = dir.join("after.jpg");
        write_file(&extra);
        insert_item(&db, "after", &extra).await;
        let second_fake = Arc::new(FakeTrash::default());
        let outcome = execute_trash(
            &db,
            vec![("after".to_string(), extra.to_string_lossy().into_owned())],
            second_fake.clone(),
            &after,
            |_, _, _| {},
        )
        .await
        .expect("second trash run");

        assert_eq!(outcome.trashed, vec!["after".to_string()]);
        assert_eq!(second_fake.moved().len(), 1);
        assert!(outcome.failed.is_empty());
    }

    /// The fallback decision depends on this classifier: only a refused
    /// Automation permission means no file has moved yet.
    #[cfg(target_os = "macos")]
    #[test]
    fn apple_events_denials_are_recognised() {
        use super::is_apple_events_denied;

        assert!(is_apple_events_denied(
            "execution error: Not authorized to send Apple events to Finder. (-1743)"
        ));
        assert!(is_apple_events_denied(
            "0:67: execution error: Finder got an error: Not allowed to send Apple events to Finder. (-1743)"
        ));
        assert!(is_apple_events_denied("osascript: error -1743"));
        // A missing file must keep its error so the per-file retry can report
        // the real reason instead of silently re-trashing the batch.
        assert!(!is_apple_events_denied(
            "execution error: Finder got an error: Can’t get POSIX file \"/tmp/gone.jpg\". (-1728)"
        ));
    }
}

#[cfg(test)]
mod edit_backup_tests {
    use super::ensure_edit_backup_in_dir;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::path::PathBuf;

    async fn test_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create media_items");
        sqlx::query(
            "CREATE TABLE edit_backups (media_id TEXT PRIMARY KEY, original_path TEXT NOT NULL, backup_path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT, created_at INTEGER NOT NULL)",
        )
        .execute(&db)
        .await
        .expect("create edit_backups");
        db
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "visto-edit-backup-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[tokio::test]
    async fn first_edit_journals_the_original_only_once() {
        let db = test_db().await;
        let dir = temp_dir("once");
        let source = dir.join("photo.jpg");
        std::fs::write(&source, b"original-bytes").unwrap();
        sqlx::query("INSERT INTO media_items (id, path) VALUES ('item-1', ?)")
            .bind(source.to_string_lossy().into_owned())
            .execute(&db)
            .await
            .unwrap();

        let backup_dir = dir.join("originals");
        let backup =
            ensure_edit_backup_in_dir(&db, &backup_dir, "item-1", source.to_str().unwrap())
                .await
                .expect("journal original");
        assert_eq!(std::fs::read(&backup).unwrap(), b"original-bytes");

        // A second edit must keep the true original, not the first edit.
        std::fs::write(&source, b"first-edit").unwrap();
        let reused =
            ensure_edit_backup_in_dir(&db, &backup_dir, "item-1", source.to_str().unwrap())
                .await
                .expect("reuse journal");
        assert_eq!(reused, backup);
        assert_eq!(std::fs::read(&backup).unwrap(), b"original-bytes");
    }

    #[tokio::test]
    async fn missing_journaled_original_fails_closed() {
        let db = test_db().await;
        let dir = temp_dir("missing");
        let source = dir.join("photo.jpg");
        std::fs::write(&source, b"edited-bytes").unwrap();
        sqlx::query("INSERT INTO media_items (id, path) VALUES ('item-2', ?)")
            .bind(source.to_string_lossy().into_owned())
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO edit_backups (media_id, original_path, backup_path, size, sha256, created_at) VALUES ('item-2', ?, ?, 1, NULL, 1)",
        )
        .bind(source.to_string_lossy().into_owned())
        .bind(dir.join("originals").join("missing.jpg").to_string_lossy().into_owned())
        .execute(&db)
        .await
        .unwrap();

        let error = ensure_edit_backup_in_dir(
            &db,
            &dir.join("originals"),
            "item-2",
            source.to_str().unwrap(),
        )
        .await
        .expect_err("missing original should fail closed");
        assert!(error.message.contains("missing"));
    }
}

#[cfg(test)]
mod in_place_edit_tests {
    use super::*;

    fn work_dir(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("visto-in-place-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create work dir");
        dir
    }

    fn request_for(source: &std::path::Path) -> RenderRequest {
        RenderRequest {
            source_path: source.to_string_lossy().into_owned(),
            media_id: Some("item-1".to_string()),
            edits: EditValues::default(),
            output_format: "in_place".to_string(),
            quality: 90.0,
            strip_metadata: false,
            crop: None,
        }
    }

    #[test]
    fn in_place_edit_keeps_mode_and_extended_attributes() {
        let dir = work_dir("metadata");
        let source = dir.join("photo.png");
        image::RgbaImage::from_pixel(16, 16, image::Rgba([12, 34, 56, 255]))
            .save(&source)
            .expect("write source image");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o640))
                .expect("set mode");
        }
        let tag = "com.visto-gallery.test";
        let xattr_supported = xattr::set(&source, tag, b"keep-me").is_ok();

        let backup = dir.join("journaled-original.png");
        std::fs::write(&backup, b"journal").expect("write backup placeholder");
        let result = render_edited_blocking(request_for(&source), Some(backup.clone()))
            .expect("in-place edit should succeed");

        assert_eq!(result.output_path, source.to_string_lossy());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&source).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o640, "in-place edit must keep the file mode");
        }
        if xattr_supported {
            assert_eq!(
                xattr::get(&source, tag).unwrap().as_deref(),
                Some(&b"keep-me"[..]),
                "in-place edit must keep Finder tags and other xattrs"
            );
        }

        // The replacement must not leave its temp sibling behind, and the
        // journaled original must not be touched.
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "journaled-original.png".to_string(),
                "photo.png".to_string()
            ],
            "only the file and its journal may remain"
        );
        assert_eq!(std::fs::read(&backup).unwrap(), b"journal");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn in_place_edit_requires_a_journaled_original() {
        let dir = work_dir("no-journal");
        let source = dir.join("photo.png");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]))
            .save(&source)
            .expect("write source image");

        let error = match render_edited_blocking(request_for(&source), None) {
            Ok(_) => panic!("in-place edits without a journal must fail closed"),
            Err(error) => error,
        };
        assert!(error.message.contains("journaled original"));

        let _ = std::fs::remove_dir_all(dir);
    }
}
