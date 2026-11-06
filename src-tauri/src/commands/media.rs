use super::*;
use crate::AppState;
use image::{DynamicImage, ImageEncoder};
use serde_json::json;
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use tauri::{Manager, State, Window};

/// Load the subset of `paths` that currently exist as catalog rows.
async fn cataloged_paths(
    db: &sqlx::SqlitePool,
    paths: &[String],
) -> Result<HashSet<String>, String> {
    let mut found = HashSet::new();
    // Keep the IN list below SQLite's default parameter limit.
    for chunk in paths.chunks(400) {
        let mut query =
            sqlx::QueryBuilder::<sqlx::Sqlite>::new("SELECT path FROM media_items WHERE path IN (");
        {
            let mut separated = query.separated(", ");
            for path in chunk {
                separated.push_bind(path);
            }
        }
        query.push(")");
        let rows: Vec<String> = query
            .build_query_scalar()
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?;
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
) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "File no longer exists on disk.".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Refusing to move a symbolic link to Trash.".to_string());
    }
    if !metadata.is_file() {
        return Err("Only regular files can be moved to Trash.".to_string());
    }
    if cataloged.contains(path) {
        return Ok(());
    }
    if registered.is_empty() {
        return Err(
            "File is not in the catalog and no library folders are registered.".to_string(),
        );
    }
    if is_path_under_registered_roots(path, registered) {
        Ok(())
    } else {
        Err("Path is outside registered library folders and not in the catalog.".to_string())
    }
}

