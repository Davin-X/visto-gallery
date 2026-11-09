mod access;
mod albums;
mod backup;
mod batch;
mod duplicates;
mod edit_recipes;
mod library;
mod media;
mod roots;
mod scan_jobs;
mod settings;
mod smart_albums;
mod temp_files;
mod update;
use crate::{models::*, AppState, Catalog};
pub use access::*;
pub use albums::*;
use anyhow::Result;
pub use backup::*;
pub use batch::*;
pub use duplicates::*;
pub use edit_recipes::*;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageEncoder};
pub use library::*;
pub use media::*;
use notify::Watcher;
pub use roots::*;
pub use scan_jobs::ScanJobs;
use serde::{Deserialize, Serialize};
pub use settings::*;
pub use smart_albums::*;
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
pub use temp_files::*;
use time::OffsetDateTime;
pub use update::*;
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
    /// False when the folder no longer exists on disk (registered source was
    /// deleted or moved outside the app).
    pub available: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFilterDTO {
    pub kind: Option<String>,
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    /// `Some(true)` narrows to animated items, `Some(false)` to still ones.
    /// Independent of `kind`, which keeps its photo | video | raw meaning.
    pub animated: Option<bool>,
    pub album_id: Option<String>,
    pub query: Option<String>,
    pub tags: Option<Vec<String>>,
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    pub source_path: Option<String>,
    pub rating: Option<i32>,
    pub color_label: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub limit: Option<i32>,
    /// Opaque cursor returned by a previous `get_library_items` page.
    pub cursor: Option<String>,
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub source_path: String,
    /// Catalog id of the item. Required for in-place edits so the original can
    /// be journaled under a stable key.
    pub media_id: Option<String>,
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
    pub kind: Option<crate::media_kind::MediaKind>,
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

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    /// Catalog ids that were moved to Trash.
    pub trashed: Vec<String>,
    pub failed: Vec<TrashError>,
    /// Set when the files reached the Trash but the catalog could not be
    /// updated. The move succeeded; the rows are stale until a rescan.
    pub catalog_error: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashError {
    pub id: String,
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
    pub check_for_updates_on_launch: Option<bool>,
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
    pub check_for_updates_on_launch: bool,
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
            // Automatic launch checks are opt-in. The explicit Help menu
            // action still works when this is false.
            check_for_updates_on_launch: false,
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

/// Cooperative cancellation flags for long operations that are not folder
/// scans or imports (those use per-job flags in [`ScanJobs`]).
static TRASH_CANCEL: AtomicBool = AtomicBool::new(false);
static DUPLICATE_CANCEL: AtomicBool = AtomicBool::new(false);
static BATCH_CANCEL: AtomicBool = AtomicBool::new(false);

/// Cancel every folder scan and file import that is running now.
#[tauri::command]
pub async fn cancel_scan(state: State<'_, AppState>) -> Result<(), String> {
    state.scan_jobs.cancel_all();
    Ok(())
}

#[tauri::command]
pub async fn cancel_move_to_trash() -> Result<(), String> {
    TRASH_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

fn get_db(catalog: &State<'_, Catalog>) -> Result<SqlitePool, String> {
    catalog.pool()
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
/// Resolve a path to its canonical form when possible. Falls back to
/// canonicalizing the parent and re-attaching the file name for paths that do
/// not exist yet (e.g. a write destination), so validation still works for
/// not-yet-created files.
fn canonical_path(path: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(path);
    if let Ok(c) = p.canonicalize() {
        return Some(c);
    }
    if let Some(parent) = p.parent() {
        if let Ok(pc) = parent.canonicalize() {
            if let Some(name) = p.file_name() {
                return Some(pc.join(name));
            }
        }
    }
    None
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
fn is_path_under_registered_roots(path: &str, registered: &[String]) -> bool {
    let Some(candidate) = canonical_path(path) else {
        return false;
    };
    registered.iter().any(|root| {
        let root_canonical =
            canonical_path(root).unwrap_or_else(|| std::path::PathBuf::from(normalize_root(root)));
        candidate == root_canonical || candidate.starts_with(&root_canonical)
    })
}

/// Validate that `path` resolves (after canonicalization, so symlinks and
/// `..` segments cannot escape) to a location inside one of the registered
/// library folders.
///
/// Returns an error when no roots are registered: an empty root set means
/// "deny everything", not "allow everything".
pub fn validate_path_under_registered_roots(
    path: &str,
    registered: &[String],
) -> Result<(), String> {
    if registered.is_empty() {
        return Err("No registered library folders; path access denied.".to_string());
    }
    if is_path_under_registered_roots(path, registered) {
        Ok(())
    } else {
        Err("Path is outside registered library folders.".to_string())
    }
}

/// Event asking the frontend to re-read catalog-wide counts.
///
/// `library-changed` is only emitted when rows are removed, and scans/imports
/// emit progress events only, so the sidebar and the type-chip counts used to
/// describe the catalog from before the import. Emitting this from the commands
/// that add rows covers every caller — picker, drag-and-drop, watch-folder
/// rescan — instead of relying on each UI path to refresh itself.
pub(crate) const LIBRARY_COUNTS_CHANGED: &str = "library-counts-changed";

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

/// Media kinds and extensions are defined once in [`crate::media_kind`].
/// The scanner, file picker, kind detection and SQL CHECK all derive from it.
fn is_media_file(ext: &str) -> bool {
    crate::media_kind::is_media_file(ext)
}

/// Returns the canonical list of supported media extensions, so the frontend
/// file picker and the backend scanner stay in sync.
#[tauri::command]
pub fn supported_extensions() -> Vec<String> {
    crate::media_kind::supported_extensions()
}

fn kind_for_ext(ext: &str) -> crate::media_kind::MediaKind {
    crate::media_kind::kind_for_ext(ext)
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
    let kind = kind_for_ext(&ext);

    // Reads container headers only (GIF blocks, WebP VP8X flags, PNG acTL,
    // ISOBMFF ftyp brands); no pixel decode. Formats that cannot animate are
    // answered without opening the file.
    let is_animated = crate::media_animation::detect_animation(path, &ext);
    let mut item = MediaItem::new(
        path.to_string_lossy().to_string(),
        name,
        ext.clone(),
        kind,
        size,
        modified_at,
    );
    item.created_at = now;
    item.updated_at = now;
    item.is_animated = is_animated;
    // Bounded read (size + the first and last 64 KiB) so a move can be
    // recognised later without ever reading a whole video.
    item.content_signature = crate::media_signature::content_signature(path);

    // Populate metadata from EXIF for photos.
    let mut exif_dims = None;
    if kind == crate::media_kind::MediaKind::Photo {
        let exif = crate::commands::media::extract_exif(path);
        item.captured_at = exif.captured_at;
        item.camera = exif.camera;
        item.lens = exif.lens;
        item.exposure = exif.exposure;
        item.iso = exif.iso;
        item.latitude = exif.latitude;
        item.longitude = exif.longitude;
        if let (Some(w), Some(h)) = (exif.width, exif.height) {
            exif_dims = Some((w.max(0) as u32, h.max(0) as u32));
        }
    }

    // Header-only dimension probe for every kind (image headers, HEIF/AVIF
    // and MP4/MOV boxes, EXIF, then ImageIO). The upsert stores the returned
    // pair, so it must carry every fallback, not just the first probe.
    let dims = crate::media_dimensions::probe_dimensions(path, &item.extension, kind, exif_dims);
    let (width, height) = match dims {
        Some((w, h)) => (Some(w as i32), Some(h as i32)),
        None => (None, None),
    };
    item.width = width;
    item.height = height;

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
        "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, width, height, camera, lens, exposure, iso, latitude, longitude, sha256, created_at, updated_at, favorite, hidden, is_animated, content_signature, rating, color_label) ",
    );
    query.push_values(rows, |mut values, (item, width, height)| {
        values
            .push_bind(&item.id)
            .push_bind(&item.path)
            .push_bind(&item.name)
            .push_bind(&item.extension)
            .push_bind(item.kind.as_str())
            .push_bind(item.size)
            .push_bind(item.modified_at)
            .push_bind(item.captured_at)
            .push_bind(width)
            .push_bind(height)
            .push_bind(&item.camera)
            .push_bind(&item.lens)
            .push_bind(&item.exposure)
            .push_bind(item.iso)
            .push_bind(item.latitude)
            .push_bind(item.longitude)
            .push_bind(&item.sha256)
            .push_bind(item.created_at)
            .push_bind(item.updated_at)
            .push_bind(0i32)
            .push_bind(0i32)
            .push_bind(if item.is_animated { 1i32 } else { 0i32 })
            .push_bind(&item.content_signature)
            .push_bind(item.rating)
            .push_bind(&item.color_label);
    });
    query.push(
        " ON CONFLICT(id) DO UPDATE SET path = excluded.path, name = excluded.name, extension = excluded.extension, kind = excluded.kind, size = excluded.size, modified_at = excluded.modified_at, captured_at = COALESCE(excluded.captured_at, media_items.captured_at), width = excluded.width, height = excluded.height, camera = COALESCE(excluded.camera, media_items.camera), lens = COALESCE(excluded.lens, media_items.lens), exposure = COALESCE(excluded.exposure, media_items.exposure), iso = COALESCE(excluded.iso, media_items.iso), latitude = COALESCE(excluded.latitude, media_items.latitude), longitude = COALESCE(excluded.longitude, media_items.longitude), sha256 = CASE WHEN excluded.size != media_items.size OR excluded.modified_at != media_items.modified_at THEN NULL ELSE media_items.sha256 END, updated_at = excluded.updated_at, favorite = media_items.favorite, hidden = media_items.hidden, is_animated = excluded.is_animated, content_signature = excluded.content_signature, rating = COALESCE(excluded.rating, media_items.rating), color_label = COALESCE(excluded.color_label, media_items.color_label)",
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

/// The single unused entry in `candidates`, or `None` when the match is
/// ambiguous. Guessing between two identical fingerprints could hand one file's
/// album membership to another, which is worse than importing a fresh row.
fn only_unused(candidates: Option<&Vec<usize>>, used: &[bool]) -> Option<usize> {
    let mut found = candidates?.iter().copied().filter(|index| !used[*index]);
    let index = found.next()?;
    if found.next().is_some() {
        return None;
    }
    Some(index)
}

/// Keep a moved or renamed file in the same catalog row.
///
/// The id is derived from the path, so otherwise a move looks like a delete plus
/// an unrelated import: the row (and with it the favourite flag, rating, tags
/// and album membership) would be dropped. The scan matches rows that vanished
/// from `root` against files that appeared in the same walk by content
/// fingerprint, then re-keys the surviving row — and every table that points at
/// it — to the new path.
///
/// Both sides must be unambiguous, so a file that was copied (a duplicate) or a
/// fingerprint shared by several vanished rows is left alone and handled by the
/// ordinary import/prune path.
async fn relink_moved_items(
    db: &SqlitePool,
    root: &str,
    seen_paths: &HashSet<String>,
) -> Result<usize, String> {
    let existing: Vec<(String, String)> = sqlx::query_as("SELECT id, path FROM media_items")
        .fetch_all(db)
        .await
        .map_err(|error| error.to_string())?;
    let existing_paths: HashSet<&str> = existing.iter().map(|(_, path)| path.as_str()).collect();
    let existing_ids: HashSet<&str> = existing.iter().map(|(id, _)| id.as_str()).collect();
    let mut added: Vec<&String> = seen_paths
        .iter()
        .filter(|path| !existing_paths.contains(path.as_str()))
        .collect();
    if added.is_empty() {
        return Ok(0);
    }

    let rows: Vec<(String, String, i64, i64, Option<String>)> =
        sqlx::query_as("SELECT id, path, size, modified_at, content_signature FROM media_items")
            .fetch_all(db)
            .await
            .map_err(|error| error.to_string())?;
    // Rows whose file this walk did not see are the only move candidates.
    let vanished: Vec<(&str, i64, i64, Option<String>)> = rows
        .iter()
        .filter(|(_, path, _, _, _)| path_is_inside(path, root) && !seen_paths.contains(path))
        .map(|(id, _, size, modified_at, signature)| {
            (id.as_str(), *size, *modified_at, signature.clone())
        })
        .collect();
    if vanished.is_empty() {
        return Ok(0);
    }

    let mut by_signature: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_fingerprint: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (index, (_, size, modified_at, signature)) in vanished.iter().enumerate() {
        match signature {
            // The signature covers the size, so equal signatures imply equal
            // content regardless of when the file was last touched.
            Some(signature) => by_signature
                .entry(signature.clone())
                .or_default()
                .push(index),
            // Rows imported before fingerprints existed can still follow a
            // same-volume move: macOS preserves the modification time.
            None => by_fingerprint
                .entry((*size, *modified_at))
                .or_default()
                .push(index),
        }
    }

    let mut used = vec![false; vanished.len()];
    let mut moves: Vec<(&str, String)> = Vec::new();
    added.sort();
    for new_path in added {
        let Ok(metadata) = std::fs::metadata(new_path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let signature = crate::media_signature::content_signature(Path::new(new_path));
        let index = match &signature {
            Some(signature) => only_unused(by_signature.get(signature), &used),
            None => only_unused(
                by_fingerprint.get(&(metadata.len() as i64, file_modified_at(&metadata))),
                &used,
            ),
        };
        let Some(index) = index else {
            continue;
        };
        // A hash collision must not rewrite another row's key.
        if existing_ids.contains(stable_id(new_path).as_str()) {
            continue;
        }
        used[index] = true;
        moves.push((vanished[index].0, new_path.clone()));
    }
    if moves.is_empty() {
        return Ok(0);
    }

    let now = now_ms();
    let mut transaction = db.begin().await.map_err(|error| error.to_string())?;
    // Relations point at the row being re-keyed, so enforcement is deferred to
    // COMMIT and every table is updated inside the same transaction.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
    for (old_id, new_path) in &moves {
        let path = Path::new(new_path);
        let new_id = stable_id(new_path);
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_lowercase();
        let modified_at = std::fs::metadata(path)
            .map(|metadata| file_modified_at(&metadata))
            .unwrap_or(0);
        sqlx::query(
            "UPDATE media_items SET id = ?, path = ?, name = ?, extension = ?, modified_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&new_id)
        .bind(new_path)
        .bind(&name)
        .bind(&extension)
        .bind(modified_at)
        .bind(now)
        .bind(old_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
        for table in ["media_tags", "album_items", "edit_recipes", "edit_backups"] {
            sqlx::query(&format!(
                "UPDATE {table} SET media_id = ? WHERE media_id = ?"
            ))
            .bind(&new_id)
            .bind(old_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
        }
    }
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;

    Ok(moves.len())
}

async fn import_media_file(
    db: &SqlitePool,
    path: &Path,
    now: i64,
) -> Result<Option<(MediaItem, i64)>, String> {
    let owned = path.to_path_buf();
    let inspected = tokio::task::spawn_blocking(move || inspect_media_file(&owned, now))
        .await
        .map_err(|e| format!("Import worker failed: {e}"))?;
    let Some((item, width, height)) = inspected else {
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
    let kind = item.kind.unwrap_or(crate::media_kind::MediaKind::Photo);

    // Videos and RAW files cannot be decoded by the built-in image encoder.
    // They can still be renamed and copied without modification.
    if kind == crate::media_kind::MediaKind::Video || kind == crate::media_kind::MediaKind::Raw {
        if converting || resizing || request.strip_metadata {
            let message = if kind == crate::media_kind::MediaKind::Video {
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

const FINDER_TAGS_ATTRIBUTE: &str = "com.apple.metadata:_kMDItemUserTags";

/** Base tag name without Finder's trailing `\0<color-index>` suffix. */
fn finder_tag_name(raw: &str) -> &str {
    raw.split('\x00').next().unwrap_or(raw)
}

/**
 * Merge app tags into the tags already present on a file.
 *
 * Existing Finder values (and their color suffix) are preserved verbatim and
 * stay first. Incoming tags are appended only when their case-insensitive name
 * is not already present, so a bulk copy never deletes a tag the user added in
 * Finder and never writes duplicates.
 */
fn merge_finder_tag_values(existing: &[String], incoming: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut merged = Vec::with_capacity(existing.len() + incoming.len());
    for raw in existing {
        let name = finder_tag_name(raw).trim();
        if name.is_empty() {
            continue;
        }
        if seen.insert(name.to_lowercase()) {
            merged.push(raw.clone());
        }
    }
    for tag in incoming {
        let name = tag.trim();
        if name.is_empty() {
            continue;
        }
        if seen.insert(name.to_lowercase()) {
            merged.push(format!("{}\x000", name));
        }
    }
    merged
}

fn read_raw_finder_tags(path: &str) -> Result<Vec<String>, String> {
    let value = xattr::get(path, FINDER_TAGS_ATTRIBUTE).map_err(|e| e.to_string())?;
    let Some(bytes) = value else {
        return Ok(vec![]);
    };
    let plist_value: plist::Value = plist::from_bytes(&bytes).map_err(|e| e.to_string())?;
    let mut tags = Vec::new();
    if let Some(arr) = plist_value.as_array() {
        for value in arr {
            if let Some(raw) = value.as_string() {
                tags.push(raw.to_string());
            }
        }
    }
    Ok(tags)
}

fn write_raw_finder_tags(path: &str, tags: &[String]) -> Result<(), String> {
    let plist_tags: Vec<plist::Value> = tags
        .iter()
        .map(|tag| plist::Value::String(tag.clone()))
        .collect();
    let mut buf = Vec::new();
    plist::to_writer_binary(&mut buf, &plist::Value::Array(plist_tags))
        .map_err(|e| e.to_string())?;
    xattr::set(path, FINDER_TAGS_ATTRIBUTE, &buf).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_finder_tags(
    path: String,
    tags: Vec<String>,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let values: Vec<String> = tags
            .into_iter()
            .filter(|tag| !tag.trim().is_empty())
            .map(|tag| format!("{}\x000", tag.trim()))
            .collect();
        write_raw_finder_tags(&path, &values)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merge VistoGallery tags into a file's existing Finder tags and return the
/// merged display names. Never removes an existing Finder-only tag.
#[tauri::command]
pub async fn merge_finder_tags(
    path: String,
    tags: Vec<String>,
    _state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let existing = read_raw_finder_tags(&path)?;
        let merged = merge_finder_tag_values(&existing, &tags);
        write_raw_finder_tags(&path, &merged)?;
        Ok::<Vec<String>, String>(
            merged
                .iter()
                .map(|raw| finder_tag_name(raw).trim().to_string())
                .filter(|name| !name.is_empty())
                .collect(),
        )
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
        let raw = read_raw_finder_tags(&path)?;
        let mut tags = Vec::new();
        let mut seen = HashSet::new();
        for value in raw {
            let name = finder_tag_name(&value).trim();
            if !name.is_empty() && seen.insert(name.to_lowercase()) {
                tags.push(name.to_string());
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
        "check_for_updates_on_launch" => {
            settings.check_for_updates_on_launch = value.parse().unwrap_or(false)
        }
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

/// Purge the library catalog (media items with their tags, album links, edit
/// recipes and edit-backup records, plus albums, tags, Smart Albums and
/// library folders) in one transaction, while leaving original media files on
/// disk. Also stops folder watchers and empties the thumbnail cache so nothing
/// keeps describing the old catalog. This is irreversible through the UI.
///
/// Kept on purpose: settings, edit presets, and the backed-up originals of
/// in-place edits under the app data folder (user data, never deleted here).
#[tauri::command]
pub async fn delete_library_database(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = get_db(&catalog)?;
    purge_catalog(&db).await?;

    if let Ok(mut watchers) = state.watchers.lock() {
        watchers.clear();
    }
    if let Ok(cache) = app.path().app_cache_dir() {
        let thumbnails = cache.join("thumbnails");
        let _ = tokio::fs::remove_dir_all(&thumbnails).await;
    }
    Ok(())
}

/// Delete every catalog row in one transaction: a failure part-way leaves the
/// catalog exactly as it was instead of half-deleted.
pub(crate) async fn purge_catalog(db: &SqlitePool) -> Result<(), String> {
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;
    // Children first, so this also works without foreign-key cascades.
    for table in [
        "media_tags",
        "album_items",
        "edit_recipes",
        "edit_backups",
        "media_items",
        "albums",
        "tags",
        "smart_albums",
        "library_folders",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Could not clear {table}: {e}"))?;
    }
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let allowed = trimmed.starts_with("https://") || trimmed.starts_with("mailto:");
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
pub async fn get_tags(catalog: State<'_, Catalog>) -> Result<Vec<Tag>, String> {
    let db = get_db(&catalog)?;
    let tags = sqlx::query_as::<_, Tag>(&format!("{} ORDER BY t.name ASC", TAG_SELECT))
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(tags)
}

#[cfg(test)]
mod path_validation_tests {
    use super::validate_path_under_registered_roots;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn tmp(label: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("visto-path-test-{}-{}", label, Uuid::new_v4()));
        fs::create_dir_all(&p).expect("create temp dir");
        p
    }

    #[test]
    fn empty_roots_denies_everything() {
        let root = tmp("root");
        let file = root.join("a.jpg");
        fs::write(&file, b"x").unwrap();
        assert!(validate_path_under_registered_roots(file.to_str().unwrap(), &[]).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn legitimate_nested_path_passes() {
        let root = tmp("root");
        let nested = root.join("sub").join("a.jpg");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, b"x").unwrap();
        let registered = vec![root.to_string_lossy().into_owned()];
        assert!(
            validate_path_under_registered_roots(nested.to_str().unwrap(), &registered).is_ok()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn traversal_is_rejected() {
        let root = tmp("root");
        let outside = std::env::temp_dir().join("visto-outside-traversal.jpg");
        fs::write(&outside, b"x").unwrap();
        // A `..` segment that escapes the root must be rejected.
        let escape = root.join("..").join(outside.file_name().unwrap());
        let registered = vec![root.to_string_lossy().into_owned()];
        assert!(
            validate_path_under_registered_roots(escape.to_str().unwrap(), &registered).is_err()
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn prefix_collision_is_rejected() {
        let base = tmp("base");
        let photos = base.join("Photos");
        let photos2 = base.join("Photos2");
        fs::create_dir_all(&photos).unwrap();
        fs::create_dir_all(&photos2).unwrap();
        let file = photos2.join("a.jpg");
        fs::write(&file, b"x").unwrap();
        let registered = vec![photos.to_string_lossy().into_owned()];
        assert!(validate_path_under_registered_roots(file.to_str().unwrap(), &registered).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn symlink_escape_is_rejected() {
        let root = tmp("root");
        let outside = tmp("outside");
        let outside_file = outside.join("secret.jpg");
        fs::write(&outside_file, b"x").unwrap();
        let link = root.join("escape.jpg");
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(&outside_file, &link);
        let registered = vec![root.to_string_lossy().into_owned()];
        // The symlink resolves outside the root, so it must be rejected.
        let result = validate_path_under_registered_roots(link.to_str().unwrap(), &registered);
        assert!(result.is_err(), "symlink escape should be rejected");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn exact_root_path_passes() {
        let root = tmp("root");
        let file = root.join("a.jpg");
        fs::write(&file, b"x").unwrap();
        let registered = vec![root.to_string_lossy().into_owned()];
        // The root directory itself is allowed.
        assert!(validate_path_under_registered_roots(root.to_str().unwrap(), &registered).is_ok());
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod finder_tag_merge_tests {
    use super::{finder_tag_name, merge_finder_tag_values};

    fn raw(name: &str) -> String {
        format!("{}\x000", name)
    }

    #[test]
    fn preserves_existing_tags_and_appends_new_ones() {
        let existing = vec![raw("Client"), raw("Paid")];
        let merged = merge_finder_tag_values(&existing, &["Travel".into(), "Paid".into()]);
        assert_eq!(
            merged,
            vec![raw("Client"), raw("Paid"), raw("Travel")],
            "existing tags stay first and duplicate app tags are skipped"
        );
    }

    #[test]
    fn deduplicates_case_insensitively_without_rewriting_existing_case() {
        let existing = vec![raw("Travel")];
        let merged = merge_finder_tag_values(&existing, &["travel".into(), "TRAVEL".into()]);
        assert_eq!(merged, vec![raw("Travel")]);
        assert_eq!(finder_tag_name(&merged[0]), "Travel");
    }

    #[test]
    fn ignores_empty_names_and_blank_app_tags() {
        let existing = vec!["\x000".to_string(), raw("Keep")];
        let merged = merge_finder_tag_values(&existing, &["  ".into(), "New".into()]);
        assert_eq!(merged, vec![raw("Keep"), raw("New")]);
    }

    #[test]
    fn empty_existing_tags_are_created_without_a_trailing_suffix() {
        let merged = merge_finder_tag_values(&[], &["Albums".into()]);
        assert_eq!(merged, vec![raw("Albums")]);
        assert_eq!(finder_tag_name(&merged[0]), "Albums");
    }
}

#[cfg(test)]
mod rescan_preservation_tests {
    use super::upsert_media_batch;
    use crate::models::MediaItem;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn media_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at INTEGER, width INTEGER, height INTEGER, camera TEXT, lens TEXT, exposure TEXT, iso INTEGER, latitude REAL, longitude REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, favorite INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, is_animated INTEGER NOT NULL DEFAULT 0, content_signature TEXT, sha256 TEXT, rating INTEGER, color_label TEXT)")
            .execute(&db)
            .await
            .expect("create media_items");
        db
    }

    #[tokio::test]
    async fn forced_rescan_preserves_favorite_and_hidden() {
        let db = media_db().await;
        let path = "/tmp/rescan-preserve.jpg".to_string();
        let item = MediaItem::new(
            path.clone(),
            "photo.jpg".into(),
            "jpg".into(),
            "photo".into(),
            10,
            1000,
        );
        upsert_media_batch(&db, &[(item.clone(), Some(800), Some(600))])
            .await
            .expect("initial upsert");

        // The user curates the item.
        sqlx::query("UPDATE media_items SET favorite = 1, hidden = 1 WHERE id = ?")
            .bind(&item.id)
            .execute(&db)
            .await
            .expect("curate");

        // A forced rescan re-upserts the same row.
        let rescanned = MediaItem::new(
            path,
            "photo.jpg".into(),
            "jpg".into(),
            "photo".into(),
            10,
            1000,
        );
        upsert_media_batch(&db, &[(rescanned, Some(800), Some(600))])
            .await
            .expect("rescan upsert");

        let (favorite, hidden): (i64, i64) =
            sqlx::query_as("SELECT favorite, hidden FROM media_items WHERE id = ?")
                .bind(&item.id)
                .fetch_one(&db)
                .await
                .expect("read back");
        assert_eq!(favorite, 1, "favorite must survive a forced rescan");
        assert_eq!(hidden, 1, "hidden must survive a forced rescan");
    }
}

#[cfg(test)]
mod purge_catalog_tests {
    use super::purge_catalog;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn migrated_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory catalog");
        sqlx::migrate!("./migrations")
            .run(&db)
            .await
            .expect("run migrations");
        db
    }

    async fn count(db: &sqlx::SqlitePool, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(db)
            .await
            .expect("count rows")
    }

    #[tokio::test]
    async fn purge_clears_catalog_tables_and_keeps_settings() {
        let db = migrated_db().await;
        for sql in [
            "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES ('m', '/p/a.jpg', 'a.jpg', 'jpg', 'photo', 1, 1, 1, 1)",
            "INSERT INTO albums (id, name, created_at, updated_at) VALUES ('a', 'Album', 1, 1)",
            "INSERT INTO album_items (album_id, media_id, added_at) VALUES ('a', 'm', 1)",
            "INSERT INTO library_folders (path, added_at) VALUES ('/p', 1)",
            "INSERT INTO smart_albums (id, name, filter_json, created_at, updated_at) VALUES ('s', 'Smart', '{}', 1, 1)",
            "INSERT INTO settings (key, value) VALUES ('appearance', '\"dark\"')",
        ] {
            sqlx::query(sql).execute(&db).await.expect(sql);
        }

        let settings_before = count(&db, "settings").await;
        purge_catalog(&db).await.expect("purge");

        for table in [
            "media_items",
            "albums",
            "album_items",
            "library_folders",
            "smart_albums",
        ] {
            assert_eq!(count(&db, table).await, 0, "{table} should be empty");
        }
        assert_eq!(count(&db, "settings").await, settings_before);
    }
}

#[cfg(test)]
mod extension_tests {
    use super::{is_media_file, kind_for_ext, supported_extensions};

    #[test]
    fn picker_list_and_scanner_agree() {
        let exts = supported_extensions();
        assert!(exts.iter().all(|ext| is_media_file(ext)));
        assert!(!is_media_file("txt"));
        let unique: std::collections::HashSet<_> = exts.iter().collect();
        assert_eq!(unique.len(), exts.len(), "no extension is listed twice");
    }

    #[test]
    fn kinds_follow_the_lists() {
        assert_eq!(kind_for_ext("mkv"), "video");
        assert_eq!(kind_for_ext("cr3"), "raw");
        assert_eq!(kind_for_ext("heic"), "photo");
    }
}
