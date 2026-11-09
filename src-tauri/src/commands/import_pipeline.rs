//! Scan/import pipeline: file inspection, upsert, missing-item pruning, folder registration.

use std::collections::HashSet;
use std::path::Path;

use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use tauri::Manager;

use crate::commands::{normalize_root, now_ms, path_is_inside};
use crate::models::MediaItem;

pub(crate) const LIBRARY_COUNTS_CHANGED: &str = "library-counts-changed";

/// Record an imported folder so the sidebar can list and remove it later.
/// Failures are non-fatal: a catalog write should never fail an import.
pub(crate) async fn remember_folder(db: &SqlitePool, root: &str, app: &tauri::AppHandle) {
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
pub(crate) fn is_media_file(ext: &str) -> bool {
    crate::media_kind::is_media_file(ext)
}

/// Returns the canonical list of supported media extensions, so the frontend
/// file picker and the backend scanner stay in sync.
#[tauri::command]
pub fn supported_extensions() -> Vec<String> {
    crate::media_kind::supported_extensions()
}

pub(crate) fn kind_for_ext(ext: &str) -> crate::media_kind::MediaKind {
    crate::media_kind::kind_for_ext(ext)
}

/// Read file facts needed by the catalog without decoding the image payload.
/// Folder scans and direct imports share this inspection path.
pub(crate) fn inspect_media_file(
    path: &Path,
    now: i64,
) -> Option<(MediaItem, Option<i32>, Option<i32>)> {
    let metadata = std::fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())?;
    inspect_media_file_with_metadata(path, &metadata, now)
}

pub(crate) fn inspect_media_file_with_metadata(
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
pub(crate) async fn upsert_media_batch(
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
pub(crate) async fn prune_missing_items(
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

pub(crate) async fn import_media_file(
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