#[tauri::command]
pub async fn move_to_trash(
    paths: Vec<String>,
    state: State<'_, AppState>,
    window: Window,
) -> Result<TrashResult, String> {
    super::TRASH_CANCEL.store(false, Ordering::SeqCst);

    let db = super::get_db(&state)?;
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    let cataloged = cataloged_paths(&db, &paths).await?;

    // Take ownership of the request before shadowing `paths` with the
    // validated subset.
    let requested = paths;

    // Never silently drop a requested path: every rejected path is reported
    // back to the caller so the UI can explain what did not happen.
    let mut failed = Vec::new();
    let mut paths: Vec<String> = Vec::with_capacity(requested.len());
    for path in requested {
        match validate_trash_path(&path, &cataloged, &registered) {
            Ok(()) => paths.push(path),
            Err(error) => failed.push(TrashError { path, error }),
        }
    }
    if paths.is_empty() {
        return Ok(TrashResult {
            trashed: Vec::new(),
            failed,
        });
    }

    let _ = window.emit(
        "import-progress",
        json!({
            "phase": "trashing",
            "processed": 0,
            "total": paths.len(),
        }),
    );

    let mut trashed = Vec::new();

    // Trash in chunks using trash::delete_all, which moves many files in a
    // single OS-level operation (much faster than one-by-one). Fall back to
    // per-file deletes if a chunk fails so partial results are still reported.
    const TRASH_CHUNK: usize = 50;
    let total = paths.len();
    let mut processed = 0usize;
    for chunk in paths.chunks(TRASH_CHUNK) {
        if super::TRASH_CANCEL.load(Ordering::SeqCst) {
            for p in chunk {
                failed.push(TrashError {
                    path: p.clone(),
                    error: "Operation cancelled".to_string(),
                });
            }
            processed += chunk.len();
            continue;
        }

        let _ = window.emit(
            "import-progress",
            json!({
                "phase": "trashing",
                "processed": processed,
                "total": total,
                "currentFile": chunk.first().cloned().unwrap_or_default(),
            }),
        );

        let chunk_paths: Vec<String> = chunk.to_vec();
        let result = tokio::task::spawn_blocking(move || trash::delete_all(&chunk_paths)).await;

        match result {
            Ok(Ok(())) => {
                trashed.extend(chunk.iter().cloned());
            }
            _ => {
                // Fallback: try each file individually so partial successes count.
                for path in chunk {
                    if super::TRASH_CANCEL.load(Ordering::SeqCst) {
                        failed.push(TrashError {
                            path: path.clone(),
                            error: "Operation cancelled".to_string(),
                        });
                        continue;
                    }
                    match tokio::task::spawn_blocking({
                        let path = path.clone();
                        move || trash::delete(&path)
                    })
                    .await
                    {
                        Ok(Ok(())) => trashed.push(path.clone()),
                        Ok(Err(e)) => failed.push(TrashError {
                            path: path.clone(),
                            error: format!("Could not move to Trash: {}", e),
                        }),
                        Err(e) => failed.push(TrashError {
                            path: path.clone(),
                            error: format!("Trash task failed: {}", e),
                        }),
                    }
                }
            }
        }

        processed += chunk.len();
    }

    let _ = window.emit(
        "import-progress",
        json!({
            "phase": "trashing",
            "processed": paths.len(),
            "total": paths.len(),
        }),
    );

    if !trashed.is_empty() {
        let mut transaction = db.begin().await.map_err(|e| e.to_string())?;
        let mut backup_files = Vec::new();
        for path in &trashed {
            // Collect journaled originals before the FK cascade removes their
            // rows, so the files do not linger in app data forever.
            let backups: Vec<String> = sqlx::query_scalar(
                "SELECT b.backup_path FROM edit_backups b \
                 JOIN media_items m ON m.id = b.media_id WHERE m.path = ?",
            )
            .bind(path)
            .fetch_all(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
            backup_files.extend(backups);

            sqlx::query("DELETE FROM media_items WHERE path = ?")
                .bind(path)
                .execute(&mut *transaction)
                .await
                .map_err(|e| e.to_string())?;
        }
        transaction.commit().await.map_err(|e| e.to_string())?;
        for backup in backup_files {
            let _ = std::fs::remove_file(backup);
        }
    }

    Ok(TrashResult { trashed, failed })
}

#[tauri::command]
pub async fn reveal_in_finder(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = super::get_db(&state)?;
    let exists: Option<String> = sqlx::query_scalar("SELECT path FROM media_items WHERE path = ?")
        .bind(&path)
        .fetch_optional(&db)
        .await
        .map_err(|e| e.to_string())?;
    if exists.is_none() {
        return Err("Path is not part of the catalog.".to_string());
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| format!("Could not reveal {}: {}", path, e))?;
    Ok(())
}

#[tauri::command]
pub async fn open_file(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = super::get_db(&state)?;
    let exists: Option<String> = sqlx::query_scalar("SELECT path FROM media_items WHERE path = ?")
        .bind(&path)
        .fetch_optional(&db)
        .await
        .map_err(|e| e.to_string())?;
    if exists.is_none() {
        return Err("Path is not part of the catalog.".to_string());
    }
    std::process::Command::new("open")
        .arg(&path)
        .status()
        .map_err(|e| format!("Could not open {}: {}", path, e))?;
    Ok(())
}

/// A desktop video player that can decode containers WebKit cannot (notably
/// Matroska/`.mkv` and `.avi`), exposed to the viewer so unsupported videos can
/// be handed off instead of failing silently.
#[derive(serde::Serialize)]
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
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = super::get_db(&state)?;
    let exists: Option<String> = sqlx::query_scalar("SELECT path FROM media_items WHERE path = ?")
        .bind(&path)
        .fetch_optional(&db)
        .await
        .map_err(|e| e.to_string())?;
    if exists.is_none() {
        return Err("Path is not part of the catalog.".to_string());
    }

    let player_path = PathBuf::from(&player);
    if player_path.extension().and_then(|ext| ext.to_str()) != Some("app") || !player_path.is_dir()
    {
        return Err("Requested player is not an installed application.".to_string());
    }

    std::process::Command::new("open")
        .arg("-a")
        .arg(&player_path)
        .arg(&path)
        .status()
        .map_err(|e| format!("Could not open {} with {}: {}", path, player, e))?;
    Ok(())
}

