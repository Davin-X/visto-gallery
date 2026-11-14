use super::*;
use crate::errors::{CommandError, ErrorCode};
use crate::{models::*, AppState};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{QueryBuilder, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{State, Window};
use ts_rs::TS;
use walkdir::WalkDir;

#[tauri::command]
pub async fn scan_library(
    root_path: String,
    force: bool,
    catalog: State<'_, crate::Catalog>,
    state: State<'_, AppState>,
    window: Window,
) -> Result<ScanResult, CommandError> {
    {
        let db = super::get_db(&catalog)?;
        super::authorize_import_path(&root_path, &db, &state.grants).await?;
    }
    // Register before waiting on the root lock so Cancel also reaches a scan
    // that is still queued behind another scan of the same root.
    let job = state.scan_jobs.start();
    let root_lock = state
        .scan_jobs
        .root_lock(&super::normalize_root(&root_path));
    let _root_guard = root_lock.lock().await;
    let root = PathBuf::from(&root_path);
    let root_metadata = std::fs::metadata(&root).map_err(|error| {
        CommandError::io(format!(
            "Cannot access source folder '{}': {error}",
            root.display()
        ))
    })?;
    if !root_metadata.is_dir() {
        return Err(CommandError::io(format!(
            "Source path is not a folder: {}",
            root.display()
        )));
    }
    let start = std::time::Instant::now();
    let mut items = Vec::new();
    let mut total_size: i64 = 0;
    let mut processed: u64 = 0;
    // Every media path found by this walk. Used to prune rows for files that
    // were deleted while the app was closed.
    let mut seen_paths: HashSet<String> = HashSet::new();

    // Get database connection
    let db = super::get_db(&catalog)?;
    let now = super::now_ms();

    // A normal startup scan only needs to inspect new or changed files. The
    // explicit Rescan action passes `force` to re-read every file header.
    //
    // One load answers three questions: which files are already known, which
    // rows vanished from this root, which rows to prune. It is scoped to the
    // root, so scanning one folder never reads another folder's rows.
    let catalog = catalog_rows_under_root(&db, &root_path).await?;
    let known_files: Arc<HashMap<String, (i64, i64)>> = Arc::new(if force {
        HashMap::new()
    } else {
        catalog
            .iter()
            .map(|row| (row.path.clone(), (row.size, row.modified_at)))
            .collect()
    });

    // Discover the media paths once, on the blocking pool: a large tree can
    // take minutes to walk and must not pin an async worker. The same walk
    // removes app-created export temps (`<name>.tmp-<uuid>`) left by a crash or
    // failed write; only ones older than the grace period are touched.
    let walk_root = root.clone();
    let walk_cancel = job.flag();
    let (media_paths, walk_error) = tokio::task::spawn_blocking(move || {
        collect_media_paths(&walk_root, &walk_cancel, Some(STALE_EXPORT_TEMP_AGE))
    })
    .await
    .map_err(|e| CommandError::internal(format!("Scan worker failed: {e}")))?;
    let had_walk_error = walk_error.is_some();
    for p in &media_paths {
        seen_paths.insert(p.to_string_lossy().into_owned());
    }
    if media_paths.is_empty() && !job.is_cancelled() {
        if let Some(error) = walk_error {
            return Err(CommandError::internal(format!(
                "Could not read media in '{}': {error}. Check the folder's macOS access permissions.",
                root.display()
            )));
        }
    }
    // A file moved or renamed inside this source is the same item, not a delete
    // plus an import: re-key its row (and its album, tag and edit relations) to
    // the new path before the import loop writes anything.
    if !job.is_cancelled() && !had_walk_error {
        let relinked = relink_moved_items_from(&db, &catalog, &root_path, &seen_paths).await?;
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
        let chunk_cancel = job.flag();
        let scanned = tokio::task::spawn_blocking(move || {
            inspect_scan_chunk(&chunk, &known, force, now, &chunk_cancel)
        })
        .await
        .map_err(|e| CommandError::internal(format!("Scan worker failed: {e}")))?;
        let batch = scanned.batch;
        let completed_in_batch = scanned.completed;
        total_size += scanned.size;
        discovered_count += scanned.discovered;
        let cancelled = job.is_cancelled();
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
    // Only do this if the walk completed fully without errors. The snapshot is
    // still valid here: rows added by the import loop all sit at a path this
    // walk saw, and a row re-pointed above no longer exists under its old id,
    // so pruning it by that id is a no-op.
    let cancelled = job.is_cancelled();
    let removed_count = if !cancelled && !had_walk_error {
        prune_missing_items_from(&db, &catalog, &root_path, &seen_paths).await?
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
        .await?;
    let tags = sqlx::query_as::<_, Tag>(&format!("{} ORDER BY t.name ASC", TAG_SELECT))
        .fetch_all(&db)
        .await?;

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

/// Export temps younger than this may still be in the middle of a write.
const STALE_EXPORT_TEMP_AGE: std::time::Duration = std::time::Duration::from_secs(300);

/// Walk `root` and return every media file path plus the first walk error.
/// With `sweep_temps_older_than`, app export temps at least that old are
/// removed during the same walk. Blocking: call it from `spawn_blocking`.
pub(crate) fn collect_media_paths(
    root: &Path,
    cancel: &std::sync::atomic::AtomicBool,
    sweep_temps_older_than: Option<std::time::Duration>,
) -> (Vec<PathBuf>, Option<String>) {
    let mut media_paths = Vec::new();
    let mut walk_error: Option<String> = None;
    let temp_cutoff = sweep_temps_older_than.and_then(super::stale_temp_cutoff);
    for entry in WalkDir::new(root) {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        match entry {
            Ok(entry) if entry.file_type().is_file() => {
                if let Some(cutoff) = temp_cutoff {
                    if super::remove_if_stale_export_temp(&entry, cutoff) {
                        continue;
                    }
                }
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
    catalog: State<'_, crate::Catalog>,
    state: State<'_, AppState>,
    window: Window,
    app: tauri::AppHandle,
) -> Result<ScanResult, CommandError> {
    let db = super::get_db(&catalog)?;
    for raw in &paths {
        super::authorize_import_path(raw, &db, &state.grants).await?;
    }
    let job = state.scan_jobs.start();
    let walk_cancel = job.flag();
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
            if walk_cancel.load(Ordering::SeqCst) {
                break;
            }
            let path = PathBuf::from(raw);
            if path.is_dir() {
                tmp.extend(collect_media_paths(&path, &walk_cancel, None).0);
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
    .map_err(|e| CommandError::internal(format!("Import worker failed: {e}")))?;
    let total = all_paths.len() as u64;

    for path in all_paths {
        if job.is_cancelled() {
            break;
        }
        if let Some((item, size)) = import_media_file(&db, &path, now).await? {
            total_size += size;
            items.push(item);
        }

        processed += 1;
        if processed.is_multiple_of(200) || processed == total || job.is_cancelled() {
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
        .await?;
    let tags = sqlx::query_as::<_, Tag>(&format!("{} ORDER BY t.name ASC", TAG_SELECT))
        .fetch_all(&db)
        .await?;

    let discovered_count = items.len();
    if discovered_count > 0 {
        let _ = window.emit(super::LIBRARY_COUNTS_CHANGED, ());
    }
    Ok(ScanResult {
        items,
        discovered_count,
        removed_count: 0,
        cancelled: job.is_cancelled(),
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

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields = nullable)]
pub struct LibraryItemsPage {
    pub(crate) items: Vec<MediaItem>,
    has_more: bool,
    next_cursor: Option<String>,
    /// Present only on the first page for the current filter. Continuation
    /// (`cursor`-paginated) pages return `null` so the frontend can keep the
    /// earlier count instead of re-running a full `COUNT(*)` per page.
    pub(crate) total_count: Option<i64>,
}

fn cursor_value(item: &MediaItem, sort_by: &str) -> Value {
    match sort_by {
        // SQLite's built-in NOCASE collation is ASCII-only. Preserve the
        // stored spelling in the cursor rather than applying Rust Unicode
        // lowercasing, which could otherwise disagree with SQLite's ordering
        // for non-ASCII filenames (for example, accented characters).
        "name" => Value::String(item.name.clone()),
        "size" => Value::from(item.size),
        "kind" => Value::String(item.kind.as_str().to_string()),
        "modifiedAt" => Value::from(item.modified_at),
        _ => Value::from(item.captured_at.unwrap_or(item.modified_at)),
    }
}

#[tauri::command]
pub async fn get_library_items(
    filter: Option<super::LibraryFilterDTO>,
    catalog: State<'_, crate::Catalog>,
) -> Result<LibraryItemsPage, CommandError> {
    let db = super::get_db(&catalog)?;
    let f = filter.unwrap_or_default();
    get_library_items_page(&db, f).await
}

/// Return only the catalog ids for the current filter. This is the cheap
/// server-side answer to "give me everything that matches" — used by the
/// frontend to back Select All on a filtered search without materializing
/// thumbnails, EXIF, or relations.
pub(crate) async fn matching_ids(
    db: &SqlitePool,
    mut f: super::LibraryFilterDTO,
) -> Result<Vec<String>, CommandError> {
    f.hidden.get_or_insert(false);

    let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("SELECT id FROM media_items WHERE 1=1");
    push_library_filters(&mut qb, &f);

    // Sort order only needs to match the page query so callers can rely on
    // keyset semantics if they ever mix this with pagination.
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
    qb.push(format!(" ORDER BY {} {}, id ASC", primary_sql, dir));

    let ids = qb.build_query_scalar::<String>().fetch_all(db).await?;
    Ok(ids)
}

#[tauri::command]
pub async fn get_matching_ids(
    filter: Option<super::LibraryFilterDTO>,
    catalog: State<'_, crate::Catalog>,
) -> Result<Vec<String>, CommandError> {
    let db = super::get_db(&catalog)?;
    matching_ids(&db, filter.unwrap_or_default()).await
}

/// Return a page of hidden items (`hidden = 1`) for the Hidden gallery.
/// Paginated like `get_library_items`: continuation pages carry no count, and
/// `has_more` / `next_cursor` drive the gallery's infinite load.
#[tauri::command]
pub async fn get_hidden_items(
    filter: Option<super::LibraryFilterDTO>,
    catalog: State<'_, crate::Catalog>,
) -> Result<LibraryItemsPage, CommandError> {
    let db = super::get_db(&catalog)?;
    let mut f = filter.unwrap_or_default();
    f.hidden = Some(true);
    get_library_items_page(&db, f).await
}

/// Return the cataloged items for `ids`, in the order given. Ids that are no
/// longer in the catalog are skipped. Lets a screen show specific items (for
/// example every photo with a saved edit draft) without depending on which
/// library pages happen to be loaded.
#[tauri::command]
pub async fn get_items_by_ids(
    ids: Vec<String>,
    catalog: State<'_, crate::Catalog>,
) -> Result<Vec<MediaItem>, CommandError> {
    let db = super::get_db(&catalog)?;
    items_by_ids(&db, &ids).await
}

/// SQLite caps bound parameters per statement, so look ids up in chunks.
const ITEMS_BY_IDS_CHUNK: usize = 500;

pub(crate) async fn items_by_ids(
    db: &SqlitePool,
    ids: &[String],
) -> Result<Vec<MediaItem>, CommandError> {
    let mut found: HashMap<String, MediaItem> = HashMap::new();
    for chunk in ids.chunks(ITEMS_BY_IDS_CHUNK) {
        let mut qb: QueryBuilder<Sqlite> =
            QueryBuilder::new("SELECT * FROM media_items WHERE id IN (");
        let mut separated = qb.separated(", ");
        for id in chunk {
            separated.push_bind(id);
        }
        separated.push_unseparated(")");
        for item in qb.build_query_as::<MediaItem>().fetch_all(db).await? {
            found.insert(item.id.clone(), item);
        }
    }
    let mut seen = HashSet::new();
    let mut items: Vec<MediaItem> = ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .filter_map(|id| found.remove(id))
        .collect();
    hydrate_relations(db, &mut items).await?;
    Ok(items)
}

/// Escape `\\`, `%` and `_` so a search term matches literally inside a
/// `LIKE ... ESCAPE '\\'` pattern.
fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
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
            // push_bind writes its own `?`, so the IN list is built from binds
            // only; writing literal placeholders as well produced `IN (?)) ?`.
            qb.push(
                " AND id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name IN (",
            );
            let mut names = qb.separated(", ");
            for tag in tags {
                names.push_bind(tag.clone());
            }
            qb.push("))");
        }
    }
    if let Some(query) = &f.query {
        // `%` and `_` typed by the user are literal characters, not wildcards.
        let like = format!("%{}%", escape_like(query));
        qb.push(" AND (name LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR path LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR extension LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR kind LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR COALESCE(camera, '') LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR COALESCE(lens, '') LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id = media_items.id AND t.name LIKE ")
            .push_bind(like)
            .push(" ESCAPE '\\')")
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
    mut f: super::LibraryFilterDTO,
) -> Result<LibraryItemsPage, CommandError> {
    // Hidden items stay out of every view unless the caller asks for them, so
    // the items and the count always describe the same set. Smart Albums pass
    // no `hidden` value and used to page hidden items while counting none.
    f.hidden.get_or_insert(false);
    let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("SELECT * FROM media_items WHERE 1=1");
    let mut count_qb: QueryBuilder<Sqlite> =
        QueryBuilder::new("SELECT COUNT(*) FROM media_items WHERE 1=1");
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
            .map_err(|_| CommandError::invalid("Invalid library page cursor".to_string()))?;
        let comparison = if dir == "ASC" { ">" } else { "<" };
        match sort_by {
            "name" => {
                let value = cursor
                    .value
                    .as_str()
                    .ok_or_else(|| CommandError::invalid("Invalid name cursor"))?
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
                    .ok_or_else(|| CommandError::invalid("Invalid kind cursor"))?
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
                let value = cursor
                    .value
                    .as_i64()
                    .ok_or_else(|| CommandError::invalid("Invalid size cursor"))?;
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
                    .ok_or_else(|| CommandError::invalid("Invalid modified date cursor"))?;
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
                let value = cursor
                    .value
                    .as_i64()
                    .ok_or_else(|| CommandError::invalid("Invalid capture date cursor"))?;
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

    let mut items = qb.build_query_as::<MediaItem>().fetch_all(db).await?;

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

    // Counting a million-row table per continuation page buys nothing: the
    // frontend keeps the first-page count. Skip the full scan for pages
    // fetched through a cursor.
    let total_count = if f.cursor.is_some() {
        None
    } else {
        Some(count_qb.build_query_scalar::<i64>().fetch_one(db).await?)
    };

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
async fn hydrate_relations(db: &SqlitePool, items: &mut [MediaItem]) -> Result<(), CommandError> {
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
        for (media_id, name) in tag_query.fetch_all(db).await? {
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
        for (media_id, album_id) in album_query.fetch_all(db).await? {
            albums_by_item.entry(media_id).or_default().push(album_id);
        }
    }

    for item in items.iter_mut() {
        item.tags = tags_by_item.remove(&item.id).unwrap_or_default();
        item.album_ids = albums_by_item.remove(&item.id).unwrap_or_default();
    }
    Ok(())
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThumbnailRequest {
    item_id: String,
    #[ts(type = "64 | 128 | 256 | 512 | 1024")]
    size: u32,
    /// JPEG quality 1-100; defaults to 78.
    quality: Option<u8>,
    /// Cache budget in bytes; defaults to 512 MiB.
    max_cache_bytes: Option<u64>,
}

#[derive(Serialize, TS)]
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
    catalog: State<'_, crate::Catalog>,
) -> Result<ThumbnailResponse, CommandError> {
    if !matches!(request.size, 64 | 128 | 256 | 512 | 1024) {
        return Err(CommandError::invalid(
            "Unsupported thumbnail size".to_string(),
        ));
    }

    let db = super::get_db(&catalog)?;
    let item = sqlx::query_as::<_, (String, String, i64, i64)>(
        "SELECT path, kind, modified_at, size FROM media_items WHERE id = ?",
    )
    .bind(&request.item_id)
    .fetch_optional(&db)
    .await?
    .ok_or_else(|| "Item not found in library".to_string())?;

    let quality = request.quality.unwrap_or(78).clamp(1, 100);
    let max_cache_bytes = request.max_cache_bytes.unwrap_or(512 * 1024 * 1024);

    let cache_root = app.path().app_cache_dir()?.join("thumbnails");
    tokio::fs::create_dir_all(&cache_root).await?;
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

    // A cache hit reads the file once and takes its dimensions from the bytes
    // already in memory; a miss reuses the bytes the generator just wrote.
    let cached = match tokio::fs::read(&cache_path).await {
        Ok(bytes) => jpeg_dimensions(&bytes).map(|(width, height)| (bytes, width, height)),
        Err(_) => None,
    };
    let (bytes, width, height) = if let Some(cached) = cached {
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
        .map_err(|error| CommandError::internal(format!("Thumbnail worker failed: {error}")))??;
        maybe_prune_thumbnail_cache(cache_root.clone(), max_cache_bytes);
        generated
    };

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
    // Bumping the video version invalidates the cached "No preview" placeholder
    // written for containers QuickLook could not open.
    let version = if kind == "video" { "v3" } else { "v1" };
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

/// A cache temp file (`.tmp.` in the name) older than this is a crashed
/// writer's leftover, not something still in flight.
const CACHE_TEMP_GRACE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Cache renders are written to `<digest>.<uuid>.tmp.jpg` and renamed into
/// place, so a crash can leave the temp behind.
fn is_cache_temp(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains(".tmp."))
}

/// Remove the oldest thumbnails until the directory fits the budget.
/// Returns (deleted_count, bytes_freed, failed_count).
///
/// Temp files are swept regardless of the budget: a fresh one may still be
/// mid-write, so it is skipped (and never counted), but a stale one is
/// removed so it cannot sit in the cache forever.
pub(crate) fn prune_thumbnail_cache(root: &Path, max_bytes: u64) -> (usize, u64, usize) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return (0, 0, 0);
    };

    let cutoff = SystemTime::now().checked_sub(CACHE_TEMP_GRACE);
    let mut files = Vec::new();
    let mut total = 0_u64;
    let mut deleted = 0;
    let mut bytes_freed = 0_u64;
    let mut failed = 0;

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if is_cache_temp(&path) {
            let stale = cutoff.is_some_and(|cutoff| {
                metadata
                    .modified()
                    .map(|modified| modified <= cutoff)
                    .unwrap_or(false)
            });
            if stale {
                match std::fs::remove_file(&path) {
                    Ok(_) => {
                        deleted += 1;
                        bytes_freed += metadata.len();
                    }
                    Err(_) => failed += 1,
                }
            }
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("jpg") {
            continue;
        }
        let size = metadata.len();
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        total += size;
        files.push((path, size, modified));
    }

    if total <= max_bytes {
        return (deleted, bytes_freed, failed);
    }

    // Cache files are written once, so modified time is a good proxy for age.
    files.sort_by_key(|(_, _, modified)| *modified);

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

/// Dimensions of an encoded image held in memory (cached thumbnails are JPEG),
/// or `None` when the bytes are not a readable image.
fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

pub(crate) fn generate_cached_thumbnail(
    source: &str,
    destination: &Path,
    size: u32,
    source_size: i64,
    quality: u8,
    kind: &str,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
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
        // Video files: QuickLook covers what macOS can decode, and ffmpeg covers
        // the rest. QuickLook has no VP9/AV1 decoder: it returns nothing — or
        // hangs until the timeout — and the grid was left with "No preview" for
        // a video the player itself could play.
        if kind == "video" {
            if quicklook_handles_container(source) {
                if let Ok(result) = generate_thumbnail_with_qlmanage(source, destination, size) {
                    return Ok(result);
                }
                if let Ok(result) =
                    generate_thumbnail_with_ffmpeg(source, destination, size, quality)
                {
                    return Ok(result);
                }
            } else {
                // Skip the guaranteed timeout for containers QuickLook never opens.
                if let Ok(result) =
                    generate_thumbnail_with_ffmpeg(source, destination, size, quality)
                {
                    return Ok(result);
                }
                if let Ok(result) = generate_thumbnail_with_qlmanage(source, destination, size) {
                    return Ok(result);
                }
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
        .map_err(|error| CommandError::io(format!("Could not read photo: {error}")))?
        .with_guessed_format()
        .map_err(|error| {
            CommandError::new(
                ErrorCode::UnsupportedFormat,
                format!("Could not identify photo format: {error}"),
            )
        })?;
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
        .map_err(|error| CommandError::io(format!("Could not encode thumbnail: {error}")))?;

    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, &bytes)?;
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, width, height))
}

/// Generate a placeholder thumbnail for RAW/video files that cannot be decoded
/// by the available image libraries. Draws a solid color with a kind label.
fn generate_placeholder_thumbnail(
    destination: &Path,
    size: u32,
    kind: &str,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
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
        .map_err(|error| {
            CommandError::io(format!("Could not encode placeholder thumbnail: {error}"))
        })?;

    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, &bytes)?;
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, width, height))
}

/// Containers macOS QuickLook can open. Anything else would only burn the
/// ten-second `qlmanage` timeout before producing nothing.
#[cfg(target_os = "macos")]
fn quicklook_handles_container(source: &str) -> bool {
    let extension = Path::new(source)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase();
    !matches!(
        extension.as_str(),
        "mkv"
            | "avi"
            | "wmv"
            | "flv"
            | "webm"
            | "ts"
            | "m2ts"
            | "mts"
            | "mpg"
            | "mpeg"
            | "vob"
            | "ogv"
            | "3gp"
    )
}

/// Extract a poster frame with ffmpeg.
///
/// QuickLook relies on the system decoders, so containers and codecs macOS does
/// not ship (VP9 and AV1 in MP4 are the common ones from social downloads) get no
/// thumbnail at all. ffmpeg decodes them, which keeps the grid and filmstrip
/// consistent with what the player can actually play.
#[cfg(target_os = "macos")]
fn generate_thumbnail_with_ffmpeg(
    source: &str,
    destination: &Path,
    size: u32,
    quality: u8,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    let ffmpeg = crate::media_tools::find(crate::media_tools::FFMPEG).ok_or_else(|| {
        CommandError::new(
            ErrorCode::UnsupportedFormat,
            "ffmpeg is not installed, so this video has no preview".to_string(),
        )
    })?;

    let tmp_dir = std::env::temp_dir().join(format!("visto-ffmpeg-poster-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir)?;

    let result = (|| {
        let frame = tmp_dir.join("poster.jpg");
        let filter = format!("scale={size}:-2:force_original_aspect_ratio=decrease");
        let mut extracted = false;
        // Opening frames are often black, so start slightly in — but a very
        // short clip has no frame at 0.5s, hence the fallback to the first one.
        for seek in ["0.5", "0"] {
            let _ = std::fs::remove_file(&frame);
            let output = std::process::Command::new(&ffmpeg)
                .args(["-nostdin", "-v", "error", "-y", "-ss", seek, "-i", source])
                .args(["-frames:v", "1", "-vf", &filter])
                .arg(&frame)
                .output()
                .map_err(|error| {
                    CommandError::internal(format!("ffmpeg could not run: {error}"))
                })?;
            if output.status.success() && frame.is_file() {
                extracted = true;
                break;
            }
        }
        if !extracted {
            return Err(CommandError::new(
                ErrorCode::UnsupportedFormat,
                "ffmpeg could not extract a frame from this video".to_string(),
            ));
        }

        let image = image::ImageReader::open(&frame)
            .map_err(|error| {
                CommandError::io(format!("Could not read the extracted frame: {error}"))
            })?
            .with_guessed_format()
            .map_err(|error| {
                CommandError::new(
                    ErrorCode::UnsupportedFormat,
                    format!("Could not identify the extracted frame: {error}"),
                )
            })?
            .decode()
            .map_err(|error| {
                CommandError::new(
                    ErrorCode::UnsupportedFormat,
                    format!("Could not decode the extracted frame: {error}"),
                )
            })?
            .thumbnail(size, size)
            .to_rgb8();
        let (width, height) = (image.width(), image.height());
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, quality)
            .encode(&image, width, height, image::ExtendedColorType::Rgb8)
            .map_err(|error| {
                CommandError::io(format!("Could not encode the video thumbnail: {error}"))
            })?;

        let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
        std::fs::write(&temporary, &bytes)?;
        commit_thumbnail_file(&temporary, destination)?;
        Ok((bytes, width, height))
    })();

    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Generate a video thumbnail using macOS QuickLook (qlmanage).
/// Extracts a representative frame from the video file.
#[cfg(target_os = "macos")]
fn generate_thumbnail_with_qlmanage(
    source: &str,
    destination: &Path,
    size: u32,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    use std::process::Command;

    let tmp_dir = std::env::temp_dir().join(format!("visto-qlmanage-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|error| CommandError::io(format!("Could not create temp dir: {error}")))?;

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
        .map_err(|error| CommandError::internal(format!("qlmanage not available: {error}")))?;

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
                return Err(CommandError::internal(
                    "qlmanage thumbnail timed out".to_string(),
                ));
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(CommandError::internal(format!(
                    "qlmanage thumbnail failed: {error}"
                )));
            }
        }
    };

    if !status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(CommandError::internal(
            "qlmanage thumbnail failed".to_string(),
        ));
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
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    let image = image::ImageReader::open(source)
        .map_err(|error| CommandError::io(format!("Could not read QuickLook thumbnail: {error}")))?
        .with_guessed_format()
        .map_err(|error| {
            CommandError::new(
                ErrorCode::UnsupportedFormat,
                format!("Could not identify QuickLook thumbnail: {error}"),
            )
        })?
        .decode()
        .map_err(|error| {
            CommandError::new(
                ErrorCode::UnsupportedFormat,
                format!("Could not decode QuickLook thumbnail: {error}"),
            )
        })?
        .thumbnail(size, size)
        .to_rgb8();
    let (width, height) = (image.width(), image.height());
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 78)
        .encode(&image, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|error| {
            CommandError::io(format!("Could not encode QuickLook thumbnail: {error}"))
        })?;

    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, &bytes)?;
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, width, height))
}

#[cfg(not(target_os = "macos"))]
fn generate_thumbnail_with_qlmanage(
    _source: &str,
    _destination: &Path,
    _size: u32,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    Err(CommandError::internal(
        "qlmanage not available on this platform".to_string(),
    ))
}

/// Find the newest decodable image generated by QuickLook. `qlmanage` commonly
/// writes PNG files even though our thumbnail cache is JPEG.
fn find_qlmanage_output(dir: &Path) -> Result<std::path::PathBuf, CommandError> {
    let mut best: Option<std::path::PathBuf> = None;
    let mut best_time = std::time::UNIX_EPOCH;
    let entries = std::fs::read_dir(dir)
        .map_err(|error| CommandError::io(format!("Could not read QuickLook output: {error}")))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            CommandError::io(format!("Could not read QuickLook output: {error}"))
        })?;
        let path = entry.path();
        if !entry
            .file_type()
            .map_err(|error| {
                CommandError::io(format!("Could not inspect QuickLook output: {error}"))
            })?
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
    best.ok_or_else(|| CommandError::not_found("qlmanage output not found"))
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
            find_qlmanage_output(&root)
                .expect_err("no image should be found")
                .message,
            "qlmanage output not found"
        );
        fs::remove_dir_all(&root).expect("remove test directory");
    }
}

