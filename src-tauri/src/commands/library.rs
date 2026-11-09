use super::*;
use crate::{models::*, AppState};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{QueryBuilder, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{State, Window};
use walkdir::WalkDir;

#[tauri::command]
pub async fn scan_library(
    root_path: String,
    force: bool,
    state: State<'_, AppState>,
    window: Window,
) -> Result<ScanResult, String> {
    {
        let db = super::get_db(&state)?;
        super::authorize_import_path(&root_path, &db, &state.grants).await?;
    }
    super::SCAN_CANCEL.store(false, Ordering::SeqCst);
    let root = PathBuf::from(&root_path);
    let root_metadata = std::fs::metadata(&root)
        .map_err(|error| format!("Cannot access source folder '{}': {error}", root.display()))?;
    if !root_metadata.is_dir() {
        return Err(format!("Source path is not a folder: {}", root.display()));
    }
    let start = std::time::Instant::now();
    let mut items = Vec::new();
    let mut total_size: i64 = 0;
    let mut processed: u64 = 0;
    // Every media path found by this walk. Used to prune rows for files that
    // were deleted while the app was closed.
    let mut seen_paths: HashSet<String> = HashSet::new();

    // Get database connection
    let db = super::get_db(&state)?;
    let now = super::now_ms();

    // A normal startup scan only needs to inspect new or changed files. The
    // explicit Rescan action passes `force` to re-read every file header.
    // Only rows under this root can match a walked path, so load just those.
    let known_files: Arc<HashMap<String, (i64, i64)>> = Arc::new(if force {
        HashMap::new()
    } else {
        let prefix = format!(
            "{}/",
            super::normalize_root(&root_path).trim_end_matches('/')
        );
        sqlx::query_as::<_, (String, i64, i64)>(
            "SELECT path, size, modified_at FROM media_items WHERE substr(path, 1, length(?)) = ?",
        )
        .bind(&prefix)
        .bind(&prefix)
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(path, size, modified_at)| (path, (size, modified_at)))
        .collect()
    });

    // Discover the media paths once, on the blocking pool: a large tree can
    // take minutes to walk and must not pin an async worker.
    let walk_root = root.clone();
    let (media_paths, walk_error) =
        tokio::task::spawn_blocking(move || collect_media_paths(&walk_root, &super::SCAN_CANCEL))
            .await
            .map_err(|e| format!("Scan worker failed: {e}"))?;
    let had_walk_error = walk_error.is_some();
    for p in &media_paths {
        seen_paths.insert(p.to_string_lossy().into_owned());
    }
    if media_paths.is_empty() && !super::SCAN_CANCEL.load(Ordering::SeqCst) {
        if let Some(error) = walk_error {
            return Err(format!(
                "Could not read media in '{}': {error}. Check the folder's macOS access permissions.",
                root.display()
            ));
        }
    }
    // A file moved or renamed inside this source is the same item, not a delete
    // plus an import: re-key its row (and its album, tag and edit relations) to
    // the new path before the import loop writes anything.
    if !super::SCAN_CANCEL.load(Ordering::SeqCst) && !had_walk_error {
        let relinked = relink_moved_items(&db, &root_path, &seen_paths).await?;
        if relinked > 0 {
            eprintln!("visto: followed {relinked} moved file(s) under {root_path}");
        }
    }

    let total = media_paths.len() as u64;
    let mut discovered_count = 0usize;

    // Check metadata for every path, but only decode image headers and write
    // rows for new/changed files. File work runs on the blocking pool one
    // chunk at a time; writes stay in bounded async batches.
    const SCAN_BATCH_SIZE: usize = 100;
    for paths in media_paths.chunks(SCAN_BATCH_SIZE) {
        let chunk = paths.to_vec();
        let known = Arc::clone(&known_files);
        let scanned = tokio::task::spawn_blocking(move || {
            inspect_scan_chunk(&chunk, &known, force, now, &super::SCAN_CANCEL)
        })
        .await
        .map_err(|e| format!("Scan worker failed: {e}"))?;
        let batch = scanned.batch;
        let completed_in_batch = scanned.completed;
        total_size += scanned.size;
        discovered_count += scanned.discovered;
        let cancelled = super::SCAN_CANCEL.load(Ordering::SeqCst);
        items.extend(batch.iter().map(|(item, _, _)| item.clone()));
        upsert_media_batch(&db, &batch).await?;
        processed += completed_in_batch;

        // Emit progress every two batches or on the last batch.
        if processed % 200 < SCAN_BATCH_SIZE as u64 || processed == total || cancelled {
            let current_file = paths
                .last()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default();
            let _ = window.emit(
                "import-progress",
                json!({
                    "phase": "scanning",
                    "processed": processed,
                    "total": total,
                    "currentFile": current_file,
                }),
            );
            // Yield to the Tauri event loop so progress events are delivered
            // and the frontend stays responsive.
            tokio::task::yield_now().await;
        }
        if cancelled {
            break;
        }
    }

    // Sort by modified date desc
    items.sort_by_key(|a| std::cmp::Reverse(a.modified_at));

    // Only remember the folder once it actually contributed media, so an
    // accidental pick of an empty folder never shows up in the sidebar.
    if discovered_count > 0 {
        remember_folder(&db, &root_path, window.app_handle()).await;
    }

    let duration = start.elapsed().as_millis() as i64;

    hydrate_relations(&db, &mut items).await?;

    // Prune catalog entries for files that disappeared from this source.
    // Only do this if the walk completed fully without errors. Rows that were
    // re-pointed above now sit at a path this walk saw, so they survive.
    let cancelled = super::SCAN_CANCEL.load(Ordering::SeqCst);
    let removed_count = if !cancelled && !had_walk_error {
        prune_missing_items(&db, &root_path, &seen_paths).await?
    } else {
        0
    };

    if discovered_count > 0 || removed_count > 0 {
        let _ = window.emit(super::LIBRARY_COUNTS_CHANGED, ());
    }

    // Hand back the albums and tags so the sidebar is populated from the same
    // call that imports, instead of staying empty until a separate round-trip.
    let albums = sqlx::query_as::<_, Album>(&format!("{} ORDER BY a.created_at ASC", ALBUM_SELECT))
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    let tags = sqlx::query_as::<_, Tag>(&format!("{} ORDER BY t.name ASC", TAG_SELECT))
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(ScanResult {
        items,
        discovered_count,
        removed_count,
        cancelled,
        albums,
        tags,
        total_size,
        duration,
    })
}

/// Walk `root` and return every media file path plus the first walk error.
/// Blocking: call it from `spawn_blocking`.
pub(crate) fn collect_media_paths(
    root: &Path,
    cancel: &std::sync::atomic::AtomicBool,
) -> (Vec<PathBuf>, Option<String>) {
    let mut media_paths = Vec::new();
    let mut walk_error: Option<String> = None;
    for entry in WalkDir::new(root) {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        match entry {
            Ok(entry) if entry.file_type().is_file() => {
                let ext = entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if is_media_file(&ext) {
                    media_paths.push(entry.into_path());
                }
            }
            Ok(_) => {}
            Err(error) => {
                if walk_error.is_none() {
                    walk_error = Some(error.to_string());
                }
            }
        }
    }
    (media_paths, walk_error)
}

/// What one chunk of a folder scan found.
pub(crate) struct ScanChunk {
    /// New or changed files, ready for `upsert_media_batch`.
    pub batch: Vec<(MediaItem, Option<i32>, Option<i32>)>,
    /// Paths looked at (including unchanged ones) before any cancellation.
    pub completed: u64,
    /// Paths that still exist as regular files.
    pub discovered: usize,
    /// Bytes across `discovered` files.
    pub size: i64,
}

/// Stat every path in `paths` and inspect the ones that are new or changed
/// since `known`. Blocking: call it from `spawn_blocking`.
pub(crate) fn inspect_scan_chunk(
    paths: &[PathBuf],
    known: &HashMap<String, (i64, i64)>,
    force: bool,
    now: i64,
    cancel: &std::sync::atomic::AtomicBool,
) -> ScanChunk {
    let mut chunk = ScanChunk {
        batch: Vec::with_capacity(paths.len()),
        completed: 0,
        discovered: 0,
        size: 0,
    };
    for path in paths {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        chunk.completed += 1;
        let Some(metadata) = std::fs::metadata(path)
            .ok()
            .filter(|metadata| metadata.is_file())
        else {
            continue;
        };
        let size = metadata.len() as i64;
        let modified_at = file_modified_at(&metadata);
        chunk.size += size;
        chunk.discovered += 1;
        let path_key = path.to_string_lossy().into_owned();
        if !force
            && known
                .get(&path_key)
                .is_some_and(|fingerprint| *fingerprint == (size, modified_at))
        {
            continue;
        }
        if let Some(item) = inspect_media_file_with_metadata(path, &metadata, now) {
            chunk.batch.push(item);
        }
    }
    chunk
}