/// Open a folder in Finder. Used by Batch export results.
#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    // Unlike `open -R` (which selects a file in its parent), this opens the
    // folder itself in Finder. Used by Batch export results.
    if !std::path::Path::new(&path).is_dir() {
        return Err("Path is not a directory.".to_string());
    }
    std::process::Command::new("open")
        .arg(&path)
        .status()
        .map_err(|e| format!("Could not open {}: {}", path, e))?;
    Ok(())
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

    if let Some(field) = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
        let s = field.display_value().to_string();
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&s, "%Y:%m:%d %H:%M:%S") {
            data.captured_at = Some(dt.and_utc().timestamp_millis());
        }
    }
    let make = exif
        .get_field(exif::Tag::Make, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string());
    let model = exif
        .get_field(exif::Tag::Model, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string());
    data.camera = match (make, model) {
        (Some(m), Some(modl)) => Some(format!("{} {}", m.trim(), modl.trim())),
        (Some(m), None) => Some(m.trim().to_string()),
        (None, Some(modl)) => Some(modl.trim().to_string()),
        _ => None,
    };
    if let Some(f) = exif.get_field(exif::Tag::LensModel, exif::In::PRIMARY) {
        data.lens = Some(f.display_value().to_string().trim().to_string());
    }
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
        let lat_ref = exif
            .get_field(exif::Tag::GPSLatitudeRef, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string())
            .unwrap_or_else(|| "N".to_string());
        let lon_ref = exif
            .get_field(exif::Tag::GPSLongitudeRef, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string())
            .unwrap_or_else(|| "E".to_string());

        if let (Some(la), Some(lo)) = (dms_to_decimal(lat), dms_to_decimal(lon)) {
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
pub async fn read_exif(path: String, state: State<'_, AppState>) -> Result<ExifData, String> {
    let db = super::get_db(&state)?;
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    validate_path_under_registered_roots(&path, &registered)?;
    let path_buf = std::path::PathBuf::from(&path);
    let data = tokio::task::spawn_blocking(move || extract_exif(&path_buf))
        .await
        .map_err(|e| e.to_string())?;
    Ok(data)
}

/// In-place edits re-encode the source and atomically replace it. Only
/// formats we can round-trip safely are eligible; anything else (HEIC, TIFF,
/// AVIF, …) would lose data silently, so it must go through "Save a copy".
pub(crate) fn validate_in_place_format(source_path: &str) -> Result<(), String> {
    let ext = source_path
        .rsplit('.')
        .next()
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
        return Ok(());
    }
    Err(format!(
        "In-place export supports JPEG, PNG and WebP (refusing .{ext}). Use \"Save a copy\" to keep the original untouched."
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
) -> Result<PathBuf, String> {
    if let Some(row) = sqlx::query("SELECT backup_path FROM edit_backups WHERE media_id = ?")
        .bind(media_id)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?
    {
        let recorded: String = row.get("backup_path");
        if std::path::Path::new(&recorded).is_file() {
            return Ok(PathBuf::from(recorded));
        }
        return Err(
            "The journaled original for this item is missing; use \"Save a copy\" instead of replacing it."
                .to_string(),
        );
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
        .map_err(|e| format!("Backup task failed: {e}"))?
        .map_err(|e| format!("Failed to journal the original before editing: {e}"))?;

    let size = std::fs::metadata(&backup_path)
        .map_err(|e| format!("Could not read the journaled original: {e}"))?
        .len() as i64;
    let hash_path = backup_path.clone();
    let hash = tokio::task::spawn_blocking(move || compute_sha256(&hash_path))
        .await
        .map_err(|e| format!("Hash task failed: {e}"))?;

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
    .map_err(|e| e.to_string())?;

    // If a concurrent edit won the race, keep its record and drop our copy.
    let recorded: String =
        sqlx::query_scalar("SELECT backup_path FROM edit_backups WHERE media_id = ?")
            .bind(media_id)
            .fetch_one(db)
            .await
            .map_err(|e| e.to_string())?;
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
) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not locate the app data folder: {e}"))?;
    ensure_edit_backup_in_dir(db, &app_dir.join("edit-originals"), media_id, source_path).await
}

#[tauri::command]
pub async fn render_edited(
    request: RenderRequest,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ExportResult, String> {
    // Validate the source path against registered library folders before doing
    // any work, so a crafted request cannot read arbitrary files.
    let db = super::get_db(&state)?;
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    if !registered.is_empty() {
        super::validate_path_under_registered_roots(&request.source_path, &registered)?;
    }

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
                .await
                .map_err(|e| e.to_string())?;
        match catalog_path {
            Some(path) if path == request.source_path => {}
            Some(_) => {
                return Err(
                    "The requested file does not match the catalog entry for this item."
                        .to_string(),
                )
            }
            None => {
                return Err(
                    "Item is not in the catalog; in-place edits are not allowed.".to_string(),
                )
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
            .map_err(|e| format!("Task failed: {}", e))??;

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
) -> Result<ExportResult, String> {
    use std::path::PathBuf;

    let source_path = PathBuf::from(&request.source_path);

    // 1. Load image with metadata
    let reader = image::ImageReader::open(&source_path)
        .map_err(|e| format!("Could not open image: {}", e))?
        .with_guessed_format()
        .map_err(|e| format!("Could not identify image format: {}", e))?;

    let _format = reader.format().ok_or("Unknown image format")?;
    let mut img = reader
        .decode()
        .map_err(|e| format!("Could not decode image: {}", e))?;

    let (orig_width, orig_height) = (img.width(), img.height());

    // 2. Read EXIF data before any modifications (for preservation)
    let exif_data = read_exif_bytes(&source_path);

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
            return Err("Missing journaled original for in-place edit.".to_string());
        }

        let tmp_path = source_path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));

        // Write to temp
        write_image(
            &img,
            &tmp_path,
            &write_format,
            request.quality,
            request.strip_metadata,
            &exif_data,
        )?;

        // Atomic rename. If it fails, the source is untouched; keep the
        // journaled original intact for a later revert.
        std::fs::rename(&tmp_path, &source_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("Failed to replace original: {}", e)
        })?;

        source_path.to_string_lossy().into_owned()
    } else {
        // Save a copy - caller handles path via dialog
        // We write to a temp location and return the path
        let tmp_dir = std::env::temp_dir();
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

        write_image(
            &img,
            &output_path,
            &write_format,
            request.quality,
            request.strip_metadata,
            &exif_data,
        )?;

        output_path.to_string_lossy().into_owned()
    };

    // 8. Verify output
    let metadata = std::fs::metadata(&output_path)
        .map_err(|e| format!("Output verification failed: {}", e))?;
    let size = metadata.len() as i64;

    Ok(ExportResult {
        output_path,
        size,
        width: final_width as i32,
        height: final_height as i32,
    })
}

