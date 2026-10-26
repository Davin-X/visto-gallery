mod albums;
mod batch;
mod duplicates;
mod library;
mod media;
mod settings;
use crate::{models::*, AppState};
pub use albums::*;
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
pub use batch::*;
pub use duplicates::*;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageEncoder};
pub use library::*;
pub use media::*;
use notify::Watcher;
use serde::{Deserialize, Serialize};
use serde_json::json;
pub use settings::*;
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use time::OffsetDateTime;
use uuid::Uuid;

// ===== Request/Response Types =====
//
// Every struct that crosses the IPC boundary is annotated `rename_all =
// "camelCase"`, so Rust's snake_case fields line up with the TypeScript
// interfaces in src/engine/types. Commands take plain (flattened) arguments
// rather than a wrapper struct, because that is what the flat camelCase
// payloads in src/engine/commands/tauri.ts send.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub items: Vec<MediaItem>,
    pub discovered_count: usize,
    /// Rows removed because their files no longer exist under the scanned root.
    pub removed_count: usize,
    pub cancelled: bool,
    pub albums: Vec<Album>,
    pub tags: Vec<Tag>,
    pub total_size: i64,
    pub duration: i64,
}

/// A folder in the library, either explicitly imported or inferred from the
/// on-disk location of items added before folder tracking existed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    pub path: String,
    pub name: String,
    pub item_count: i64,
    pub total_size: i64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFilterDTO {
    pub kind: Option<String>,
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    pub album_id: Option<String>,
    pub query: Option<String>,
    pub tags: Option<Vec<String>>,
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    pub limit: Option<i32>,
    pub offset: Option<i32>,
    pub sort_by: Option<String>,
    pub sort_order: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifData {
    pub captured_at: Option<i64>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub exposure: Option<String>,
    pub iso: Option<i32>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub metadata_error: Option<String>,
}

#[allow(dead_code)]
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PartialExifData {
    pub captured_at: Option<i64>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub exposure: Option<String>,
    pub iso: Option<i32>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub source_path: String,
    pub edits: EditValues,
    pub output_format: String,
    pub quality: f32,
    pub strip_metadata: bool,
    pub crop: Option<CropRect>,
}

#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditValues {
    pub exposure: i32,
    pub contrast: i32,
    pub warmth: i32,
    pub shadows: i32,
    pub highlights: i32,
    pub saturation: i32,
    pub rotation: i32,
    pub flip: bool,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_path: String,
    pub size: i64,
    pub width: i32,
    pub height: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportRequest {
    pub items: Vec<BatchExportItem>,
    pub output_folder: String,
    pub pattern: String,
    pub format: String,
    pub quality: f32,
    pub strip_metadata: bool,
    pub max_dimension: Option<u32>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportItem {
    pub id: String,
    pub source_path: String,
    pub index: u32,
    /// `photo`, `video`, or `raw`. Optional so older callers still work.
    #[serde(default)]
    pub kind: Option<String>,
    /// Capture/modification time in milliseconds, used by the `{date}` token.
    #[serde(default)]
    pub date: Option<i64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportProgress {
    pub current: u32,
    pub total: u32,
    pub current_file: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportResult {
    pub exported: u32,
    pub failed: Vec<BatchExportError>,
    pub outputs: Vec<String>,
    pub cancelled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportError {
    pub item_id: String,
    pub error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    pub trashed: Vec<String>,
    pub failed: Vec<TrashError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashError {
    pub path: String,
    pub error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub id: String,
    pub sha256: String,
    pub size: i64,
    pub items: Vec<MediaItem>,
}

#[derive(Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PartialSettings {
    pub appearance: Option<String>,
    pub accent_color: Option<String>,
    pub sidebar_width: Option<i32>,
    pub show_extensions: Option<bool>,
    pub animate_transitions: Option<bool>,
    pub startup_view: Option<String>,
    pub open_last_folder: Option<bool>,
    pub restore_window_state: Option<bool>,
    pub default_layout: Option<String>,
    pub thumbnail_size: Option<String>,
    pub viewer_zoom_behavior: Option<String>,
    pub slideshow_interval: Option<i32>,
    pub slideshow_shuffle: Option<bool>,
    pub slideshow_loop: Option<bool>,
    pub video_auto_play: Option<bool>,
    pub video_loop: Option<bool>,
    pub watch_folders: Option<Vec<String>>,
    pub auto_import: Option<bool>,
    pub pair_raw_jpeg: Option<bool>,
    pub stack_bursts: Option<bool>,
    pub stack_live_photos: Option<bool>,
    pub max_cache_size_gb: Option<i32>,
    pub thumbnail_quality: Option<i32>,
    pub enable_debug_logging: Option<bool>,
    pub show_native_limit_warnings: Option<bool>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub appearance: String,
    pub accent_color: String,
    pub sidebar_width: i32,
    pub show_extensions: bool,
    pub animate_transitions: bool,
    pub startup_view: String,
    pub open_last_folder: bool,
    pub restore_window_state: bool,
    pub default_layout: String,
    pub thumbnail_size: String,
    pub viewer_zoom_behavior: String,
    pub slideshow_interval: i32,
    pub slideshow_shuffle: bool,
    pub slideshow_loop: bool,
    pub video_auto_play: bool,
    pub video_loop: bool,
    pub watch_folders: Vec<String>,
    pub auto_import: bool,
    pub pair_raw_jpeg: bool,
    pub stack_bursts: bool,
    pub stack_live_photos: bool,
    pub max_cache_size_gb: i32,
    pub thumbnail_quality: i32,
    pub enable_debug_logging: bool,
    pub show_native_limit_warnings: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: "system".to_string(),
            accent_color: "blue".to_string(),
            sidebar_width: 220,
            show_extensions: false,
            animate_transitions: true,
            startup_view: "library".to_string(),
            open_last_folder: true,
            restore_window_state: true,
            default_layout: "grid".to_string(),
            thumbnail_size: "small".to_string(),
            viewer_zoom_behavior: "fit".to_string(),
            slideshow_interval: 5,
            slideshow_shuffle: false,
            slideshow_loop: true,
            video_auto_play: true,
            video_loop: false,
            watch_folders: vec![],
            auto_import: false,
            pair_raw_jpeg: true,
            stack_bursts: true,
            stack_live_photos: true,
            max_cache_size_gb: 5,
            thumbnail_quality: 80,
            enable_debug_logging: false,
            show_native_limit_warnings: true,
        }
    }
}

// ===== Helper Functions =====

/// Album rows with their item count folded in, so `Album.item_count` is always a
/// real column on the result set.
const ALBUM_SELECT: &str = "SELECT a.id, a.name, a.color_index, a.created_at, a.updated_at, \
     (SELECT COUNT(*) FROM album_items ai JOIN media_items m ON m.id = ai.media_id \
      WHERE ai.album_id = a.id AND m.hidden = 0) AS item_count FROM albums a";

/// Tag rows with their item count folded in, mirroring [`ALBUM_SELECT`].
const TAG_SELECT: &str = "SELECT t.id, t.name, t.color_index, t.created_at, \
     (SELECT COUNT(*) FROM media_tags mt JOIN media_items m ON m.id = mt.media_id \
      WHERE mt.tag_id = t.id AND m.hidden = 0) AS item_count FROM tags t";

/// Shared cooperative cancellation flag for folder scans, file imports, and
/// duplicate hashing. Each operation clears it before starting and checks it
/// between filesystem work units.
static SCAN_CANCEL: AtomicBool = AtomicBool::new(false);
static TRASH_CANCEL: AtomicBool = AtomicBool::new(false);
static DUPLICATE_CANCEL: AtomicBool = AtomicBool::new(false);
static BATCH_CANCEL: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn cancel_scan() -> Result<(), String> {
    SCAN_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn cancel_move_to_trash() -> Result<(), String> {
    TRASH_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

fn get_db(state: &State<'_, AppState>) -> Result<SqlitePool, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    Ok(guard
        .as_ref()
        .ok_or("Database not initialized".to_string())?
        .pool()
        .clone())
}

fn now_ms() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

/// Normalize a folder path so comparisons do not depend on a trailing slash.
fn normalize_root(path: &str) -> String {
    if path.len() > 1 {
        path.trim_end_matches('/').to_string()
    } else {
        path.to_string()
    }
}

/// True if `path` is inside any registered library root.
fn is_path_under_registered_roots(path: &str, registered: &[String]) -> bool {
    let file = normalize_root(path);
    registered.iter().any(|root| {
        let r = normalize_root(root);
        r.is_empty() || r == "/" || path_is_inside(&file, &r) || file == r
    })
}

fn validate_path_under_registered_roots(path: &str, registered: &[String]) -> Result<(), String> {
    if registered.is_empty() {
        return Ok(());
    }
    if is_path_under_registered_roots(path, registered) {
        Ok(())
    } else {
        Err("Path is outside registered library folders.".to_string())
    }
}

/// True when `path` sits inside `root`. Uses a real directory-boundary check so
/// `/Photos2/a.jpg` is never counted as part of `/Photos`.
fn path_is_inside(path: &str, root: &str) -> bool {
    let file = normalize_root(path);
    let root = normalize_root(root);
    if root == "/" {
        return file.starts_with('/');
    }
    file.len() > root.len() && file.starts_with(&root) && file.as_bytes()[root.len()] == b'/'
}

/// Record an imported folder so the sidebar can list and remove it later.
/// Failures are non-fatal: a catalog write should never fail an import.
async fn remember_folder(db: &SqlitePool, root: &str, app: &tauri::AppHandle) {
    let path = normalize_root(root);
    if path.is_empty() || !Path::new(&path).is_dir() {
        return;
    }
    let _ = sqlx::query("INSERT OR IGNORE INTO library_folders (path, added_at) VALUES (?, ?)")
        .bind(&path)
        .bind(now_ms())
        .execute(db)
        .await;
    let _ = app.asset_protocol_scope().allow_directory(&path, true);
}

fn is_media_file(ext: &str) -> bool {
    let image_exts = [
        "avif", "bmp", "gif", "heic", "heif", "jfif", "jpe", "jpeg", "jpg", "jxl", "png", "tif",
        "tiff", "webp",
    ];
    let raw_exts = [
        "3fr", "ari", "arw", "bay", "cap", "cr2", "cr3", "dcs", "dcr", "dng", "drf", "eip", "erf",
        "fff", "gpr", "iiq", "k25", "kdc", "mdc", "mef", "mos", "mrw", "nef", "nrw", "obm", "orf",
        "pef", "ptx", "pxn", "r3d", "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f",
    ];
    let video_exts = ["m4v", "mov", "mp4", "mpeg", "mpg", "webm"];
    image_exts.contains(&ext) || raw_exts.contains(&ext) || video_exts.contains(&ext)
}

fn kind_for_ext(ext: &str) -> &'static str {
    let video_exts = ["m4v", "mov", "mp4", "mpeg", "mpg", "webm"];
    let raw_exts = [
        "3fr", "ari", "arw", "bay", "cap", "cr2", "cr3", "dcs", "dcr", "dng", "drf", "eip", "erf",
        "fff", "gpr", "iiq", "k25", "kdc", "mdc", "mef", "mos", "mrw", "nef", "nrw", "obm", "orf",
        "pef", "ptx", "pxn", "r3d", "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f",
    ];
    if video_exts.contains(&ext) {
        "video"
    } else if raw_exts.contains(&ext) {
        "raw"
    } else {
        "photo"
    }
}

/// Read file facts needed by the catalog without decoding the image payload.
/// Folder scans and direct imports share this inspection path.
fn inspect_media_file(path: &Path, now: i64) -> Option<(MediaItem, Option<i32>, Option<i32>)> {
    let metadata = std::fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())?;
    inspect_media_file_with_metadata(path, &metadata, now)
}

fn inspect_media_file_with_metadata(
    path: &Path,
    metadata: &std::fs::Metadata,
    now: i64,
) -> Option<(MediaItem, Option<i32>, Option<i32>)> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !is_media_file(&ext) {
        return None;
    }

    let size = metadata.len() as i64;
    let modified_at = file_modified_at(metadata);

    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let kind = kind_for_ext(&ext).to_string();

    // Read dimensions from the file header only; no full decode.
    let (width, height) = if kind == "photo" {
        match image::image_dimensions(path) {
            Ok((w, h)) => (Some(w as i32), Some(h as i32)),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    let mut item = MediaItem::new(
        path.to_string_lossy().to_string(),
        name,
        ext,
        kind,
        size,
        modified_at,
    );
    item.created_at = now;
    item.updated_at = now;

    // Upsert on the stable id. `favorite` and `hidden` are left out of the
    // UPDATE clause so a re-import refreshes file facts without discarding the
    // user's own state.
    Some((item, width, height))
}

fn file_modified_at(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .map(|time| {
            time.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64
        })
        .unwrap_or(0)
}

/// Upsert a bounded group of inspected files in one SQLite statement. Batches
/// stay below SQLite's parameter limit while avoiding one IPC/database round
/// trip per file during a large folder scan.
async fn upsert_media_batch(
    db: &SqlitePool,
    rows: &[(MediaItem, Option<i32>, Option<i32>)],
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, width, height, created_at, updated_at, favorite, hidden) ",
    );
    query.push_values(rows, |mut values, (item, width, height)| {
        values
            .push_bind(&item.id)
            .push_bind(&item.path)
            .push_bind(&item.name)
            .push_bind(&item.extension)
            .push_bind(&item.kind)
            .push_bind(item.size)
            .push_bind(item.modified_at)
            .push_bind(item.captured_at)
            .push_bind(width)
            .push_bind(height)
            .push_bind(item.created_at)
            .push_bind(item.updated_at)
            .push_bind(0i32)
            .push_bind(0i32);
    });
    query.push(
        " ON CONFLICT(id) DO UPDATE SET path = excluded.path, name = excluded.name, extension = excluded.extension, kind = excluded.kind, size = excluded.size, modified_at = excluded.modified_at, width = excluded.width, height = excluded.height, updated_at = excluded.updated_at, sha256 = CASE WHEN excluded.size != media_items.size OR excluded.modified_at != media_items.modified_at THEN NULL ELSE media_items.sha256 END",
    );
    query.build().execute(db).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove catalog rows whose files disappeared from a source that was just
/// walked successfully.
///
/// This is deliberately conservative: the caller only invokes it after a
/// complete, uncancelled walk with no directory errors. A disconnected drive or
/// an unreadable subfolder must never wipe the catalog.
async fn prune_missing_items(
    db: &SqlitePool,
    root: &str,
    seen_paths: &HashSet<String>,
) -> Result<usize, String> {
    let candidates: Vec<(String, String)> = sqlx::query_as("SELECT id, path FROM media_items")
        .fetch_all(db)
        .await
        .map_err(|error| error.to_string())?;

    let missing: Vec<String> = candidates
        .into_iter()
        .filter(|(_, path)| path_is_inside(path, root) && !seen_paths.contains(path))
        .map(|(id, _)| id)
        .collect();
    if missing.is_empty() {
        return Ok(0);
    }

    // Stay below SQLite's bound-parameter limit and delete every relation in
    // one transaction so a partial prune cannot leave orphaned album/tag rows.
    const DELETE_CHUNK: usize = 500;
    let mut transaction = db.begin().await.map_err(|error| error.to_string())?;
    for chunk in missing.chunks(DELETE_CHUNK) {
        for table in ["media_tags", "album_items"] {
            let mut query =
                QueryBuilder::<Sqlite>::new(format!("DELETE FROM {table} WHERE media_id IN ("));
            let mut values = query.separated(", ");
            for id in chunk {
                values.push_bind(id);
            }
            values.push_unseparated(")");
            query
                .build()
                .execute(&mut *transaction)
                .await
                .map_err(|error| error.to_string())?;
        }

        let mut query = QueryBuilder::<Sqlite>::new("DELETE FROM media_items WHERE id IN (");
        let mut values = query.separated(", ");
        for id in chunk {
            values.push_bind(id);
        }
        values.push_unseparated(")");
        query
            .build()
            .execute(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;

    Ok(missing.len())
}

async fn import_media_file(
    db: &SqlitePool,
    path: &Path,
    now: i64,
) -> Result<Option<(MediaItem, i64)>, String> {
    let Some((item, width, height)) = inspect_media_file(path, now) else {
        return Ok(None);
    };
    let size = item.size;
    upsert_media_batch(db, &[(item.clone(), width, height)]).await?;
    Ok(Some((item, size)))
}

// ===== Commands =====

/// Replace characters macOS rejects in filenames and collapse whitespace.
fn sanitize_batch_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().to_string();
    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed
    }
}

fn batch_output_extension(format: &str, source: &Path) -> String {
    match format {
        "jpeg" => "jpg".to_string(),
        "png" => "png".to_string(),
        "webp" => "webp".to_string(),
        _ => source
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .filter(|ext| !ext.is_empty())
            .unwrap_or_else(|| "jpg".to_string()),
    }
}

fn batch_date_label(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp(ms / 1000)
        .map(|dt| {
            format!(
                "{:04}-{:02}-{:02}",
                dt.year(),
                u8::from(dt.month()),
                dt.day()
            )
        })
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Render the filename pattern exactly the way the Batch screen previews it.
fn render_batch_filename(
    item: &BatchExportItem,
    pattern: &str,
    date_ms: Option<i64>,
    extension: &str,
) -> String {
    let source = Path::new(&item.source_path);
    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("export");
    let number = format!("{:03}", item.index + 1);
    let date = date_ms
        .map(batch_date_label)
        .unwrap_or_else(|| "unknown".to_string());
    let template = if pattern.trim().is_empty() {
        "{name}_{number}"
    } else {
        pattern
    };

    let rendered = template
        .replace("{name}", &sanitize_batch_name(stem))
        .replace("{number}", &number)
        .replace("{date}", &date)
        .replace("{ext}", extension);
    let rendered = sanitize_batch_name(&rendered);

    // The pattern may include an extension; always finish with the extension
    // that matches the bytes we are about to write.
    let path = Path::new(&rendered);
    let existing_ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if existing_ext.is_empty() {
        format!("{}.{}", rendered, extension)
    } else if existing_ext == extension || (extension == "jpg" && existing_ext == "jpeg") {
        rendered
    } else {
        let base = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or(&rendered);
        format!("{}.{}", sanitize_batch_name(base), extension)
    }
}

/// Never overwrite an existing export (or a name used earlier in this batch).
fn unique_batch_path(folder: &Path, file_name: &str, used: &mut HashSet<String>) -> PathBuf {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("export");
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");

    let mut candidate = file_name.to_string();
    let mut suffix = 2;
    while used.contains(&candidate.to_ascii_lowercase()) || folder.join(&candidate).exists() {
        candidate = if extension.is_empty() {
            format!("{}-{}", stem, suffix)
        } else {
            format!("{}-{}.{}", stem, suffix, extension)
        };
        suffix += 1;
    }
    used.insert(candidate.to_ascii_lowercase());
    folder.join(candidate)
}

fn resize_batch_image(image: DynamicImage, max_dimension: u32) -> DynamicImage {
    let (width, height) = image.dimensions();
    let longest = width.max(height);
    if longest == 0 || longest <= max_dimension {
        return image;
    }
    let scale = max_dimension as f64 / longest as f64;
    let next_width = ((width as f64) * scale).round().max(1.0) as u32;
    let next_height = ((height as f64) * scale).round().max(1.0) as u32;
    image.resize_exact(
        next_width,
        next_height,
        image::imageops::FilterType::Lanczos3,
    )
}

fn write_batch_jpeg(image: DynamicImage, path: &Path, quality: u8) -> Result<(), String> {
    let rgb = image.to_rgb8();
    let file = std::fs::File::create(path)
        .map_err(|e| format!("Could not create the export file: {}", e))?;
    let mut writer = std::io::BufWriter::new(file);
    JpegEncoder::new_with_quality(&mut writer, quality)
        .encode(
            &rgb,
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("JPEG encoding failed: {}", e))
}

fn write_batch_png(image: DynamicImage, path: &Path) -> Result<(), String> {
    let file = std::fs::File::create(path)
        .map_err(|e| format!("Could not create the export file: {}", e))?;
    let writer = std::io::BufWriter::new(file);
    PngEncoder::new_with_quality(writer, CompressionType::Default, FilterType::Adaptive)
        .write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
        .map_err(|e| format!("PNG encoding failed: {}", e))
}

fn write_batch_webp(image: DynamicImage, path: &Path) -> Result<(), String> {
    let file = std::fs::File::create(path)
        .map_err(|e| format!("Could not create the export file: {}", e))?;
    let mut writer = std::io::BufWriter::new(file);
    WebPEncoder::new_lossless(&mut writer)
        .encode(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
        .map_err(|e| format!("WebP encoding failed: {}", e))
}

/// macOS ImageIO can decode HEIC/HEIF and other formats the Rust `image`
/// crate cannot. `sips` exposes that pipeline on every Mac, so use it as a
/// fallback for JPEG/PNG targets.
fn write_batch_with_sips(
    source: &Path,
    output: &Path,
    extension: &str,
    quality: u8,
    max_dimension: Option<u32>,
) -> Result<(), String> {
    let format = match extension {
        "jpg" | "jpeg" => "jpeg",
        "png" => "png",
        other => return Err(format!("Unsupported fallback format: {}", other)),
    };

    let mut command = std::process::Command::new("/usr/bin/sips");
    if let Some(max) = max_dimension.filter(|dim| *dim > 0) {
        command.arg("-Z").arg(max.to_string());
    }
    command.arg("-s").arg("format").arg(format);
    if format == "jpeg" {
        command
            .arg("-s")
            .arg("formatOptions")
            .arg(quality.to_string());
    }
    let result = command
        .arg(source)
        .arg("--out")
        .arg(output)
        .output()
        .map_err(|e| format!("Could not run the macOS image converter: {}", e))?;

    if !result.status.success() || !output.exists() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            "macOS could not decode this image.".to_string()
        } else {
            detail.to_string()
        });
    }
    Ok(())
}

fn export_batch_item(
    item: &BatchExportItem,
    request: &BatchExportRequest,
    folder: &Path,
    quality: u8,
    used: &mut HashSet<String>,
) -> Result<PathBuf, String> {
    let source = Path::new(&item.source_path);
    if !source.is_file() {
        return Err("Source file not found on disk.".to_string());
    }

    let output_ext = batch_output_extension(&request.format, source);
    let date = item.date.or_else(|| {
        std::fs::metadata(source)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
    });
    let file_name = render_batch_filename(item, &request.pattern, date, &output_ext);
    let output_path = unique_batch_path(folder, &file_name, used);

    let converting = request.format != "source";
    let resizing = request.max_dimension.map(|dim| dim > 0).unwrap_or(false);
    let kind = item.kind.as_deref().unwrap_or("photo");

    // Videos and RAW files cannot be decoded by the built-in image encoder.
    // They can still be renamed and copied without modification.
    if kind == "video" || kind == "raw" {
        if converting || resizing || request.strip_metadata {
            let message = if kind == "video" {
                "Video conversion is not supported yet. Choose “Keep source format” and turn off resizing and metadata stripping to copy videos."
            } else {
                "RAW conversion needs native macOS image support. Choose “Keep source format” and turn off resizing and metadata stripping to copy RAW files."
            };
            return Err(message.to_string());
        }
        std::fs::copy(source, &output_path)
            .map_err(|e| format!("Could not copy the file: {}", e))?;
        return Ok(output_path);
    }

    // A straight copy preserves the original bytes (and its metadata) exactly.
    if !converting && !resizing && !request.strip_metadata {
        std::fs::copy(source, &output_path)
            .map_err(|e| format!("Could not copy the file: {}", e))?;
        return Ok(output_path);
    }

    let image = match image::open(source) {
        Ok(image) => image,
        Err(decode_error) => {
            // HEIC/HEIF and some camera formats are only decodable through
            // macOS ImageIO. Fall back to `sips` when writing JPEG or PNG,
            // and use a temporary PNG when the target is WebP.
            let fallback_ext = match output_ext.as_str() {
                "jpg" | "jpeg" | "png" => output_ext.clone(),
                "webp" => "png".to_string(),
                _ => return Err(format!("Could not decode this image: {}", decode_error)),
            };
            let direct = fallback_ext == output_ext;
            let target = if direct {
                output_path.clone()
            } else {
                folder.join(format!(".visto-gallery-{}.png", Uuid::new_v4()))
            };

            if let Err(fallback_error) = write_batch_with_sips(
                source,
                &target,
                &fallback_ext,
                quality,
                request.max_dimension,
            ) {
                if !direct {
                    std::fs::remove_file(&target).ok();
                }
                return Err(format!(
                    "Could not decode this image: {} ({})",
                    decode_error, fallback_error
                ));
            }

            if direct {
                return Ok(output_path);
            }

            let decoded = image::open(&target)
                .map_err(|e| format!("Could not read the converted image: {}", e))?;
            let result = write_batch_webp(decoded, &output_path);
            std::fs::remove_file(&target).ok();
            return result.map(|_| output_path);
        }
    };
    let image = match request.max_dimension.filter(|dim| *dim > 0) {
        Some(max_dimension) => resize_batch_image(image, max_dimension),
        None => image,
    };

    match output_ext.as_str() {
        "jpg" | "jpeg" => write_batch_jpeg(image, &output_path, quality)?,
        "png" => write_batch_png(image, &output_path)?,
        "webp" => write_batch_webp(image, &output_path)?,
        other => {
            return Err(format!(
                "Can’t write .{} files yet. Choose JPEG, PNG, or WebP.",
                other
            ))
        }
    }

    Ok(output_path)
}

#[tauri::command]
pub async fn write_finder_tags(
    path: String,
    tags: Vec<String>,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let plist_tags: Vec<plist::Value> = tags
            .into_iter()
            .map(|t| plist::Value::String(format!("{}\x000", t)))
            .collect();
        let mut buf = Vec::new();
        plist::to_writer_binary(&mut buf, &plist::Value::Array(plist_tags))
            .map_err(|e| e.to_string())?;
        xattr::set(&path, "com.apple.metadata:_kMDItemUserTags", &buf)
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_finder_tags(
    path: String,
    _state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let value =
            xattr::get(&path, "com.apple.metadata:_kMDItemUserTags").map_err(|e| e.to_string())?;
        let Some(bytes) = value else {
            return Ok(vec![]);
        };
        let plist_value: plist::Value = plist::from_bytes(&bytes).map_err(|e| e.to_string())?;
        let mut tags = Vec::new();
        if let Some(arr) = plist_value.as_array() {
            for v in arr {
                if let Some(s) = v.as_string() {
                    let name = s.split('\x00').next().unwrap_or(s).to_string();
                    if !name.is_empty() && !tags.contains(&name) {
                        tags.push(name);
                    }
                }
            }
        }
        Ok(tags)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Apply a single persisted (key, value) pair onto an `AppSettings` struct.
/// Shared by `get_settings` and `save_settings` so the parse contract lives in
/// one place. Unknown keys are ignored gracefully.
fn apply_setting(settings: &mut AppSettings, key: &str, value: &str) {
    match key {
        "appearance" => settings.appearance = value.to_string(),
        "accent_color" => settings.accent_color = value.to_string(),
        "sidebar_width" => settings.sidebar_width = value.parse().unwrap_or(220),
        "show_extensions" => settings.show_extensions = value.parse().unwrap_or(false),
        "animate_transitions" => settings.animate_transitions = value.parse().unwrap_or(true),
        "startup_view" => settings.startup_view = value.to_string(),
        "open_last_folder" => settings.open_last_folder = value.parse().unwrap_or(true),
        "restore_window_state" => settings.restore_window_state = value.parse().unwrap_or(true),
        "default_layout" => settings.default_layout = value.to_string(),
        "thumbnail_size" => settings.thumbnail_size = value.to_string(),
        "viewer_zoom_behavior" => settings.viewer_zoom_behavior = value.to_string(),
        "slideshow_interval" => settings.slideshow_interval = value.parse().unwrap_or(5),
        "slideshow_shuffle" => settings.slideshow_shuffle = value.parse().unwrap_or(false),
        "slideshow_loop" => settings.slideshow_loop = value.parse().unwrap_or(true),
        "video_auto_play" => settings.video_auto_play = value.parse().unwrap_or(true),
        "video_loop" => settings.video_loop = value.parse().unwrap_or(false),
        "watch_folders" => {
            settings.watch_folders = serde_json::from_str(value).unwrap_or_default();
        }
        "auto_import" => settings.auto_import = value.parse().unwrap_or(false),
        "pair_raw_jpeg" => settings.pair_raw_jpeg = value.parse().unwrap_or(true),
        "stack_bursts" => settings.stack_bursts = value.parse().unwrap_or(true),
        "stack_live_photos" => settings.stack_live_photos = value.parse().unwrap_or(true),
        "max_cache_size_gb" => settings.max_cache_size_gb = value.parse().unwrap_or(5),
        "thumbnail_quality" => settings.thumbnail_quality = value.parse().unwrap_or(80),
        "enable_debug_logging" => settings.enable_debug_logging = value.parse().unwrap_or(false),
        "show_native_limit_warnings" => {
            settings.show_native_limit_warnings = value.parse().unwrap_or(true)
        }
        _ => {}
    }
}

#[tauri::command]
pub async fn get_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

/// Purge the entire library catalog (media items, tags, albums, folders and
/// library folders, import sessions) while leaving original media files on disk.
/// This is irreversible through the UI.
#[tauri::command]
pub async fn delete_library_database(state: State<'_, AppState>) -> Result<(), String> {
    let db = get_db(&state)?;
    sqlx::query("DELETE FROM media_items")
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM media_tags")
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM album_items")
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM albums")
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM tags")
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM library_folders")
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn check_updates() -> Result<serde_json::Value, String> {
    Ok(json!({ "available": false }))
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let allowed = trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("mailto:");
    if !allowed {
        return Err("Unsupported URL scheme".to_string());
    }
    std::process::Command::new("open")
        .arg(trimmed)
        .status()
        .map_err(|e| format!("Could not open {}: {}", trimmed, e))?;
    Ok(())
}
/// Secure export: the backend owns path selection via native dialog.
/// Writes to a temp file next to the destination, then renames atomically.
#[tauri::command]
pub async fn get_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    let db = get_db(&state)?;
    let tags = sqlx::query_as::<_, Tag>(&format!("{} ORDER BY t.name ASC", TAG_SELECT))
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(tags)
}