/// Import exactly the files the user picked.
///
/// Unlike `scan_library`, a selected file is never expanded to its parent
/// folder: picking one photo must not sweep in every neighbour on disk.
/// Selected folders are still walked recursively.
#[tauri::command]
pub async fn import_files(
    paths: Vec<String>,
    state: State<'_, AppState>,
    window: Window,
    app: tauri::AppHandle,
) -> Result<ScanResult, String> {
    let db = super::get_db(&state)?;
    for raw in &paths {
        super::authorize_import_path(raw, &db, &state.grants).await?;
    }
    super::SCAN_CANCEL.store(false, Ordering::SeqCst);
    let start = std::time::Instant::now();
    let now = super::now_ms();
    let mut items = Vec::new();
    let mut total_size: i64 = 0;
    let mut processed: u64 = 0;

    // Collect all media file paths first so we can report a total. Walking
    // picked folders can take a long time, so it runs on the blocking pool.
    let picked = paths.clone();
    let all_paths: Vec<PathBuf> = tokio::task::spawn_blocking(move || {
        let mut tmp = Vec::new();
        for raw in &picked {
            if super::SCAN_CANCEL.load(Ordering::SeqCst) {
                break;
            }
            let path = PathBuf::from(raw);
            if path.is_dir() {
                tmp.extend(collect_media_paths(&path, &super::SCAN_CANCEL).0);
            } else if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if is_media_file(&ext.to_lowercase()) {
                        tmp.push(path.clone());
                    }
                }
            }
        }
        tmp
    })
    .await
    .map_err(|e| format!("Import worker failed: {e}"))?;
    let total = all_paths.len() as u64;

    for path in all_paths {
        if super::SCAN_CANCEL.load(Ordering::SeqCst) {
            break;
        }
        if let Some((item, size)) = import_media_file(&db, &path, now).await? {
            total_size += size;
            items.push(item);
        }

        processed += 1;
        if processed.is_multiple_of(200)
            || processed == total
            || super::SCAN_CANCEL.load(Ordering::SeqCst)
        {
            let _ = window.emit(
                "import-progress",
                json!({
                    "phase": "scanning",
                    "processed": processed,
                    "total": total,
                    "currentFile": path.to_string_lossy().to_string(),
                }),
            );
            tokio::task::yield_now().await;
        }
    }

    items.sort_by_key(|a| std::cmp::Reverse(a.modified_at));

    // Remember any folders the user picked wholesale, so they can be removed
    // from the library in one step later. Individual files are grouped by
    // their parent directory when the folder list is built.
    if !items.is_empty() {
        for raw in &paths {
            if Path::new(raw).is_dir() {
                remember_folder(&db, raw, &app).await;
            }
        }
    }

    hydrate_relations(&db, &mut items).await?;

    let albums = sqlx::query_as::<_, Album>(&format!("{} ORDER BY a.created_at ASC", ALBUM_SELECT))
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    let tags = sqlx::query_as::<_, Tag>(&format!("{} ORDER BY t.name ASC", TAG_SELECT))
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;

    let discovered_count = items.len();
    if discovered_count > 0 {
        let _ = window.emit(super::LIBRARY_COUNTS_CHANGED, ());
    }
    Ok(ScanResult {
        items,
        discovered_count,
        removed_count: 0,
        cancelled: super::SCAN_CANCEL.load(Ordering::SeqCst),
        albums,
        tags,
        total_size,
        duration: start.elapsed().as_millis() as i64,
    })
}

const LIBRARY_PAGE_SIZE: i32 = 250;
const MAX_LIBRARY_PAGE_SIZE: i32 = 500;

