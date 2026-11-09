mod access;
mod albums;
mod backup;
mod batch;
mod batch_pipeline;
mod cancel;
mod duplicates;
mod edit_recipes;
mod finder_tags;
mod library;
mod media;
mod roots;
mod scan_jobs;
mod settings;
mod smart_albums;
mod system;
mod temp_files;
mod update;
use crate::{models::*, Catalog};
pub use albums::*;
use anyhow::Result;
pub use backup::*;
pub use batch::*;
pub(crate) use batch_pipeline::export_batch_item;
pub use cancel::{cancel_move_to_trash, cancel_scan};
pub(crate) use cancel::{BATCH_CANCEL, DUPLICATE_CANCEL, TRASH_CANCEL};
pub use duplicates::*;
pub use edit_recipes::*;
pub use finder_tags::{merge_finder_tags, read_finder_tags, write_finder_tags};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageDecoder};
pub use library::*;
pub use media::*;
use notify::Watcher;
pub use roots::*;
pub use scan_jobs::ScanJobs;
pub use settings::*;
pub use smart_albums::*;
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
pub use system::{get_version, open_external};
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

mod dto;
pub(crate) mod repo;
pub mod security;
pub use dto::*;
pub use repo::{delete_library_database, get_tags};
pub(crate) use repo::{relink_moved_items, ALBUM_SELECT, TAG_SELECT};
// ===== Helper Functions =====

pub(crate) fn get_db(catalog: &State<'_, Catalog>) -> Result<SqlitePool, String> {
    catalog.pool()
}

pub(crate) fn now_ms() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

/// Normalize a folder path so comparisons do not depend on a trailing slash.
pub(crate) use security::paths::{
    authorize_import_path, is_path_under_registered_roots, normalize_root, path_is_inside,
};
pub use security::paths::{
    pick_media_files, pick_source_folders, validate_path_under_registered_roots, GrantedPaths,
};

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

pub(crate) fn file_modified_at(metadata: &std::fs::Metadata) -> i64 {
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
pub(crate) fn apply_setting(settings: &mut AppSettings, key: &str, value: &str) {
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
    use super::repo::purge_catalog;
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
