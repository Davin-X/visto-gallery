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

mod thumbnails;
pub use thumbnails::*;

/// What adding a folder as separate sources would cover.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSplit {
    /// Immediate, non-hidden subfolders, sorted. Each becomes its own source.
    pub subfolders: Vec<String>,
    /// Media files directly in the folder. Splitting skips them.
    pub loose_media_count: usize,
}

/// Symlinked folders are skipped so a link cannot pull a folder from outside
/// the picked one into the library.
pub(crate) fn split_source_folder(root: &Path) -> std::io::Result<SourceSplit> {
    let mut subfolders = Vec::new();
    let mut loose_media_count = 0;
    for entry in std::fs::read_dir(root)?.filter_map(Result::ok) {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
            subfolders.push(path.to_string_lossy().into_owned());
        } else if kind.is_file()
            && path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| is_media_file(&ext.to_lowercase()))
        {
            loose_media_count += 1;
        }
    }
    subfolders.sort();
    Ok(SourceSplit {
        subfolders,
        loose_media_count,
    })
}

/// List a chosen folder's subfolders so each can be added as its own source.
/// The folder must already be granted (picked, pasted or dropped).
#[tauri::command]
pub async fn split_source(
    path: String,
    catalog: State<'_, crate::Catalog>,
    state: State<'_, AppState>,
) -> Result<SourceSplit, CommandError> {
    let db = super::get_db(&catalog)?;
    super::authorize_import_path(&path, &db, &state.grants).await?;
    let root = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || split_source_folder(&root))
        .await
        .map_err(|e| CommandError::internal(format!("Folder listing failed: {e}")))?
        .map_err(|e| CommandError::io(format!("Cannot read '{path}': {e}")))
}

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
    let albums = sqlx::query_as::<_, Album>(sqlx::AssertSqlSafe(format!(
        "{} ORDER BY a.created_at ASC",
        ALBUM_SELECT
    )))
    .fetch_all(&db)
    .await?;
    let tags = sqlx::query_as::<_, Tag>(sqlx::AssertSqlSafe(format!(
        "{} ORDER BY t.name ASC",
        TAG_SELECT
    )))
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
        // A media file is served from its original path through the asset
        // protocol (a video plays natively; a still is served as-is or via a
        // preview). The path was just authorized as picked, so grant the asset
        // scope too — otherwise the first render returns 403 and the tile or
        // the slideshow shows nothing.
        let grant_path = std::path::PathBuf::from(raw);
        if grant_path.is_dir() {
            let _ = app
                .asset_protocol_scope()
                .allow_directory(&grant_path, true);
        } else if grant_path.is_file() {
            let _ = app.asset_protocol_scope().allow_file(&grant_path);
        }
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

    let albums = sqlx::query_as::<_, Album>(sqlx::AssertSqlSafe(format!(
        "{} ORDER BY a.created_at ASC",
        ALBUM_SELECT
    )))
    .fetch_all(&db)
    .await?;
    let tags = sqlx::query_as::<_, Tag>(sqlx::AssertSqlSafe(format!(
        "{} ORDER BY t.name ASC",
        TAG_SELECT
    )))
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
    lock: State<'_, super::HiddenLock>,
) -> Result<LibraryItemsPage, CommandError> {
    let db = super::get_db(&catalog)?;
    super::hidden_lock::require_hidden_access(&db, &lock).await?;
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

/// The `YYYY-MM` an item is grouped under in the Timeline, matching the
/// frontend's `itemMonth`: a capture time is camera wall-clock stored as if it
/// were UTC, so its month is read in UTC; a modification time is a real instant,
/// so its month is read in local time.
pub(crate) const TIMELINE_MONTH_SQL: &str = "(CASE WHEN captured_at IS NOT NULL \
     THEN strftime('%Y-%m', captured_at / 1000, 'unixepoch') \
     ELSE strftime('%Y-%m', modified_at / 1000, 'unixepoch', 'localtime') END)";

/// Cover thumbnails shown on a collapsed Timeline month.
const TIMELINE_COVERS_PER_MONTH: i64 = 4;

/// One Timeline month for the current filter: its real item count, whatever
/// pages are loaded, and the newest few items as covers.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMonth {
    /// `YYYY-MM`.
    pub key: String,
    pub count: i64,
    pub cover_ids: Vec<String>,
}