#[derive(Debug, Deserialize, Serialize)]
struct LibraryCursor {
    value: Value,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItemsPage {
    pub(crate) items: Vec<MediaItem>,
    has_more: bool,
    next_cursor: Option<String>,
    pub(crate) total_count: i64,
}

fn cursor_value(item: &MediaItem, sort_by: &str) -> Value {
    match sort_by {
        // SQLite's built-in NOCASE collation is ASCII-only. Preserve the
        // stored spelling in the cursor rather than applying Rust Unicode
        // lowercasing, which could otherwise disagree with SQLite's ordering
        // for non-ASCII filenames (for example, accented characters).
        "name" => Value::String(item.name.clone()),
        "size" => Value::from(item.size),
        "kind" => Value::String(item.kind.clone()),
        "modifiedAt" => Value::from(item.modified_at),
        _ => Value::from(item.captured_at.unwrap_or(item.modified_at)),
    }
}

#[tauri::command]
pub async fn get_library_items(
    filter: Option<super::LibraryFilterDTO>,
    state: State<'_, AppState>,
) -> Result<LibraryItemsPage, String> {
    let db = super::get_db(&state)?;
    let f = filter.unwrap_or_default();
    get_library_items_page(&db, f).await
}

/// Return every hidden item (`hidden = 1`) for the Hidden gallery.
/// Unlike `get_library_items`, this does not paginate — the Hidden screen is
/// a secondary view over a typically small set.
#[tauri::command]
pub async fn get_hidden_items(state: State<'_, AppState>) -> Result<LibraryItemsPage, String> {
    let db = super::get_db(&state)?;
    let mut items: Vec<MediaItem> = sqlx::query_as(
        "SELECT * FROM media_items WHERE hidden = 1 ORDER BY COALESCE(captured_at, modified_at) DESC",
    )
    .fetch_all(&db)
    .await
    .map_err(|e| e.to_string())?;
    hydrate_relations(&db, &mut items).await?;
    let total_count = items.len() as i64;
    Ok(LibraryItemsPage {
        items,
        has_more: false,
        next_cursor: None,
        total_count,
    })
}

fn push_library_filters(qb: &mut QueryBuilder<Sqlite>, f: &super::LibraryFilterDTO) {
    if let Some(kind) = &f.kind {
        qb.push(" AND kind = ").push_bind(kind.clone());
    }
    if let Some(favorite) = f.favorite {
        qb.push(" AND favorite = ")
            .push_bind(if favorite { 1i32 } else { 0i32 });
    }
    if let Some(hidden) = f.hidden {
        qb.push(" AND hidden = ")
            .push_bind(if hidden { 1i32 } else { 0i32 });
    }
    if let Some(animated) = f.animated {
        qb.push(" AND is_animated = ")
            .push_bind(if animated { 1i32 } else { 0i32 });
    }
    if let Some(album_id) = &f.album_id {
        qb.push(" AND id IN (SELECT media_id FROM album_items WHERE album_id = ")
            .push_bind(album_id.clone())
            .push(")");
    }
    if let Some(tags) = &f.tags {
        if !tags.is_empty() {
            let placeholders = std::iter::repeat_n("?", tags.len())
                .collect::<Vec<_>>()
                .join(",");
            qb.push(format!(
                " AND id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name IN ({}))",
                placeholders
            ));
            for tag in tags {
                qb.push_bind(tag.clone());
            }
        }
    }
    if let Some(query) = &f.query {
        let like = format!("%{}%", query);
        qb.push(" AND (name LIKE ")
            .push_bind(like.clone())
            .push(" OR path LIKE ")
            .push_bind(like.clone())
            .push(" OR extension LIKE ")
            .push_bind(like.clone())
            .push(" OR kind LIKE ")
            .push_bind(like.clone())
            .push(" OR COALESCE(camera, '') LIKE ")
            .push_bind(like.clone())
            .push(" OR COALESCE(lens, '') LIKE ")
            .push_bind(like.clone())
            .push(" OR EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = media_items.id AND t.name LIKE ")
            .push_bind(like)
            .push(")")
            .push(")");
    }
    if let Some(from) = f.date_from {
        qb.push(" AND COALESCE(captured_at, modified_at) >= ")
            .push_bind(from);
    }
    if let Some(to) = f.date_to {
        qb.push(" AND COALESCE(captured_at, modified_at) <= ")
            .push_bind(to);
    }
    if let Some(source_path) = &f.source_path {
        let prefix = format!("{}/", source_path.trim_end_matches('/'));
        qb.push(" AND (path = ")
            .push_bind(source_path.clone())
            .push(" OR substr(path, 1, length(")
            .push_bind(prefix.clone())
            .push(")) = ")
            .push_bind(prefix)
            .push(")");
    }
    if let Some(rating) = f.rating {
        qb.push(" AND rating >= ").push_bind(rating);
    }
    if let Some(color_label) = &f.color_label {
        qb.push(" AND color_label = ")
            .push_bind(color_label.clone());
    }
    if let Some(camera) = &f.camera {
        qb.push(" AND camera = ").push_bind(camera.clone());
    }
    if let Some(lens) = &f.lens {
        qb.push(" AND lens = ").push_bind(lens.clone());
    }
}

pub(crate) async fn get_library_items_page(
    db: &SqlitePool,
    f: super::LibraryFilterDTO,
) -> Result<LibraryItemsPage, String> {
    let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("SELECT * FROM media_items WHERE 1=1");
    let mut count_qb: QueryBuilder<Sqlite> =
        QueryBuilder::new("SELECT COUNT(*) FROM media_items WHERE hidden = 0");
    push_library_filters(&mut qb, &f);
    push_library_filters(&mut count_qb, &f);

    // Identifiers cannot be bound, so the sort column is whitelisted instead of
    // interpolated straight from the caller. `id` is always the stable tie-breaker.
    let sort_by = match f.sort_by.as_deref() {
        Some("modifiedAt") => "modifiedAt",
        Some("name") => "name",
        Some("size") => "size",
        Some("kind") => "kind",
        _ => "capturedAt",
    };
    let (primary_sql, default_dir) = match sort_by {
        "modifiedAt" => ("modified_at", "DESC"),
        "name" => ("name COLLATE NOCASE", "ASC"),
        "size" => ("size", "ASC"),
        "kind" => ("kind", "ASC"),
        _ => ("COALESCE(captured_at, modified_at)", "DESC"),
    };
    let dir = match f.sort_order.as_deref() {
        Some("asc") => "ASC",
        Some("desc") => "DESC",
        _ => default_dir,
    };
    if let Some(raw_cursor) = f.cursor.as_deref() {
        let cursor: LibraryCursor = serde_json::from_str(raw_cursor)
            .map_err(|_| "Invalid library page cursor".to_string())?;
        let comparison = if dir == "ASC" { ">" } else { "<" };
        match sort_by {
            "name" => {
                let value = cursor
                    .value
                    .as_str()
                    .ok_or("Invalid name cursor")?
                    .to_string();
                qb.push(" AND (name COLLATE NOCASE ")
                    .push(comparison)
                    .push(" ")
                    .push_bind(value.clone())
                    .push(" OR (name COLLATE NOCASE = ")
                    .push_bind(value)
                    .push(" AND id > ")
                    .push_bind(cursor.id)
                    .push("))");
            }
            "kind" => {
                let value = cursor
                    .value
                    .as_str()
                    .ok_or("Invalid kind cursor")?
                    .to_string();
                qb.push(" AND (kind ")
                    .push(comparison)
                    .push(" ")
                    .push_bind(value.clone())
                    .push(" OR (kind = ")
                    .push_bind(value)
                    .push(" AND id > ")
                    .push_bind(cursor.id)
                    .push("))");
            }
            "size" => {
                let value = cursor.value.as_i64().ok_or("Invalid size cursor")?;
                qb.push(" AND (size ")
                    .push(comparison)
                    .push(" ")
                    .push_bind(value)
                    .push(" OR (size = ")
                    .push_bind(value)
                    .push(" AND id > ")
                    .push_bind(cursor.id)
                    .push("))");
            }
            "modifiedAt" => {
                let value = cursor
                    .value
                    .as_i64()
                    .ok_or("Invalid modified date cursor")?;
                qb.push(" AND (modified_at ")
                    .push(comparison)
                    .push(" ")
                    .push_bind(value)
                    .push(" OR (modified_at = ")
                    .push_bind(value)
                    .push(" AND id > ")
                    .push_bind(cursor.id)
                    .push("))");
            }
            _ => {
                let value = cursor.value.as_i64().ok_or("Invalid capture date cursor")?;
                qb.push(" AND (COALESCE(captured_at, modified_at) ")
                    .push(comparison)
                    .push(" ")
                    .push_bind(value)
                    .push(" OR (COALESCE(captured_at, modified_at) = ")
                    .push_bind(value)
                    .push(" AND id > ")
                    .push_bind(cursor.id)
                    .push("))");
            }
        }
    }

    // Stable secondary sort: id ASC.
    qb.push(format!(" ORDER BY {} {}, id ASC", primary_sql, dir));

    let page_size = f
        .limit
        .unwrap_or(LIBRARY_PAGE_SIZE)
        .clamp(1, MAX_LIBRARY_PAGE_SIZE) as usize;
    // Fetch one extra row solely to determine whether another page exists.
    qb.push(" LIMIT ").push_bind((page_size + 1) as i64);

    let mut items = qb
        .build_query_as::<MediaItem>()
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;

    let has_more = items.len() > page_size;
    if has_more {
        items.pop();
    }
    let next_cursor = if has_more {
        items.last().map(|item| {
            serde_json::to_string(&LibraryCursor {
                value: cursor_value(item, sort_by),
                id: item.id.clone(),
            })
            .expect("library cursor serialization cannot fail")
        })
    } else {
        None
    };

    let total_count: i64 = count_qb
        .build_query_scalar::<i64>()
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;

    hydrate_relations(db, &mut items).await?;
    Ok(LibraryItemsPage {
        items,
        has_more,
        next_cursor,
        total_count,
    })
}

/// Attach tags and album ids to a page of items using filtered queries.
/// Only fetches relations for the given item IDs (keyset pagination friendly).
async fn hydrate_relations(db: &SqlitePool, items: &mut [MediaItem]) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }

    let mut tags_by_item: HashMap<String, Vec<String>> = HashMap::new();
    let mut albums_by_item: HashMap<String, Vec<String>> = HashMap::new();

    // Keep each `IN` clause comfortably below SQLite's parameter ceiling even
    // when this helper is reused by a larger server-side page in the future.
    for ids in items
        .iter()
        .map(|item| item.id.as_str())
        .collect::<Vec<_>>()
        .chunks(500)
    {
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let tag_sql = format!(
            "SELECT mt.media_id, t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id IN ({})",
            placeholders
        );
        let mut tag_query = sqlx::query_as::<_, (String, String)>(&tag_sql);
        for id in ids {
            tag_query = tag_query.bind(*id);
        }
        for (media_id, name) in tag_query.fetch_all(db).await.map_err(|e| e.to_string())? {
            tags_by_item.entry(media_id).or_default().push(name);
        }

        let album_sql = format!(
            "SELECT media_id, album_id FROM album_items WHERE media_id IN ({})",
            placeholders
        );
        let mut album_query = sqlx::query_as::<_, (String, String)>(&album_sql);
        for id in ids {
            album_query = album_query.bind(*id);
        }
        for (media_id, album_id) in album_query.fetch_all(db).await.map_err(|e| e.to_string())? {
            albums_by_item.entry(media_id).or_default().push(album_id);
        }
    }

    for item in items.iter_mut() {
        item.tags = tags_by_item.remove(&item.id).unwrap_or_default();
        item.album_ids = albums_by_item.remove(&item.id).unwrap_or_default();
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailRequest {
    item_id: String,
    size: u32,
    /// JPEG quality 1-100; defaults to 78.
    quality: Option<u8>,
    /// Cache budget in bytes; defaults to 512 MiB.
    max_cache_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailResponse {
    item_id: String,
    data_url: String,
    width: u32,
    height: u32,
}

/// Large originals should be downsampled by macOS ImageIO (via `sips`) instead
/// of being decoded into a full-resolution buffer just to shrink them.
pub(crate) const LARGE_THUMBNAIL_SOURCE_BYTES: i64 = 8 * 1024 * 1024;
/// Thumbnails are small, but they should still have a predictable disk budget.
const THUMBNAIL_PRUNE_INTERVAL_SECS: u64 = 60 * 60;
static LAST_THUMBNAIL_PRUNE_EPOCH: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn get_item_thumbnail(
    request: ThumbnailRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ThumbnailResponse, String> {
    if !matches!(request.size, 64 | 128 | 256 | 512 | 1024) {
        return Err("Unsupported thumbnail size".to_string());
    }

    let db = super::get_db(&state)?;
    let item = sqlx::query_as::<_, (String, String, i64, i64)>(
        "SELECT path, kind, modified_at, size FROM media_items WHERE id = ?",
    )
    .bind(&request.item_id)
    .fetch_optional(&db)
    .await
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "Item not found in library".to_string())?;

    let quality = request.quality.unwrap_or(78).clamp(1, 100);
    let max_cache_bytes = request.max_cache_bytes.unwrap_or(512 * 1024 * 1024);

    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("thumbnails");
    tokio::fs::create_dir_all(&cache_root)
        .await
        .map_err(|error| error.to_string())?;
    let cache_key = thumbnail_cache_key(
        &request.item_id,
        item.2,
        item.3,
        request.size,
        &item.1,
        quality,
    );
    let digest = ring::digest::digest(&ring::digest::SHA256, cache_key.as_bytes());
    let cache_path = cache_root.join(format!("{}.jpg", hex::encode(digest.as_ref())));

    let cached = if let Ok(bytes) = tokio::fs::read(&cache_path).await {
        image::image_dimensions(&cache_path)
            .ok()
            .map(|(width, height)| (bytes, width, height))
    } else {
        None
    };
    let (_bytes, width, height) = if let Some(cached) = cached {
        cached
    } else {
        let _ = tokio::fs::remove_file(&cache_path).await;
        let source_path = item.0;
        let source_size = item.3;
        let item_kind = item.1;
        let target_path = cache_path.clone();
        let size = request.size;
        let generated = tokio::task::spawn_blocking(move || {
            generate_cached_thumbnail(
                &source_path,
                &target_path,
                size,
                source_size,
                quality,
                &item_kind,
            )
        })
        .await
        .map_err(|error| format!("Thumbnail worker failed: {error}"))??;
        maybe_prune_thumbnail_cache(cache_root.clone(), max_cache_bytes);
        generated
    };

    let bytes = tokio::fs::read(&cache_path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(ThumbnailResponse {
        item_id: request.item_id,
        data_url: format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)),
        width,
        height,
    })
}

/// Cache identity must include every input that changes the rendered image.
/// Thumbnails for the same photo at different sizes or JPEG qualities are
/// distinct files.
pub(crate) fn thumbnail_cache_key(
    item_id: &str,
    modified_at: i64,
    source_size: i64,
    thumbnail_size: u32,
    kind: &str,
    quality: u8,
) -> String {
    let version = if kind == "video" { "v2" } else { "v1" };
    format!("{item_id}:{modified_at}:{source_size}:{thumbnail_size}:{version}:q{quality}")
}

/// Keep the cache bounded without making every thumbnail request pay for a
/// directory scan. The first cache miss after an interval triggers a detached
/// cleanup, and concurrent requests are deduplicated by the epoch compare-exchange.
fn maybe_prune_thumbnail_cache(root: PathBuf, max_bytes: u64) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let last = LAST_THUMBNAIL_PRUNE_EPOCH.load(Ordering::Relaxed);
    if now.saturating_sub(last) < THUMBNAIL_PRUNE_INTERVAL_SECS {
        return;
    }
    if LAST_THUMBNAIL_PRUNE_EPOCH
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    tokio::task::spawn_blocking(move || {
        prune_thumbnail_cache(&root, max_bytes);
    });
}