/// Move an exported temp file to its final destination.
#[tauri::command]
pub async fn move_exported_file(
    source_path: String,
    destination_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Validate the source unless it is an app-generated temp file. The
    // destination is user-chosen via a save dialog and is not constrained.
    let in_temp = std::path::Path::new(&source_path)
        .ancestors()
        .any(|p| p == std::env::temp_dir());
    if !in_temp {
        let db = super::get_db(&state)?;
        let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
            .fetch_all(&db)
            .await
            .map_err(|e| e.to_string())?;
        super::validate_path_under_registered_roots(&source_path, &registered)?;
    }

    tokio::task::spawn_blocking(move || {
        use std::path::PathBuf;
        let src = PathBuf::from(&source_path);
        let dst = PathBuf::from(&destination_path);

        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create destination folder: {}", e))?;
        }

        // Prefer an atomic rename; fall back to copy+remove for cross-device moves.
        if std::fs::rename(&src, &dst).is_ok() {
            return Ok(());
        }

        std::fs::copy(&src, &dst).map_err(|e| format!("Could not copy exported file: {}", e))?;
        let _ = std::fs::remove_file(&src);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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

/// Write image with format-specific options, optionally preserving EXIF
fn write_image(
    img: &DynamicImage,
    path: &PathBuf,
    format: &str,
    quality: f32,
    strip_metadata: bool,
    exif_data: &Option<Vec<u8>>,
) -> Result<(), String> {
    let quality = (quality * 100.0).round().clamp(1.0, 100.0) as u8;

    match format {
        "image/png" => {
            let encoder = image::codecs::png::PngEncoder::new_with_quality(
                std::fs::File::create(path).map_err(|e| e.to_string())?,
                image::codecs::png::CompressionType::Default,
                image::codecs::png::FilterType::default(),
            );
            encoder
                .write_image(
                    img.as_bytes(),
                    img.width(),
                    img.height(),
                    img.color().into(),
                )
                .map_err(|e| e.to_string())?;
        }
        "image/webp" => {
            let encoder = image::codecs::webp::WebPEncoder::new_lossless(
                std::fs::File::create(path).map_err(|e| e.to_string())?,
            );
            encoder
                .write_image(
                    img.as_bytes(),
                    img.width(),
                    img.height(),
                    img.color().into(),
                )
                .map_err(|e| e.to_string())?;
        }
        _ => {
            // JPEG default
            // For JPEG, we can preserve EXIF by injecting it
            let mut file = std::fs::File::create(path).map_err(|e| e.to_string())?;

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
                    encoder
                        .write_image(
                            rgb.as_raw(),
                            rgb.width(),
                            rgb.height(),
                            image::ExtendedColorType::Rgb8,
                        )
                        .map_err(|e| e.to_string())?;
                }
            } else {
                // Strip metadata explicitly requested
                let encoder =
                    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, quality);
                encoder
                    .write_image(
                        rgb.as_raw(),
                        rgb.width(),
                        rgb.height(),
                        image::ExtendedColorType::Rgb8,
                    )
                    .map_err(|e| e.to_string())?;
            }
            file.flush().map_err(|e| e.to_string())?;
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
) -> Result<(), String> {
    use std::io::Write;

    // Encode to a memory buffer first.
    let mut buffer = Vec::new();
    {
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality);
        encoder
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| e.to_string())?;
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
        return Err("Encoded JPEG is missing SOI marker.".to_string());
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

    file.write_all(&output).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod exif_tests {
    use super::{compute_sha256, read_exif_bytes, write_jpeg_with_exif};
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
pub async fn backfill_metadata(state: State<'_, AppState>) -> Result<i64, String> {
    let db = super::get_db(&state)?;
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, path FROM media_items WHERE captured_at IS NULL OR camera IS NULL OR sha256 IS NULL",
    )
    .fetch_all(&db)
    .await
    .map_err(|e| e.to_string())?;

    let mut updated = 0i64;
    for (id, path) in rows {
        let path_buf = std::path::PathBuf::from(&path);
        let exif_path = path_buf.clone();
        let exif = tokio::task::spawn_blocking(move || extract_exif(&exif_path))
            .await
            .map_err(|e| e.to_string())?;
        if exif.metadata_error.is_some() && exif.captured_at.is_none() && exif.camera.is_none() {
            continue;
        }
        // Compute SHA-256 only when it's missing; skip if file is unreadable.
        let sha256 = if path_buf.exists() {
            tokio::task::spawn_blocking(move || compute_sha256(&path_buf))
                .await
                .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?;
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
                err.contains("Save a copy"),
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
    use super::validate_trash_path;
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
        assert!(error.contains("outside registered library folders"));
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
        assert!(error.contains("no longer exists"));
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
        assert!(error.contains("symbolic link"));
    }

    #[test]
    fn directories_are_rejected() {
        let dir = temp_dir("directories");
        let registered = vec![dir.to_string_lossy().into_owned()];

        let error = validate_trash_path(dir.to_str().unwrap(), &HashSet::new(), &registered)
            .expect_err("directory should be rejected");
        assert!(error.contains("Only regular files"));
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
        assert!(error.contains("missing"));
    }
}