fn commit_thumbnail_file(temporary: &Path, destination: &Path) -> Result<(), CommandError> {
    match std::fs::rename(temporary, destination) {
        Ok(()) => {}
        Err(_) if destination.exists() => {
            let _ = std::fs::remove_file(temporary);
        }
        Err(error) => {
            let _ = std::fs::remove_file(temporary);
            return Err(CommandError::internal(error.to_string()));
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
) -> Result<(Vec<u8>, u32, u32), CommandError> {
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
        return Err(CommandError::internal(format!(
            "Could not create thumbnail ({reason}): {}",
            detail.trim()
        )));
    }
    let dimensions = match image::image_dimensions(&temporary) {
        Ok(dimensions) => dimensions,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(CommandError::internal(error.to_string()));
        }
    };
    let bytes = match std::fs::read(&temporary) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(CommandError::internal(error.to_string()));
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
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    Err(CommandError::internal(format!(
        "Could not create thumbnail ({reason})"
    )))
}

#[tauri::command]
pub async fn watch_folder(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    // A source deleted outside the app is "missing", not an access error.
    // Report it distinctly so the frontend can skip the permissions notice and
    // avoid recording it as watched (a remounted drive must be watched again).
    if !std::path::Path::new(&path).is_dir() {
        return Err(CommandError::new(
            ErrorCode::MissingSource,
            format!("The library source is not available: {path}"),
        ));
    }
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
        })?;
    watcher.watch(
        std::path::Path::new(&path),
        notify::RecursiveMode::Recursive,
    )?;
    let mut guard = state.watchers.lock()?;
    guard.insert(path, watcher);
    Ok(())
}