/// Remove the oldest thumbnails until the directory fits the budget.
/// Returns (deleted_count, bytes_freed, failed_count).
pub(crate) fn prune_thumbnail_cache(root: &Path, max_bytes: u64) -> (usize, u64, usize) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return (0, 0, 0);
    };

    let mut files = Vec::new();
    let mut total = 0_u64;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("jpg") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let size = metadata.len();
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        total += size;
        files.push((path, size, modified));
    }

    if total <= max_bytes {
        return (0, 0, 0);
    }

    // Cache files are written once, so modified time is a good proxy for age.
    files.sort_by_key(|(_, _, modified)| *modified);

    let mut deleted = 0;
    let mut bytes_freed = 0_u64;
    let mut failed = 0;

    for (path, size, _) in files {
        if total <= max_bytes {
            break;
        }
        match std::fs::remove_file(&path) {
            Ok(_) => {
                total = total.saturating_sub(size);
                deleted += 1;
                bytes_freed += size;
            }
            Err(_) => {
                failed += 1;
                // Don't subtract size since deletion failed
            }
        }
    }

    (deleted, bytes_freed, failed)
}

pub(crate) fn generate_cached_thumbnail(
    source: &str,
    destination: &Path,
    size: u32,
    source_size: i64,
    quality: u8,
    kind: &str,
) -> Result<(Vec<u8>, u32, u32), String> {
    #[cfg(target_os = "macos")]
    {
        // RAW files: try macOS ImageIO (sips) which supports some RAW via Camera Raw.
        if kind == "raw" {
            if let Ok(result) = generate_with_macos_sips(
                source,
                destination,
                size,
                quality,
                "macOS sips (RAW via ImageIO)",
            ) {
                return Ok(result);
            }
        }
        // Video files: try QuickLook thumbnail generator (qlmanage).
        if kind == "video" {
            if let Ok(result) = generate_thumbnail_with_qlmanage(source, destination, size) {
                return Ok(result);
            }
        }

        // Large images: use sips for macOS ImageIO downsampling (HEIC/HEIF/large photos).
        if source_size > LARGE_THUMBNAIL_SOURCE_BYTES {
            return generate_with_macos_sips(
                source,
                destination,
                size,
                quality,
                "macOS sips (large image)",
            );
        }
    }
    // Fallback: use image crate (used on non-macOS, and for small images on macOS).
    // Only photo kinds are supported here; RAW/video will fall through to placeholder.
    if kind != "photo" {
        return generate_placeholder_thumbnail(destination, size, kind);
    }
    let reader = image::ImageReader::open(source)
        .map_err(|error| format!("Could not read photo: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("Could not identify photo format: {error}"))?;
    let mut decoder = match reader.into_decoder() {
        Ok(decoder) => decoder,
        Err(error) => {
            let reason = format!("decode failed: {error}");
            return generate_with_macos_sips(source, destination, size, quality, &reason);
        }
    };
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = match DynamicImage::from_decoder(decoder) {
        Ok(image) => image,
        Err(error) => {
            let reason = format!("decode failed: {error}");
            return generate_with_macos_sips(source, destination, size, quality, &reason);
        }
    };
    image.apply_orientation(orientation);
    let thumbnail = image.thumbnail(size, size).to_rgb8();
    let (width, height) = (thumbnail.width(), thumbnail.height());
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode(&thumbnail, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|error| format!("Could not encode thumbnail: {error}"))?;

    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, &bytes).map_err(|error| error.to_string())?;
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, width, height))
}

/// Generate a placeholder thumbnail for RAW/video files that cannot be decoded
/// by the available image libraries. Draws a solid color with a kind label.
fn generate_placeholder_thumbnail(
    destination: &Path,
    size: u32,
    kind: &str,
) -> Result<(Vec<u8>, u32, u32), String> {
    use image::{Rgb, RgbImage};
    let color = match kind {
        "raw" => Rgb([120, 110, 90]),   // warm gray for RAW
        "video" => Rgb([70, 110, 160]), // blue-gray for video
        _ => Rgb([150, 150, 150]),      // neutral gray fallback
    };
    let img = RgbImage::from_pixel(size, size, color);
    let (width, height) = (img.width(), img.height());
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 78)
        .encode(&img, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|error| format!("Could not encode placeholder thumbnail: {error}"))?;

    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, &bytes).map_err(|error| error.to_string())?;
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, width, height))
}