/// Every month that has items under `filter`, newest first.
#[tauri::command]
pub async fn get_timeline_months(
    filter: Option<super::LibraryFilterDTO>,
    catalog: State<'_, crate::Catalog>,
    lock: State<'_, super::HiddenLock>,
) -> Result<Vec<TimelineMonth>, CommandError> {
    let db = super::get_db(&catalog)?;
    let filter = filter.unwrap_or_default();
    // Months for the Hidden screen describe hidden items, so they need the
    // same proof of access as listing them. The visible Timeline (`hidden`
    // false or unset) needs none.
    if filter.hidden == Some(true) {
        super::hidden_lock::require_hidden_access(&db, &lock).await?;
    }
    timeline_months(&db, filter).await
}

pub(crate) async fn timeline_months(
    db: &SqlitePool,
    mut f: super::LibraryFilterDTO,
) -> Result<Vec<TimelineMonth>, CommandError> {
    f.hidden.get_or_insert(false);
    // Paging and a single-month restriction would describe a slice, not the
    // whole Timeline.
    f.limit = None;
    f.cursor = None;
    f.month = None;

    let mut counts: QueryBuilder<Sqlite> = QueryBuilder::new("SELECT ");
    counts
        .push(TIMELINE_MONTH_SQL)
        .push(" AS ym, COUNT(*) FROM media_items WHERE 1=1");
    push_library_filters(&mut counts, &f);
    counts.push(" GROUP BY ym ORDER BY ym DESC");
    let rows: Vec<(String, i64)> = counts.build_query_as().fetch_all(db).await?;

    let mut covers: QueryBuilder<Sqlite> = QueryBuilder::new(
        "SELECT ym, id FROM (SELECT id, ym, ROW_NUMBER() OVER (PARTITION BY ym \
         ORDER BY ts DESC, id) AS rn FROM (SELECT id, ",
    );
    covers
        .push(TIMELINE_MONTH_SQL)
        .push(" AS ym, COALESCE(captured_at, modified_at) AS ts FROM media_items WHERE 1=1");
    push_library_filters(&mut covers, &f);
    covers
        .push(")) WHERE rn <= ")
        .push_bind(TIMELINE_COVERS_PER_MONTH)
        .push(" ORDER BY ym DESC, rn");
    let cover_rows: Vec<(String, String)> = covers.build_query_as().fetch_all(db).await?;

    let mut by_month: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for (month, id) in cover_rows {
        by_month.entry(month).or_default().push(id);
    }
    Ok(rows
        .into_iter()
        .map(|(key, count)| TimelineMonth {
            cover_ids: by_month.remove(&key).unwrap_or_default(),
            key,
            count,
        })
        .collect())
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
                " AND id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name COLLATE NOCASE IN (",
            );
            let mut names = qb.separated(", ");
            for tag in tags {
                names.push_bind(tag.clone());
            }
            qb.push(")");
            if f.tag_match.as_deref() == Some("all") {
                // Tags are unique ignoring case (ASCII, like NOCASE), so
                // `Beach` and `beach` in one request count as one tag.
                let needed = tags
                    .iter()
                    .map(|tag| tag.to_ascii_lowercase())
                    .collect::<std::collections::HashSet<_>>()
                    .len() as i64;
                qb.push(" GROUP BY mt.media_id HAVING COUNT(DISTINCT lower(t.name)) = ")
                    .push_bind(needed);
            }
            qb.push(")");
        }
    }
    if let Some(size_min) = f.size_min {
        qb.push(" AND size >= ").push_bind(size_min);
    }
    if let Some(size_max) = f.size_max {
        qb.push(" AND size <= ").push_bind(size_max);
    }
    if let Some(extension) = &f.extension {
        // Normalise here, at the single choke point, so a direct
        // `LibraryFilterDTO { extension: Some(".JPG") }` caller still matches
        // the dot-less lowercase value stored in `media_items`.
        let extension = extension.trim().trim_start_matches('.').to_lowercase();
        if !extension.is_empty() {
            qb.push(" AND lower(extension) = ").push_bind(extension);
        }
    }
    if let Some(has_location) = f.has_location {
        qb.push(if has_location {
            " AND latitude IS NOT NULL AND longitude IS NOT NULL"
        } else {
            " AND (latitude IS NULL OR longitude IS NULL)"
        });
    }
    if let Some(orientation) = &f.orientation {
        match orientation.as_str() {
            "landscape" => {
                qb.push(" AND width IS NOT NULL AND height IS NOT NULL AND width > height");
            }
            "portrait" => {
                qb.push(" AND width IS NOT NULL AND height IS NOT NULL AND width < height");
            }
            "square" => {
                qb.push(" AND width IS NOT NULL AND height IS NOT NULL AND width = height AND width > 0");
            }
            _ => {}
        }
    }
    if let Some(query) = &f.query {
        // `%` and `_` typed by the user are literal characters, not wildcards.
        let like = format!("%{}%", escape_like(query));
        // A file picked on its own has no registered root, so only the name of
        // the folder it sits in is searchable: never the home-directory prefix.
        let dir = "rtrim(rtrim(media_items.path, replace(media_items.path, '/', '')), '/')";
        let loose_parent =
            format!("substr({dir}, length(rtrim({dir}, replace({dir}, '/', ''))) + 1)");
        qb.push(" AND (name LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\'")
            // Only the part of the path inside a registered library folder is
            // searchable. Matching the raw absolute path let a query like
            // `dev` hit the home-directory prefix and return the library.
            .push(" OR EXISTS (SELECT 1 FROM library_folders lf WHERE substr(media_items.path, 1, length(rtrim(lf.path, '/')))")
            .push(" = rtrim(lf.path, '/') AND substr(media_items.path, length(rtrim(lf.path, '/')) + 2) LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\')")
            .push(" OR (NOT EXISTS (SELECT 1 FROM library_folders lf WHERE substr(media_items.path, 1, length(rtrim(lf.path, '/'))) = rtrim(lf.path, '/'))")
            .push(format!(" AND {loose_parent} LIKE "))
            .push_bind(like.clone())
            .push(" ESCAPE '\\')")
            .push(" OR extension LIKE ")
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
    if let Some(month) = &f.month {
        qb.push(" AND ")
            .push(TIMELINE_MONTH_SQL)
            .push(" = ")
            .push_bind(month.clone());
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
        // The only interpolated part is a run of `?` placeholders, one per id.
        let mut tag_query = sqlx::query_as::<_, (String, String)>(sqlx::AssertSqlSafe(tag_sql));
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
        let mut album_query = sqlx::query_as::<_, (String, String)>(sqlx::AssertSqlSafe(album_sql));
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
    lock: State<'_, super::HiddenLock>,
) -> Result<LibraryStats, CommandError> {
    let db = super::get_db(&catalog)?;
    let mut stats = library_stats(&db).await?;
    // While Hidden is locked, its count and size are not shown either.
    if !super::hidden_lock::hidden_visible(&db, &lock).await {
        stats.hidden = 0;
        stats.hidden_size = 0;
    }
    Ok(stats)
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
    lock: State<'_, super::HiddenLock>,
) -> Result<LibraryStats, CommandError> {
    let db = super::get_db(&catalog)?;
    super::hidden_lock::require_hidden_access(&db, &lock).await?;
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
    // `scope` is 0 or 1 from a bool, never request data.
    let row = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64)>(
        sqlx::AssertSqlSafe(format!(
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
        )),
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
    // A newly hidden item must not stay readable in the cache folder.
    if hidden && changed > 0 {
        let row: Option<(String,)> = sqlx::query_as("SELECT path FROM media_items WHERE id = ?")
            .bind(&item_id)
            .fetch_optional(&db)
            .await?;
        if let (Some((path,)), Ok(cache)) = (row, app.path().app_cache_dir()) {
            let id = item_id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                for dir in [super::storage::THUMBNAILS_DIR, super::storage::PREVIEWS_DIR] {
                    super::storage::remove_item_thumbnails(&cache.join(dir), &id);
                }
                super::playback::remove_cached_remux(
                    &cache.join(super::storage::PLAYBACK_DIR),
                    std::path::Path::new(&path),
                );
            })
            .await;
        }
    }
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
mod tests;
#[cfg(test)]
mod tests_queries;