#[tauri::command]
pub async fn unwatch_folder(path: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    let mut guard = state.watchers.lock()?;
    guard.remove(&path);
    Ok(())
}

/// The explicitly registered library roots (not the inferred sidebar buckets).
///
/// Only these are safe to watch: inferred buckets are display groupings and
/// may point at directories the user never added.
#[tauri::command]
pub async fn get_library_roots(
    catalog: State<'_, crate::Catalog>,
) -> Result<Vec<String>, CommandError> {
    let db = super::get_db(&catalog)?;
    sqlx::query_scalar("SELECT path FROM library_folders ORDER BY path ASC")
        .fetch_all(&db)
        .await
        .map_err(CommandError::from)
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
pub async fn get_library_folders(
    catalog: State<'_, crate::Catalog>,
) -> Result<Vec<LibraryFolder>, CommandError> {
    let db = super::get_db(&catalog)?;
    get_library_folders_inner(&db).await
}

pub(crate) async fn get_library_folders_inner(
    db: &SqlitePool,
) -> Result<Vec<LibraryFolder>, CommandError> {
    let registered: Vec<String> =
        sqlx::query_scalar("SELECT path FROM library_folders ORDER BY path ASC")
            .fetch_all(db)
            .await?;

    let rows = sqlx::query("SELECT path, size FROM media_items WHERE hidden = 0")
        .fetch_all(db)
        .await?;

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
            let available = Path::new(&path).is_dir();
            LibraryFolder {
                path,
                name,
                item_count,
                total_size,
                available,
            }
        })
        .collect();

    // Keep explicitly imported folders visible even when they are empty, so a
    // stale/missing entry can still be removed.
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
                available: Path::new(root).is_dir(),
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

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    photos: i64,
    videos: i64,
    raws: i64,
    /// Animated items. Counted here and not in `photos`, so the kind counts
    /// (photos, videos, raws, animations, uncategorized) add up to the total.
    animations: i64,
    /// Total bytes of the animated subset.
    animations_size: i64,
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
pub async fn get_library_stats(
    catalog: State<'_, crate::Catalog>,
) -> Result<LibraryStats, CommandError> {
    let db = super::get_db(&catalog)?;
    library_stats(&db).await
}