/// Generate a video thumbnail using macOS QuickLook (qlmanage).
/// Extracts a representative frame from the video file.
#[cfg(target_os = "macos")]
fn generate_thumbnail_with_qlmanage(
    source: &str,
    destination: &Path,
    size: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    use std::process::Command;

    let tmp_dir = std::env::temp_dir().join(format!("visto-qlmanage-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|error| format!("Could not create temp dir: {error}"))?;

    let mut child = Command::new("/usr/bin/qlmanage")
        .args([
            "-t",
            "-s",
            &size.to_string(),
            "-o",
            tmp_dir.to_str().unwrap(),
            source,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("qlmanage not available: {error}"))?;

    // QuickLook can hang on large or exotic video containers (a multi-GB MKV
    // is a real example), so cap the wait instead of occupying a thumbnail
    // worker indefinitely.
    let timeout = std::time::Duration::from_secs(10);
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err("qlmanage thumbnail timed out".to_string());
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(format!("qlmanage thumbnail failed: {error}"));
            }
        }
    };

    if !status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err("qlmanage thumbnail failed".to_string());
    }

    let result = (|| {
        let thumbnail_path = find_qlmanage_output(&tmp_dir)?;
        normalize_qlmanage_thumbnail(&thumbnail_path, destination, size)
    })();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

fn normalize_qlmanage_thumbnail(
    source: &Path,
    destination: &Path,
    size: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    let image = image::ImageReader::open(source)
        .map_err(|error| format!("Could not read QuickLook thumbnail: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("Could not identify QuickLook thumbnail: {error}"))?
        .decode()
        .map_err(|error| format!("Could not decode QuickLook thumbnail: {error}"))?
        .thumbnail(size, size)
        .to_rgb8();
    let (width, height) = (image.width(), image.height());
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 78)
        .encode(&image, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|error| format!("Could not encode QuickLook thumbnail: {error}"))?;

    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, &bytes).map_err(|error| error.to_string())?;
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, width, height))
}

#[cfg(not(target_os = "macos"))]
fn generate_thumbnail_with_qlmanage(
    _source: &str,
    _destination: &Path,
    _size: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    Err("qlmanage not available on this platform".to_string())
}

/// Find the newest decodable image generated by QuickLook. `qlmanage` commonly
/// writes PNG files even though our thumbnail cache is JPEG.
fn find_qlmanage_output(dir: &Path) -> Result<std::path::PathBuf, String> {
    let mut best: Option<std::path::PathBuf> = None;
    let mut best_time = std::time::UNIX_EPOCH;
    let entries = std::fs::read_dir(dir)
        .map_err(|error| format!("Could not read QuickLook output: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Could not read QuickLook output: {error}"))?;
        let path = entry.path();
        if !entry
            .file_type()
            .map_err(|error| format!("Could not inspect QuickLook output: {error}"))?
            .is_file()
            || image::image_dimensions(&path).is_err()
        {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.is_none() || modified > best_time {
            best_time = modified;
            best = Some(path);
        }
    }
    best.ok_or_else(|| "qlmanage output not found".to_string())
}

#[cfg(test)]
mod qlmanage_thumbnail_tests {
    use super::{find_qlmanage_output, normalize_qlmanage_thumbnail};
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn finds_quicklook_png_output() {
        let root = std::env::temp_dir().join(format!("visto-qlmanage-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test directory");
        let image_path = root.join("video.mov.png");
        image::RgbImage::from_pixel(32, 18, image::Rgb([90, 130, 180]))
            .save(&image_path)
            .expect("write QuickLook PNG");
        fs::write(root.join("video.mov.txt"), b"not an image").expect("write non-image file");

        assert_eq!(
            find_qlmanage_output(&root).expect("find generated QuickLook image"),
            image_path
        );
        fs::remove_dir_all(&root).expect("remove test directory");
    }

    #[test]
    fn normalizes_quicklook_png_to_cached_jpeg() {
        let root = std::env::temp_dir().join(format!("visto-qlmanage-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test directory");
        let source = root.join("video.mov.png");
        let destination = root.join("cached.jpg");
        image::RgbImage::from_pixel(64, 32, image::Rgb([90, 130, 180]))
            .save(&source)
            .expect("write QuickLook PNG");

        let (bytes, width, height) =
            normalize_qlmanage_thumbnail(&source, &destination, 24).expect("normalize thumbnail");

        assert_eq!(
            image::guess_format(&bytes).expect("identify cached image"),
            image::ImageFormat::Jpeg
        );
        assert_eq!(
            image::image_dimensions(&destination).expect("read cached image"),
            (24, 12)
        );
        assert_eq!((width, height), (24, 12));
        fs::remove_dir_all(&root).expect("remove test directory");
    }

    #[test]
    fn reports_when_quicklook_has_no_image_output() {
        let root = std::env::temp_dir().join(format!("visto-qlmanage-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test directory");
        fs::write(root.join("video.mov.txt"), b"not an image").expect("write non-image file");

        assert_eq!(
            find_qlmanage_output(&root).expect_err("no image should be found"),
            "qlmanage output not found"
        );
        fs::remove_dir_all(&root).expect("remove test directory");
    }
}

fn commit_thumbnail_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    match std::fs::rename(temporary, destination) {
        Ok(()) => {}
        Err(_) if destination.exists() => {
            let _ = std::fs::remove_file(temporary);
        }
        Err(error) => {
            let _ = std::fs::remove_file(temporary);
            return Err(error.to_string());
        }
    }
    Ok(())
}

/// `sips` is a thin wrapper over macOS ImageIO, which downsamples during
/// decode. That keeps memory flat for large photos and handles HEIC/HEIF.
#[cfg(target_os = "macos")]
fn generate_with_macos_sips(
    source: &str,
    destination: &Path,
    size: u32,
    quality: u8,
    reason: &str,
) -> Result<(Vec<u8>, u32, u32), String> {
    use std::process::Command;

    let temporary = destination.with_extension(format!("{}.tmp.jpg", Uuid::new_v4()));
    let output = Command::new("/usr/bin/sips")
        .args([
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            &quality.to_string(),
            "-Z",
            &size.to_string(),
        ])
        .arg(source)
        .arg("--out")
        .arg(&temporary)
        .output()
        .map_err(|error| {
            format!("Could not create thumbnail ({reason}); macOS ImageIO failed: {error}")
        })?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&temporary);
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Could not create thumbnail ({reason}): {}",
            detail.trim()
        ));
    }
    let dimensions = match image::image_dimensions(&temporary) {
        Ok(dimensions) => dimensions,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
    };
    let bytes = match std::fs::read(&temporary) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
    };
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, dimensions.0, dimensions.1))
}

#[cfg(not(target_os = "macos"))]
fn generate_with_macos_sips(
    _source: &str,
    _destination: &Path,
    _size: u32,
    reason: &str,
) -> Result<(Vec<u8>, u32, u32), String> {
    Err(format!("Could not create thumbnail ({reason})"))
}

#[tauri::command]
pub async fn watch_folder(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app_handle = app.clone();
    let watch_path = path.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            match res {
                Ok(_) => {
                    let _ = app_handle.emit("folder-changed", &watch_path);
                }
                Err(error) => {
                    // A watcher that cannot deliver events must not fail
                    // silently: the UI shows an actionable notice instead of
                    // pretending auto-import is still running.
                    let _ = app_handle.emit(
                        "folder-watch-error",
                        json!({
                            "path": watch_path,
                            "message": error.to_string(),
                        }),
                    );
                }
            }
        })
        .map_err(|e| e.to_string())?;
    watcher
        .watch(
            std::path::Path::new(&path),
            notify::RecursiveMode::Recursive,
        )
        .map_err(|e| e.to_string())?;
    let mut guard = state.watchers.lock().map_err(|e| e.to_string())?;
    guard.insert(path, watcher);
    Ok(())
}

#[tauri::command]
pub async fn unwatch_folder(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.watchers.lock().map_err(|e| e.to_string())?;
    guard.remove(&path);
    Ok(())
}

/// The explicitly registered library roots (not the inferred sidebar buckets).
///
/// Only these are safe to watch: inferred buckets are display groupings and
/// may point at directories the user never added.
#[tauri::command]
pub async fn get_library_roots(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = super::get_db(&state)?;
    sqlx::query_scalar("SELECT path FROM library_folders ORDER BY path ASC")
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())
}

/// Group a path that was imported before folder tracking existed.
///
/// Files under the home directory collapse to their first folder
/// (`~/Pictures/2024/01/a.jpg` → `~/Pictures`); anything else collapses to the
/// volume and first component (`/Applications/Safari.app/...` →
/// `/Applications/Safari.app`). This keeps the sidebar to a handful of rows
/// instead of one row per leaf directory.
pub(crate) fn inferred_folder_root(path: &str) -> Option<String> {
    let home = std::env::var("HOME")
        .ok()
        .map(|h| super::normalize_root(&h))?;
    let file = super::normalize_root(path);

    if super::path_is_inside(&file, &home) {
        let rest = &file[home.len() + 1..];
        let first = rest.split('/').find(|part| !part.is_empty())?;
        return Some(format!("{}/{}", home, first));
    }

    let parts: Vec<&str> = file.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    let take = parts.len().min(2);
    Some(format!("/{}", parts[..take].join("/")))
}

/// List the folders the library is made of.
///
/// Explicitly imported folders come from `library_folders`. Items imported
/// before folder tracking existed are folded into [`inferred_folder_root`]
/// buckets, and each item is counted exactly once under the most specific
/// folder that contains it.
#[tauri::command]
pub async fn get_library_folders(state: State<'_, AppState>) -> Result<Vec<LibraryFolder>, String> {
    let db = super::get_db(&state)?;

    let registered: Vec<String> =
        sqlx::query_scalar("SELECT path FROM library_folders ORDER BY path ASC")
            .fetch_all(&db)
            .await
            .map_err(|e| e.to_string())?;

    let rows = sqlx::query("SELECT path, size FROM media_items WHERE hidden = 0")
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;

    // One pass over the catalog: each item lands in exactly one folder.
    let mut registered_sorted = registered.clone();
    registered_sorted.sort_by_key(|a| std::cmp::Reverse(a.len()));

    let mut tallies: HashMap<String, (i64, i64)> = HashMap::new();
    for row in &rows {
        let item_path: String = row.get("path");
        let size: i64 = row.get("size");

        let owner = registered_sorted
            .iter()
            .find(|root| super::path_is_inside(&item_path, root))
            .cloned()
            .or_else(|| inferred_folder_root(&item_path));

        if let Some(folder) = owner {
            let tally = tallies.entry(folder).or_insert((0, 0));
            tally.0 += 1;
            tally.1 += size;
        }
    }

    let mut folders: Vec<LibraryFolder> = tallies
        .into_iter()
        .map(|(path, (item_count, total_size))| {
            let name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| path.clone());
            LibraryFolder {
                path,
                name,
                item_count,
                total_size,
            }
        })
        .collect();

    // Keep explicitly imported folders visible even when they are empty, so a
    // stale entry can still be removed.
    for root in &registered {
        if !folders.iter().any(|folder| &folder.path == root) {
            let name = Path::new(root)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| root.clone());
            folders.push(LibraryFolder {
                path: root.clone(),
                name,
                item_count: 0,
                total_size: 0,
            });
        }
    }

    folders.sort_by(|a, b| {
        b.item_count
            .cmp(&a.item_count)
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
    Ok(folders)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    photos: i64,
    videos: i64,
    raws: i64,
    /// Subset of `photos`: items the catalog treats as animated content.
    animations: i64,
    uncategorized: i64,
    favorites: i64,
    hidden: i64,
    photo_size: i64,
    video_size: i64,
    raw_size: i64,
    uncategorized_size: i64,
    favorite_size: i64,
    hidden_size: i64,
    total_size: i64,
}

#[tauri::command]
pub async fn get_library_stats(state: State<'_, AppState>) -> Result<LibraryStats, String> {
    let db = super::get_db(&state)?;
    let row = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64)>(
        "SELECT
            SUM(CASE WHEN kind = 'photo' AND hidden = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN kind = 'video' AND hidden = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN kind = 'raw' AND hidden = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN is_animated = 1 AND hidden = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN kind NOT IN ('photo', 'video', 'raw') AND hidden = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN favorite = 1 AND hidden = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN hidden = 1 THEN 1 ELSE 0 END),
            SUM(CASE WHEN kind = 'photo' AND hidden = 0 THEN size ELSE 0 END),
            SUM(CASE WHEN kind = 'video' AND hidden = 0 THEN size ELSE 0 END),
            SUM(CASE WHEN kind = 'raw' AND hidden = 0 THEN size ELSE 0 END),
            SUM(CASE WHEN kind NOT IN ('photo', 'video', 'raw') AND hidden = 0 THEN size ELSE 0 END),
            SUM(CASE WHEN favorite = 1 AND hidden = 0 THEN size ELSE 0 END),
            SUM(CASE WHEN hidden = 1 THEN size ELSE 0 END)
        FROM media_items",
    )
    .fetch_one(&db)
    .await
    .map_err(|e| e.to_string())?;

    let (
        photos,
        videos,
        raws,
        animations,
        uncategorized,
        favorites,
        hidden,
        photo_size,
        video_size,
        raw_size,
        uncategorized_size,
        favorite_size,
        hidden_size,
    ) = row;

    let total_size = photo_size + video_size + raw_size + uncategorized_size;

    Ok(LibraryStats {
        photos,
        videos,
        raws,
        animations,
        uncategorized,
        favorites,
        hidden,
        photo_size,
        video_size,
        raw_size,
        uncategorized_size,
        favorite_size,
        hidden_size,
        total_size,
    })
}