pub(crate) async fn library_stats(db: &SqlitePool) -> Result<LibraryStats, CommandError> {
    library_stats_scoped(db, false).await
}

/// Per-kind counts and sizes for the hidden items, so the Hidden screen's
/// type chips count the whole hidden collection rather than whichever page
/// (already filtered to the selected type) happens to be loaded.
#[tauri::command]
pub async fn get_hidden_stats(
    catalog: State<'_, crate::Catalog>,
) -> Result<LibraryStats, CommandError> {
    let db = super::get_db(&catalog)?;
    library_stats_scoped(&db, true).await
}

/// The stats query over visible items (`hidden = 0`) or hidden ones
/// (`hidden = 1`). `scope` is a constant 0/1, never user input. The `hidden`
/// and `hidden_size` fields always count every hidden item.
async fn library_stats_scoped(
    db: &SqlitePool,
    hidden_scope: bool,
) -> Result<LibraryStats, CommandError> {
    let scope = u8::from(hidden_scope);
    let row = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64)>(
        &format!(
            "SELECT
            SUM(CASE WHEN kind = 'photo' AND hidden = {scope} AND is_animated = 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN kind = 'video' AND hidden = {scope} THEN 1 ELSE 0 END),
            SUM(CASE WHEN kind = 'raw' AND hidden = {scope} THEN 1 ELSE 0 END),
            SUM(CASE WHEN is_animated = 1 AND hidden = {scope} THEN 1 ELSE 0 END),
            SUM(CASE WHEN is_animated = 1 AND hidden = {scope} THEN size ELSE 0 END),
            SUM(CASE WHEN kind NOT IN ('photo', 'video', 'raw') AND hidden = {scope} THEN 1 ELSE 0 END),
            SUM(CASE WHEN favorite = 1 AND hidden = {scope} THEN 1 ELSE 0 END),
            SUM(CASE WHEN hidden = 1 THEN 1 ELSE 0 END),
            SUM(CASE WHEN kind = 'photo' AND hidden = {scope} AND is_animated = 0 THEN size ELSE 0 END),
            SUM(CASE WHEN kind = 'video' AND hidden = {scope} THEN size ELSE 0 END),
            SUM(CASE WHEN kind = 'raw' AND hidden = {scope} THEN size ELSE 0 END),
            SUM(CASE WHEN kind NOT IN ('photo', 'video', 'raw') AND hidden = {scope} THEN size ELSE 0 END),
            SUM(CASE WHEN favorite = 1 AND hidden = {scope} THEN size ELSE 0 END),
            SUM(CASE WHEN hidden = 1 THEN size ELSE 0 END)
        FROM media_items"
        ),
    )
    .fetch_one(db)
    .await
    ?;

    let (
        photos,
        videos,
        raws,
        animations,
        animations_size,
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

    // Every visible item lands in exactly one of these buckets; animated items
    // left `photo_size` when they got their own row, so they are added back here.
    let total_size = photo_size + video_size + raw_size + animations_size + uncategorized_size;

    Ok(LibraryStats {
        photos,
        videos,
        raws,
        animations,
        animations_size,
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
    app: tauri::AppHandle,
    catalog: State<'_, crate::Catalog>,
) -> Result<i64, CommandError> {
    let db = super::get_db(&catalog)?;
    let root = super::normalize_root(&path);
    if root.is_empty() {
        return Err(CommandError::invalid(
            "Refusing to remove an empty folder path".to_string(),
        ));
    }
    let removed = remove_library_folder_inner(&db, &root, delete_files.unwrap_or(false)).await?;
    // The source is no longer registered, so it must not keep asset-protocol
    // access until the next launch. Skip the revoke when another registered
    // root still lives inside the removed one.
    let remaining: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await
        .unwrap_or_default();
    if !remaining
        .iter()
        .any(|registered| super::path_is_inside(registered, &root))
    {
        if let Err(error) = app.asset_protocol_scope().forbid_directory(&root, true) {
            tracing::error!("removed root could not be forbidden in the asset scope: {error}");
        }
    }
    Ok(removed)
}

async fn remove_library_folder_inner(
    db: &sqlx::SqlitePool,
    root: &str,
    delete_files: bool,
) -> Result<i64, CommandError> {
    let db = db.clone();
    if root.is_empty() {
        return Err(CommandError::invalid(
            "Refusing to remove an empty folder path".to_string(),
        ));
    }
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await?;
    if !registered
        .iter()
        .any(|registered_path| super::normalize_root(registered_path) == root)
    {
        return Err(CommandError::path(
            "Folder is not a registered library root.".to_string(),
        ));
    }

    let rows = sqlx::query(
        "SELECT id, path FROM media_items \
         WHERE substr(path, 1, ?1) = ?2 AND length(path) > ?1 AND substr(path, ?1 + 1, 1) = '/'",
    )
    .bind(root.len() as i64)
    .bind(root)
    .fetch_all(&db)
    .await?;

    let targets: Vec<(String, String)> = rows
        .iter()
        .map(|row| (row.get::<String, _>("id"), row.get::<String, _>("path")))
        .collect();

    // Move the files when asked. Files that cannot be trashed keep their
    // catalog rows, so the user loses nothing and a retry can converge. Files
    // that are already missing are treated as success for the catalog work.
    let mut keep_rows = std::collections::HashSet::new();
    if delete_files && !targets.is_empty() {
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
            let batch_ok = matches!(result, Ok(Ok(())));
            if batch_ok {
                continue;
            }
            for (id, path) in chunk {
                if !std::path::Path::new(path).exists() {
                    continue; // file already gone — row is safe to drop
                }
                let p = path.clone();
                match tokio::task::spawn_blocking(move || trash::delete(&p)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) | Err(_) => {
                        keep_rows.insert(id.clone());
                    }
                }
            }
        }
    }
    let dropped: Vec<&(String, String)> = targets
        .iter()
        .filter(|(id, _)| !keep_rows.contains(id))
        .collect();
    let mut tx = db.begin().await?;

    // Clean up join rows explicitly instead of relying on foreign-key cascades
    // being enabled on this particular pooled connection.
    for (id, _) in &dropped {
        for statement in [
            "DELETE FROM media_tags WHERE media_id = ?",
            "DELETE FROM album_items WHERE media_id = ?",
            "DELETE FROM media_items WHERE id = ?",
        ] {
            sqlx::query(statement).bind(id).execute(&mut *tx).await?;
        }
    }

    // Forget the folder itself, plus any registered subfolder that lived
    // inside it, so a later import is not shadowed by stale entries.
    // Only forget the folder if nothing remains under it; rows that kept
    // their file stay registered so a retry can finish the job.
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM media_items WHERE substr(path, 1, ?1) = ?2 AND length(path) > ?1 AND substr(path, ?1 + 1, 1) = '/'",
    )
    .bind(root.len() as i64)
    .bind(root)
    .fetch_one(&mut *tx)
    .await?;
    if remaining == 0 {
        let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
            .fetch_all(&mut *tx)
            .await?;
        for registered_path in registered {
            if super::normalize_root(&registered_path) == root
                || super::path_is_inside(&registered_path, root)
            {
                sqlx::query("DELETE FROM library_folders WHERE path = ?")
                    .bind(&registered_path)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }

    tx.commit().await?;

    Ok(dropped.len() as i64)
}

#[tauri::command]
pub async fn toggle_favorite(
    item_id: String,
    favorite: bool,
    catalog: State<'_, crate::Catalog>,
    app: tauri::AppHandle,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    let changed = sqlx::query("UPDATE media_items SET favorite = ?, updated_at = ? WHERE id = ?")
        .bind(if favorite { 1i32 } else { 0i32 })
        .bind(super::now_ms())
        .bind(&item_id)
        .execute(&db)
        .await?
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
    reason: Option<String>,
    catalog: State<'_, crate::Catalog>,
    app: tauri::AppHandle,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    let changed = sqlx::query(
        "UPDATE media_items SET hidden = ?, hidden_reason = ?, updated_at = ? WHERE id = ?",
    )
    .bind(if hidden { 1i32 } else { 0i32 })
    .bind(if hidden {
        reason
            .filter(|value| !value.is_empty())
            .or(Some("manual".to_string()))
    } else {
        None
    })
    .bind(super::now_ms())
    .bind(&item_id)
    .execute(&db)
    .await?
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
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    sqlx::query("UPDATE media_items SET rating = ?, updated_at = ? WHERE id = ?")
        .bind(rating)
        .bind(super::now_ms())
        .bind(&item_id)
        .execute(&db)
        .await?;
    Ok(())
}

/// Set the color label on a media item. Valid values: red, yellow, green,
/// blue, purple. Pass null (or empty string) to clear.
#[tauri::command]
pub async fn set_color_label(
    item_id: String,
    color_label: Option<String>,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    apply_color_label(&db, &item_id, color_label).await
}

/// Core implementation of `set_color_label`, extracted so it can be tested
/// against an in-memory database without a Tauri `State`.
///
/// `None` and an empty string both write NULL: the inspector's "none" option and
/// clearing an existing label are the same operation, and both must store an
/// absent value rather than leaving the old one behind.
pub async fn apply_color_label(
    db: &SqlitePool,
    item_id: &str,
    color_label: Option<String>,
) -> Result<(), CommandError> {
    let color_label = color_label.filter(|value| !value.is_empty());
    sqlx::query("UPDATE media_items SET color_label = ?, updated_at = ? WHERE id = ?")
        .bind(color_label)
        .bind(super::now_ms())
        .bind(item_id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod color_label_tests {
    use super::apply_color_label;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn label_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory db");
        sqlx::query(
            "CREATE TABLE media_items (id TEXT PRIMARY KEY, color_label TEXT, updated_at INTEGER)",
        )
        .execute(&db)
        .await
        .expect("create media_items");
        sqlx::query("INSERT INTO media_items (id, color_label) VALUES ('a', 'red')")
            .execute(&db)
            .await
            .expect("seed row");
        db
    }

    async fn stored(db: &sqlx::SqlitePool) -> Option<String> {
        sqlx::query_scalar("SELECT color_label FROM media_items WHERE id = 'a'")
            .fetch_one(db)
            .await
            .expect("read color label")
    }

    #[tokio::test]
    async fn clearing_writes_null_rather_than_leaving_the_old_label() {
        let db = label_db().await;
        assert_eq!(stored(&db).await.as_deref(), Some("red"));

        apply_color_label(&db, "a", None)
            .await
            .expect("clear label");

        assert_eq!(stored(&db).await, None, "clearing must store NULL");
    }

    #[tokio::test]
    async fn an_empty_string_clears_like_none() {
        let db = label_db().await;

        apply_color_label(&db, "a", Some(String::new()))
            .await
            .expect("clear with empty string");

        assert_eq!(stored(&db).await, None);
    }

    #[tokio::test]
    async fn setting_a_label_replaces_the_previous_one() {
        let db = label_db().await;

        apply_color_label(&db, "a", Some("blue".to_string()))
            .await
            .expect("set label");

        assert_eq!(stored(&db).await.as_deref(), Some("blue"));
    }
}

/// Core implementation of `update_item_tags`, extracted so it can be tested
/// against an in-memory database without a Tauri `State`.
pub async fn apply_item_tags(
    db: &SqlitePool,
    item_id: &str,
    tags: &[String],
) -> Result<(), CommandError> {
    let mut tx = db.begin().await?;

    sqlx::query("DELETE FROM media_tags WHERE media_id = ?")
        .bind(item_id)
        .execute(&mut *tx)
        .await?;

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
                .await?;

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
                .await?;
                new_id
            }
        };

        sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)")
            .bind(item_id)
            .bind(&tag_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn update_item_tags(
    item_id: String,
    tags: Vec<String>,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
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
    use super::{cursor_value, get_library_items_page, matching_ids, LibraryCursor};
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
            crate::media_kind::MediaKind::Photo,
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
        assert_eq!(first.total_count, Some(3));

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
        assert_eq!(second.total_count, None);
    }

    #[tokio::test]
    async fn matching_ids_returns_exactly_the_filtered_rows() {
        let db = page_db().await;
        for (id, captured_at, hidden) in
            [("a", 30_i64, 0), ("b", 20, 0), ("c", 10, 0), ("d", 25, 1)]
        {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, hidden) VALUES (?, ?, ?, 'jpg', 'photo', ?, ?, ?, 1, 1, ?)")
                .bind(id)
                .bind(format!("/tmp/{id}.jpg"))
                .bind(format!("{id}.jpg"))
                .bind(1_i64)
                .bind(1_i64)
                .bind(captured_at)
                .bind(hidden)
                .execute(&db)
                .await
                .expect("insert media row");
        }

        let ids = matching_ids(&db, LibraryFilterDTO::default())
            .await
            .unwrap();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string(), "c".to_string()]);

        // Hidden rows are excluded by default, matching the library view.
        let ids_all = matching_ids(
            &db,
            LibraryFilterDTO {
                hidden: Some(true),
                ..LibraryFilterDTO::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(ids_all, vec!["d".to_string()]);
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
        sqlx::query("CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color_index INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0)")
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

    async fn set_hidden(db: &SqlitePool, id: &str) {
        sqlx::query("UPDATE media_items SET hidden = 1 WHERE id = ?")
            .bind(id)
            .execute(db)
            .await
            .expect("hide row");
    }

    #[tokio::test]
    async fn unspecified_hidden_excludes_hidden_items_from_items_and_count() {
        let db = filter_db().await;
        insert_item(&db, "shown", "photo", Some(1), 1, None).await;
        insert_item(&db, "secret", "photo", Some(2), 2, None).await;
        set_hidden(&db, "secret").await;

        let page = get_library_items_page(
            &db,
            LibraryFilterDTO {
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .expect("read default page");

        let ids: Vec<&str> = page.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["shown"]);
        assert_eq!(page.total_count, Some(1));
    }

    #[tokio::test]
    async fn hidden_true_counts_the_hidden_items_it_returns() {
        let db = filter_db().await;
        insert_item(&db, "shown", "photo", Some(1), 1, None).await;
        insert_item(&db, "secret", "photo", Some(2), 2, None).await;
        set_hidden(&db, "secret").await;

        let page = get_library_items_page(
            &db,
            LibraryFilterDTO {
                hidden: Some(true),
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .expect("read hidden page");

        let ids: Vec<&str> = page.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["secret"]);
        assert_eq!(page.total_count, Some(1));
    }

    #[tokio::test]
    async fn tag_filter_matches_any_of_the_given_tags() {
        let db = filter_db().await;
        insert_item(&db, "beach", "photo", Some(3), 3, None).await;
        insert_item(&db, "party", "photo", Some(2), 2, None).await;
        insert_item(&db, "plain", "photo", Some(1), 1, None).await;
        for (id, name) in [("t-travel", "travel"), ("t-family", "family")] {
            sqlx::query("INSERT INTO tags (id, name) VALUES (?, ?)")
                .bind(id)
                .bind(name)
                .execute(&db)
                .await
                .expect("insert tag");
        }
        for (media, tag) in [("beach", "t-travel"), ("party", "t-family")] {
            sqlx::query("INSERT INTO media_tags (media_id, tag_id) VALUES (?, ?)")
                .bind(media)
                .bind(tag)
                .execute(&db)
                .await
                .expect("tag item");
        }

        for (tags, expected) in [
            (vec!["travel"], vec!["beach"]),
            (vec!["travel", "family"], vec!["beach", "party"]),
        ] {
            let page = get_library_items_page(
                &db,
                LibraryFilterDTO {
                    tags: Some(tags.iter().map(|t| t.to_string()).collect()),
                    limit: Some(10),
                    ..Default::default()
                },
            )
            .await
            .expect("tag filter query must be valid SQL");
            let mut ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
            ids.sort();
            assert_eq!(ids, expected);
            assert_eq!(page.total_count, Some(expected.len() as i64));
        }
    }

    #[tokio::test]
    async fn search_treats_percent_and_underscore_literally() {
        let db = filter_db().await;
        insert_item(&db, "IMG_0001", "photo", Some(1), 1, None).await;
        insert_item(&db, "IMGX0002", "photo", Some(2), 2, None).await;
        insert_item(&db, "sale-100%", "photo", Some(3), 3, None).await;
        insert_item(&db, "sale-1000", "photo", Some(4), 4, None).await;

        let search = |query: &str| {
            let db = db.clone();
            let query = query.to_string();
            async move {
                let page = get_library_items_page(
                    &db,
                    LibraryFilterDTO {
                        query: Some(query),
                        limit: Some(10),
                        ..Default::default()
                    },
                )
                .await
                .expect("search");
                let mut ids: Vec<String> = page.items.into_iter().map(|i| i.id).collect();
                ids.sort();
                ids
            }
        };

        assert_eq!(search("IMG_").await, ["IMG_0001"]);
        assert_eq!(search("100%").await, ["sale-100%"]);
        assert_eq!(search("_").await, ["IMG_0001"]);
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
        assert_eq!(page.total_count, Some(2));
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

    #[tokio::test]
    async fn shared_album_covers_are_not_consumed_by_the_first_album() {
        let db = filter_db().await;
        insert_item(&db, "cover-a", "photo", Some(3), 3, None).await;
        insert_item(&db, "cover-b", "photo", Some(2), 2, None).await;
        insert_item(&db, "cover-c", "photo", Some(1), 1, None).await;
        sqlx::query(
            "INSERT INTO albums (id, name, created_at, updated_at) VALUES \
             ('first', 'First', 1, 1), ('second', 'Second', 2, 2)",
        )
        .execute(&db)
        .await
        .expect("insert albums");

        // The same photos cover both albums. The first album must not take
        // them out of the shared lookup used by the rest.
        for album in ["first", "second"] {
            for id in ["cover-a", "cover-b", "cover-c"] {
                sqlx::query(
                    "INSERT INTO album_items (album_id, media_id, added_at) VALUES (?, ?, 1)",
                )
                .bind(album)
                .bind(id)
                .execute(&db)
                .await
                .expect("insert album item");
            }
        }

        let overview = load_album_overviews(&db).await.expect("album overview");
        assert_eq!(overview.len(), 2);
        for album in &overview {
            assert_eq!(
                album.cover_items.len(),
                3,
                "album {} lost shared cover items",
                album.id
            );
        }
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
            first.total_count.unwrap_or_default(),
            first_page_ms,
            overview.len(),
            overview.first().map(|album| album.cover_items.len()).unwrap_or(0),
            overview_ms,
        );
        assert_eq!(first.items.len(), 250);
        assert_eq!(first.total_count, Some(10_000));
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
        let (mut paths, error) = collect_media_paths(&root, &AtomicBool::new(false), None);
        paths.sort();
        assert!(error.is_none());
        assert_eq!(paths, vec![root.join("a.jpg"), root.join("nested/b.PNG")]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_sweeps_stale_export_temps_only_when_asked() {
        let root = tree();
        let stale = root.join(format!("a.tmp-{}", uuid::Uuid::new_v4()));
        let fresh = root.join(format!("b.tmp-{}", uuid::Uuid::new_v4()));
        fs::write(&stale, b"partial").unwrap();
        fs::write(&fresh, b"in progress").unwrap();
        let old = filetime::FileTime::from_unix_time(1_000_000_000, 0);
        filetime::set_file_mtime(&stale, old).unwrap();

        // Imports pass None: nothing is removed.
        collect_media_paths(&root, &AtomicBool::new(false), None);
        assert!(stale.exists());

        // Scans pass a grace period: the old temp goes, the fresh one stays,
        // and media discovery is unchanged.
        let (mut paths, _) = collect_media_paths(
            &root,
            &AtomicBool::new(false),
            Some(std::time::Duration::from_secs(300)),
        );
        paths.sort();
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert_eq!(paths, vec![root.join("a.jpg"), root.join("nested/b.PNG")]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_stops_when_cancelled() {
        let root = tree();
        let (paths, _) = collect_media_paths(&root, &AtomicBool::new(true), None);
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

#[cfg(test)]
mod sort_index_tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row;

    async fn plan_for(sql: &str) -> String {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory catalog");
        sqlx::migrate!("./migrations")
            .run(&db)
            .await
            .expect("run migrations");
        let rows = sqlx::query(&format!("EXPLAIN QUERY PLAN {sql}"))
            .bind(0i32)
            .bind(201i64)
            .fetch_all(&db)
            .await
            .expect("explain query");
        rows.iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The default page (`get_library_items_page` with no sort) must walk the
    /// sort index instead of sorting the whole table for every page.
    #[tokio::test]
    async fn default_library_sort_uses_index_without_temp_sort() {
        let plan = plan_for(
            "SELECT * FROM media_items WHERE 1=1 AND hidden = ? \
             ORDER BY COALESCE(captured_at, modified_at) DESC, id ASC LIMIT ?",
        )
        .await;
        assert!(plan.contains("idx_media_hidden_sort_date_id"), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    }
}

#[cfg(test)]
mod thumbnail_bytes_tests {
    use super::jpeg_dimensions;

    #[test]
    fn reads_dimensions_from_encoded_bytes() {
        let img = image::RgbImage::new(7, 3);
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        assert_eq!(jpeg_dimensions(&bytes), Some((7, 3)));
    }

    #[test]
    fn rejects_corrupt_bytes() {
        assert_eq!(jpeg_dimensions(b"not an image"), None);
    }
}

#[cfg(test)]
mod remove_library_folder_tests {
    use super::remove_library_folder_inner;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn seeded_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        db
    }

    async fn seed_folder_and_rows(db: &sqlx::SqlitePool, root: &str, count: usize) {
        sqlx::query("INSERT INTO library_folders (path, added_at) VALUES (?, 1)")
            .bind(root)
            .execute(db)
            .await
            .unwrap();
        for i in 0..count {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES (?, ?, 'a.jpg', 'jpg', 'photo', 1, 1, 1, 1)")
                .bind(format!("id-{i}"))
                .bind(format!("{root}/inner/{i}.jpg"))
                .execute(db)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn missing_files_drop_rows_and_forget_the_folder() {
        let db = seeded_db().await;
        let root = "/visto-does-not-exist-b3-test";
        seed_folder_and_rows(&db, root, 2).await;
        // Files do not exist: rows drop and the folder is forgotten.
        let dropped = remove_library_folder_inner(&db, root, true).await.unwrap();
        assert_eq!(dropped, 2);
        let rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM media_items WHERE path LIKE '/visto-does-not-exist-b3-test/%'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(rows, 0);
        let folders: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_folders WHERE path = ?")
                .bind(root)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(folders, 0);
    }

    #[tokio::test]
    async fn rerun_is_idempotent() {
        let db = seeded_db().await;
        let root = "/visto-does-not-exist-b3-retry";
        seed_folder_and_rows(&db, root, 2).await;
        assert_eq!(
            remove_library_folder_inner(&db, root, true).await.unwrap(),
            2
        );
        // Folder is forgotten, so a retry refuses cleanly instead of
        // silently succeeding again.
        let err = remove_library_folder_inner(&db, root, true)
            .await
            .unwrap_err();
        assert_eq!(err.code, crate::errors::ErrorCode::PathNotAllowed);
    }
}

#[cfg(test)]
mod library_folders_tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use std::fs;

    #[tokio::test]
    async fn registered_but_missing_root_is_listed_as_unavailable() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory catalog");
        sqlx::migrate!("./migrations")
            .run(&db)
            .await
            .expect("run migrations");

        let existing = std::env::temp_dir().join(format!("visto-src-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&existing).expect("create existing source");
        let missing = std::env::temp_dir().join(format!("visto-missing-{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&missing);

        for path in [&existing, &missing] {
            sqlx::query("INSERT INTO library_folders (path, added_at) VALUES (?, 0)")
                .bind(path.to_string_lossy().as_ref())
                .execute(&db)
                .await
                .expect("insert library folder");
        }

        let folders = super::get_library_folders_inner(&db)
            .await
            .expect("list folders");
        let existing_path = existing.to_string_lossy().to_string();
        let missing_path = missing.to_string_lossy().to_string();

        let existing_row = folders
            .iter()
            .find(|f| f.path == existing_path)
            .expect("existing");
        let missing_row = folders
            .iter()
            .find(|f| f.path == missing_path)
            .expect("missing");

        assert!(
            existing_row.available,
            "existing source should be available"
        );
        assert!(!missing_row.available, "deleted source should be missing");
        assert_eq!(missing_row.item_count, 0);

        let _ = fs::remove_dir_all(&existing);
    }
}

#[cfg(test)]
mod library_stats_tests {
    use super::library_stats;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn total_size_includes_animated_items() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        for (id, ext, kind, size, animated) in [
            ("still", "jpg", "photo", 100, 0),
            ("loop", "gif", "photo", 40, 1),
            ("clip", "mp4", "video", 1000, 0),
        ] {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at, is_animated) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?)")
                .bind(id)
                .bind(format!("/lib/{id}.{ext}"))
                .bind(format!("{id}.{ext}"))
                .bind(ext)
                .bind(kind)
                .bind(size)
                .bind(animated)
                .execute(&db)
                .await
                .unwrap();
        }

        let stats = library_stats(&db).await.unwrap();
        assert_eq!((stats.photos, stats.animations, stats.videos), (1, 1, 1));
        assert_eq!(stats.photo_size, 100);
        assert_eq!(stats.animations_size, 40);
        assert_eq!(stats.total_size, 1140);
    }

    /// The Hidden screen's chips count every hidden item by kind, and the
    /// library's own counts leave hidden items out.
    #[tokio::test]
    async fn hidden_scope_counts_only_hidden_items_by_kind() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        for (id, ext, kind, size, hidden) in [
            ("shown", "jpg", "photo", 10, 0),
            ("p1", "jpg", "photo", 20, 1),
            ("p2", "heic", "photo", 30, 1),
            ("v1", "mp4", "video", 500, 1),
            ("r1", "cr2", "raw", 70, 1),
        ] {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at, hidden) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?)")
                .bind(id)
                .bind(format!("/lib/{id}.{ext}"))
                .bind(format!("{id}.{ext}"))
                .bind(ext)
                .bind(kind)
                .bind(size)
                .bind(hidden)
                .execute(&db)
                .await
                .unwrap();
        }

        let hidden = super::library_stats_scoped(&db, true).await.unwrap();
        assert_eq!((hidden.photos, hidden.videos, hidden.raws), (2, 1, 1));
        assert_eq!(hidden.total_size, 620);
        assert_eq!(hidden.hidden, 4);

        let visible = library_stats(&db).await.unwrap();
        assert_eq!((visible.photos, visible.videos, visible.raws), (1, 0, 0));
        assert_eq!(visible.hidden, 4);
    }
}

#[cfg(test)]
mod items_by_ids_tests {
    use super::items_by_ids;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn db_with_items(count: usize) -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        for i in 0..count {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES (?, ?, ?, 'jpg', 'photo', 1, 1, 1, 1)")
                .bind(format!("id-{i}"))
                .bind(format!("/lib/{i}.jpg"))
                .bind(format!("{i}.jpg"))
                .execute(&db)
                .await
                .unwrap();
        }
        db
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[tokio::test]
    async fn returns_items_in_request_order_and_skips_unknown_ids() {
        let db = db_with_items(3).await;
        let items = items_by_ids(&db, &ids(&["id-2", "gone", "id-0", "id-2"]))
            .await
            .unwrap();
        let got: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(got, vec!["id-2", "id-0"]);
    }

    #[tokio::test]
    async fn looks_up_more_ids_than_one_statement_can_bind() {
        let db = db_with_items(1200).await;
        let wanted: Vec<String> = (0..1200).map(|i| format!("id-{i}")).collect();
        let items = items_by_ids(&db, &wanted).await.unwrap();
        assert_eq!(items.len(), 1200);
        assert_eq!(items[1199].id, "id-1199");
    }

    #[tokio::test]
    async fn empty_request_returns_nothing() {
        let db = db_with_items(1).await;
        assert!(items_by_ids(&db, &[]).await.unwrap().is_empty());
    }
}