/// Remove a folder from VistoGallery.
///
/// The files stay on disk by default: this only drops the folder's rows from
/// the catalog. Pass `delete_files = true` to move the originals to the macOS
/// Trash instead (used by the "also delete files" confirmation).
#[tauri::command]
pub async fn remove_library_folder(
    path: String,
    delete_files: Option<bool>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let db = super::get_db(&state)?;
    let root = super::normalize_root(&path);
    if root.is_empty() {
        return Err("Refusing to remove an empty folder path".to_string());
    }
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    if !registered
        .iter()
        .any(|registered_path| super::normalize_root(registered_path) == root)
    {
        return Err("Folder is not a registered library root.".to_string());
    }

    let rows = sqlx::query(
        "SELECT id, path FROM media_items \
         WHERE substr(path, 1, ?1) = ?2 AND length(path) > ?1 AND substr(path, ?1 + 1, 1) = '/'",
    )
    .bind(root.len() as i64)
    .bind(&root)
    .fetch_all(&db)
    .await
    .map_err(|e| e.to_string())?;

    let targets: Vec<(String, String)> = rows
        .iter()
        .map(|row| (row.get::<String, _>("id"), row.get::<String, _>("path")))
        .collect();

    if delete_files.unwrap_or(false) && !targets.is_empty() {
        const TRASH_CHUNK: usize = 50;
        for chunk in targets.chunks(TRASH_CHUNK) {
            let chunk_paths: Vec<String> = chunk
                .iter()
                .map(|(_, item_path)| item_path.clone())
                .collect();
            let chunk_paths_for_delete = chunk_paths.clone();
            let result =
                tokio::task::spawn_blocking(move || trash::delete_all(&chunk_paths_for_delete))
                    .await;
            if result.as_ref().map(|r| r.is_err()).unwrap_or(true) {
                for path in &chunk_paths {
                    let p = path.clone();
                    let r = tokio::task::spawn_blocking(move || trash::delete(&p)).await;
                    if r.is_err() || r.unwrap().is_err() {
                        return Err("Could not move files to Trash".to_string());
                    }
                }
            } else if false {
                for path in &chunk_paths {
                    let p = path.clone();
                    let r = tokio::task::spawn_blocking(move || trash::delete(&p)).await;
                    if r.is_err() || r.unwrap().is_err() {
                        return Err("Could not move files to Trash".to_string());
                    }
                }
            }
        }
    }
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;

    // Clean up join rows explicitly instead of relying on foreign-key cascades
    // being enabled on this particular pooled connection.
    for (id, _) in &targets {
        for statement in [
            "DELETE FROM media_tags WHERE media_id = ?",
            "DELETE FROM album_items WHERE media_id = ?",
            "DELETE FROM media_items WHERE id = ?",
        ] {
            sqlx::query(statement)
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Forget the folder itself, plus any registered subfolder that lived
    // inside it, so a later import is not shadowed by stale entries.
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    for registered_path in registered {
        if super::normalize_root(&registered_path) == root
            || super::path_is_inside(&registered_path, &root)
        {
            sqlx::query("DELETE FROM library_folders WHERE path = ?")
                .bind(&registered_path)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(targets.len() as i64)
}

#[tauri::command]
pub async fn toggle_favorite(
    item_id: String,
    favorite: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let db = super::get_db(&state)?;
    let changed = sqlx::query("UPDATE media_items SET favorite = ?, updated_at = ? WHERE id = ?")
        .bind(if favorite { 1i32 } else { 0i32 })
        .bind(super::now_ms())
        .bind(&item_id)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
    // The Favourites chip and the sidebar read catalog-wide counts from the
    // backend, so this flag change has to ask for them again. The frontend
    // debounces the refresh, which also collapses a bulk favouriting run.
    if changed > 0 {
        let _ = app.emit(super::LIBRARY_COUNTS_CHANGED, ());
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_hidden(
    item_id: String,
    hidden: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let db = super::get_db(&state)?;
    let changed = sqlx::query("UPDATE media_items SET hidden = ?, updated_at = ? WHERE id = ?")
        .bind(if hidden { 1i32 } else { 0i32 })
        .bind(super::now_ms())
        .bind(&item_id)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
    // Hiding changes every catalog-wide count (the stats query ignores hidden
    // rows), so refresh them here rather than waiting for the next scan.
    if changed > 0 {
        let _ = app.emit(super::LIBRARY_COUNTS_CHANGED, ());
    }
    Ok(())
}

/// Set the star rating (0-5) on a media item. Pass 0 to unrate.
#[tauri::command]
pub async fn set_rating(
    item_id: String,
    rating: i32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = super::get_db(&state)?;
    sqlx::query("UPDATE media_items SET rating = ?, updated_at = ? WHERE id = ?")
        .bind(rating)
        .bind(super::now_ms())
        .bind(&item_id)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Set the color label on a media item. Valid values: red, yellow, green,
/// blue, purple. Pass empty string to clear.
#[tauri::command]
pub async fn set_color_label(
    item_id: String,
    color_label: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = super::get_db(&state)?;
    sqlx::query("UPDATE media_items SET color_label = ?, updated_at = ? WHERE id = ?")
        .bind(color_label)
        .bind(super::now_ms())
        .bind(&item_id)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Core implementation of `update_item_tags`, extracted so it can be tested
/// against an in-memory database without a Tauri `State`.
pub async fn apply_item_tags(
    db: &SqlitePool,
    item_id: &str,
    tags: &[String],
) -> Result<(), String> {
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM media_tags WHERE media_id = ?")
        .bind(item_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    let mut seen = std::collections::HashSet::new();
    for tag_name in tags {
        let trimmed = tag_name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !seen.insert(trimmed.to_lowercase()) {
            continue;
        }

        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM tags WHERE name = ? COLLATE NOCASE")
                .bind(trimmed)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;

        let tag_id = match existing {
            Some(id) => id,
            None => {
                let new_id = Uuid::new_v4().to_string();
                sqlx::query(
                    "INSERT INTO tags (id, name, color_index, created_at) VALUES (?, ?, 0, ?)",
                )
                .bind(&new_id)
                .bind(trimmed)
                .bind(super::now_ms())
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                new_id
            }
        };

        sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)")
            .bind(item_id)
            .bind(&tag_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_item_tags(
    item_id: String,
    tags: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = super::get_db(&state)?;
    apply_item_tags(&db, &item_id, &tags).await
}

#[cfg(test)]
mod tag_tests {
    use super::apply_item_tags;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn tag_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory db");
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&db)
            .await
            .expect("enable foreign keys");
        sqlx::query(
            "CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, rating INTEGER, color_label TEXT)",
        )
        .execute(&db)
        .await
        .expect("create media_items");
        sqlx::query(
            "CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color_index INTEGER DEFAULT 0, created_at INTEGER NOT NULL)",
        )
        .execute(&db)
        .await
        .expect("create tags");
        sqlx::query(
            "CREATE TABLE media_tags (media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (media_id, tag_id))",
        )
        .execute(&db)
        .await
        .expect("create media_tags");
        db
    }

    #[tokio::test]
    async fn shared_tag_keeps_one_canonical_row() {
        let db = tag_db().await;
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("a")
            .bind("/tmp/a.jpg")
            .bind("a.jpg")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("b")
            .bind("/tmp/b.jpg")
            .bind("b.jpg")
            .execute(&db)
            .await
            .unwrap();

        apply_item_tags(&db, "a", &["Travel".to_string()])
            .await
            .expect("apply to a");
        apply_item_tags(&db, "b", &["Travel".to_string()])
            .await
            .expect("apply to b");

        let tag_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(tag_count, 1, "shared tag should not duplicate");

        let a_tags: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = 'a'")
                .fetch_one(&db)
                .await
                .unwrap();
        let b_tags: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = 'b'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(a_tags, 1);
        assert_eq!(b_tags, 1);
    }

    #[tokio::test]
    async fn applying_existing_tag_to_second_item_succeeds() {
        let db = tag_db().await;
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("a")
            .bind("/tmp/a.jpg")
            .bind("a.jpg")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("b")
            .bind("/tmp/b.jpg")
            .bind("b.jpg")
            .execute(&db)
            .await
            .unwrap();

        apply_item_tags(&db, "a", &["Travel".to_string(), "2024".to_string()])
            .await
            .unwrap();
        apply_item_tags(&db, "b", &["Travel".to_string()])
            .await
            .expect("existing tag on second item must succeed");

        let a_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = 'a'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(a_count, 2, "item a must keep both tags");
    }

    #[tokio::test]
    async fn case_insensitive_dedup() {
        let db = tag_db().await;
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("a")
            .bind("/tmp/a.jpg")
            .bind("a.jpg")
            .execute(&db)
            .await
            .unwrap();

        apply_item_tags(&db, "a", &["Travel".to_string(), "travel".to_string()])
            .await
            .unwrap();

        let tag_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(tag_count, 1);
        let join_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = 'a'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(join_count, 1);
    }

    #[tokio::test]
    async fn failed_transaction_leaves_previous_tags_intact() {
        let db = tag_db().await;
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("a")
            .bind("/tmp/a.jpg")
            .bind("a.jpg")
            .execute(&db)
            .await
            .unwrap();

        apply_item_tags(&db, "a", &["Keep".to_string()])
            .await
            .unwrap();

        let result = apply_item_tags(&db, "ghost", &["New".to_string()]).await;
        assert!(result.is_err(), "applying tags to a missing item must fail");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = 'a'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1, "original item's tags must survive the failed tx");
    }
}

#[cfg(test)]
mod pagination_tests {
    use super::{cursor_value, get_library_items_page, LibraryCursor};
    use crate::{commands::LibraryFilterDTO, models::MediaItem};
    use sqlx::sqlite::SqlitePoolOptions;

    async fn page_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory page database");
        sqlx::query(
            "CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at INTEGER, width INTEGER, height INTEGER, camera TEXT, lens TEXT, exposure TEXT, iso INTEGER, latitude REAL, longitude REAL, sha256 TEXT, favorite INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, is_animated INTEGER NOT NULL DEFAULT 0, content_signature TEXT, import_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rating INTEGER, color_label TEXT)",
        )
        .execute(&db)
        .await
        .expect("create media table");
        sqlx::query("CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create tags table");
        sqlx::query("CREATE TABLE media_tags (media_id TEXT NOT NULL, tag_id TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create media tags table");
        sqlx::query("CREATE TABLE album_items (media_id TEXT NOT NULL, album_id TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create album items table");
        db
    }

    #[test]
    fn cursor_captures_the_active_sort_value_and_stable_item_id() {
        let mut item = MediaItem::new(
            "/tmp/Example.JPG".to_string(),
            "Example.JPG".to_string(),
            "jpg".to_string(),
            "photo".to_string(),
            42,
            100,
        );
        item.id = "stable-id".to_string();
        item.captured_at = Some(80);

        let cursor = LibraryCursor {
            value: cursor_value(&item, "capturedAt"),
            id: item.id.clone(),
        };
        let round_trip: LibraryCursor =
            serde_json::from_str(&serde_json::to_string(&cursor).expect("serialize cursor"))
                .expect("parse cursor");
        assert_eq!(round_trip.value.as_i64(), Some(80));
        assert_eq!(round_trip.id, "stable-id");

        assert_eq!(cursor_value(&item, "name").as_str(), Some("Example.JPG"));
        assert_eq!(cursor_value(&item, "size").as_i64(), Some(42));
        assert_eq!(cursor_value(&item, "modifiedAt").as_i64(), Some(100));
    }

    #[tokio::test]
    async fn keyset_pages_do_not_skip_equal_sort_values() {
        let db = page_db().await;
        for (id, captured_at) in [("c", 30_i64), ("a", 20), ("b", 20)] {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at) VALUES (?, ?, ?, 'jpg', 'photo', 1, 1, ?, 1, 1)")
                .bind(id)
                .bind(format!("/tmp/{id}.jpg"))
                .bind(format!("{id}.jpg"))
                .bind(captured_at)
                .execute(&db)
                .await
                .expect("insert media row");
        }

        let first = get_library_items_page(
            &db,
            LibraryFilterDTO {
                limit: Some(2),
                sort_by: Some("capturedAt".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("read first page");
        assert_eq!(
            first
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "a"]
        );
        assert!(first.has_more);

        let second = get_library_items_page(
            &db,
            LibraryFilterDTO {
                limit: Some(2),
                sort_by: Some("capturedAt".to_string()),
                cursor: first.next_cursor,
                ..Default::default()
            },
        )
        .await
        .expect("read second page");
        assert_eq!(
            second
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["b"]
        );
        assert!(!second.has_more);
    }
}

#[cfg(test)]
mod filter_and_scale_tests {
    use super::get_library_items_page;
    use crate::commands::{load_album_overviews, LibraryFilterDTO};
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn filter_db() -> SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory filter database");
        sqlx::query(
            "CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at INTEGER, width INTEGER, height INTEGER, camera TEXT, lens TEXT, exposure TEXT, iso INTEGER, latitude REAL, longitude REAL, sha256 TEXT, favorite INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, is_animated INTEGER NOT NULL DEFAULT 0, content_signature TEXT, import_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rating INTEGER, color_label TEXT)",
        )
        .execute(&db)
        .await
        .expect("create media table");
        sqlx::query("CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create tags table");
        sqlx::query("CREATE TABLE media_tags (media_id TEXT NOT NULL, tag_id TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create media tags table");
        sqlx::query("CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color_index INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .expect("create albums table");
        sqlx::query("CREATE TABLE album_items (album_id TEXT NOT NULL, media_id TEXT NOT NULL, added_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .expect("create album items table");
        db
    }

    async fn insert_item(
        db: &SqlitePool,
        id: &str,
        kind: &str,
        captured_at: Option<i64>,
        modified_at: i64,
        rating: Option<i64>,
    ) {
        sqlx::query(
            "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, rating) VALUES (?, ?, ?, 'jpg', ?, 1, ?, ?, 1, 1, ?)",
        )
        .bind(id)
        .bind(format!("/tmp/{id}.jpg"))
        .bind(format!("{id}.jpg"))
        .bind(kind)
        .bind(modified_at)
        .bind(captured_at)
        .bind(rating)
        .execute(db)
        .await
        .expect("insert media row");
    }

    #[tokio::test]
    async fn date_range_is_inclusive_and_falls_back_to_modified_at() {
        let db = filter_db().await;
        insert_item(&db, "captured", "photo", Some(100), 1, None).await;
        insert_item(&db, "fallback", "photo", None, 100, None).await;
        insert_item(&db, "outside", "photo", Some(101), 1, None).await;

        let page = get_library_items_page(
            &db,
            LibraryFilterDTO {
                date_from: Some(100),
                date_to: Some(100),
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .expect("read date range");

        let mut ids: Vec<&str> = page.items.iter().map(|item| item.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["captured", "fallback"]);
        assert_eq!(page.total_count, 2);
    }

    #[tokio::test]
    async fn date_range_composes_with_kind_and_rating() {
        let db = filter_db().await;
        insert_item(&db, "photo-5", "photo", Some(200), 1, Some(5)).await;
        insert_item(&db, "photo-2", "photo", Some(200), 1, Some(2)).await;
        insert_item(&db, "raw-5", "raw", Some(200), 1, Some(5)).await;
        insert_item(&db, "photo-old", "photo", Some(100), 1, Some(5)).await;

        let page = get_library_items_page(
            &db,
            LibraryFilterDTO {
                kind: Some("photo".to_string()),
                rating: Some(3),
                date_from: Some(150),
                date_to: Some(250),
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .expect("read composed filter");

        assert_eq!(
            page.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["photo-5"]
        );
    }

    /// Not part of the default suite; run with:
    /// `cargo test ten_thousand_item_page_and_album_overview -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "10k-item benchmark; run explicitly and record the output"]
    async fn ten_thousand_item_page_and_album_overview_are_bounded() {
        let db = filter_db().await;
        sqlx::query("INSERT INTO albums (id, name, created_at, updated_at) VALUES ('album', 'Everything', 1, 1)")
            .execute(&db)
            .await
            .expect("insert album");
        let mut tx = db.begin().await.expect("begin seed transaction");
        for index in 0..10_000_i64 {
            sqlx::query(
                "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, rating) VALUES (?, ?, ?, 'jpg', 'photo', ?, ?, ?, 1, 1, ?)",
            )
            .bind(format!("m{index}"))
            .bind(format!("/tmp/m{index}.jpg"))
            .bind(format!("m{index}.jpg"))
            .bind(index)
            .bind(1_700_000_000_000_i64 + index)
            .bind(1_700_000_000_000_i64 + index)
            .bind(index % 6)
            .execute(&mut *tx)
            .await
            .expect("seed media row");
            sqlx::query(
                "INSERT INTO album_items (album_id, media_id, added_at) VALUES ('album', ?, 1)",
            )
            .bind(format!("m{index}"))
            .execute(&mut *tx)
            .await
            .expect("seed album row");
        }
        tx.commit().await.expect("commit seed transaction");

        let first_page_started = std::time::Instant::now();
        let first = get_library_items_page(
            &db,
            LibraryFilterDTO {
                limit: Some(250),
                ..Default::default()
            },
        )
        .await
        .expect("first page");
        let first_page_ms = first_page_started.elapsed().as_millis();

        let overview_started = std::time::Instant::now();
        let overview = load_album_overviews(&db).await.expect("album overview");
        let overview_ms = overview_started.elapsed().as_millis();

        eprintln!(
            "10k benchmark: first-page items={} total={} page={}ms; album-overviews={} covers={} total={}ms",
            first.items.len(),
            first.total_count,
            first_page_ms,
            overview.len(),
            overview.first().map(|album| album.cover_items.len()).unwrap_or(0),
            overview_ms,
        );
        assert_eq!(first.items.len(), 250);
        assert_eq!(first.total_count, 10_000);
        assert_eq!(overview.len(), 1);
        assert_eq!(overview[0].item_count, 10_000);
        assert!(overview[0].cover_items.len() <= 4);
    }
}

#[cfg(test)]
mod scan_chunk_tests {
    use super::{collect_media_paths, file_modified_at, inspect_scan_chunk};
    use std::collections::HashMap;
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn tree() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("visto-scan-chunk-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("a.jpg"), b"not really a jpeg").unwrap();
        fs::write(root.join("nested/b.PNG"), b"not really a png").unwrap();
        fs::write(root.join("notes.txt"), b"skip me").unwrap();
        root
    }

    #[test]
    fn walk_keeps_only_media_extensions() {
        let root = tree();
        let (mut paths, error) = collect_media_paths(&root, &AtomicBool::new(false));
        paths.sort();
        assert!(error.is_none());
        assert_eq!(paths, vec![root.join("a.jpg"), root.join("nested/b.PNG")]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_stops_when_cancelled() {
        let root = tree();
        let (paths, _) = collect_media_paths(&root, &AtomicBool::new(true));
        assert!(paths.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unchanged_files_are_counted_but_not_reinspected() {
        let root = tree();
        let a = root.join("a.jpg");
        let meta = fs::metadata(&a).unwrap();
        let known = HashMap::from([(
            a.to_string_lossy().into_owned(),
            (meta.len() as i64, file_modified_at(&meta)),
        )]);
        let chunk = inspect_scan_chunk(
            std::slice::from_ref(&a),
            &known,
            false,
            0,
            &AtomicBool::new(false),
        );
        assert_eq!(chunk.completed, 1);
        assert_eq!(chunk.discovered, 1);
        assert_eq!(chunk.size, meta.len() as i64);
        assert!(chunk.batch.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_files_are_completed_but_not_discovered() {
        let root = tree();
        let gone = root.join("gone.jpg");
        let chunk = inspect_scan_chunk(&[gone], &HashMap::new(), false, 0, &AtomicBool::new(false));
        assert_eq!(chunk.completed, 1);
        assert_eq!(chunk.discovered, 0);
        let _ = fs::remove_dir_all(&root);
    }
}
