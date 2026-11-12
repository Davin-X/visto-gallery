//! Catalog SQL helpers (album/tag selects, purge, relink).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

use crate::commands::{file_modified_at, normalize_root, now_ms, path_is_inside};
use crate::errors::CommandError;
use crate::models::{stable_id, Tag};
use crate::{AppState, Catalog};

/// Album rows with their item count folded in, so `Album.item_count` is always a
/// real column on the result set.
pub(crate) const ALBUM_SELECT: &str =
    "SELECT a.id, a.name, a.color_index, a.created_at, a.updated_at, \
     (SELECT COUNT(*) FROM album_items ai JOIN media_items m ON m.id = ai.media_id \
      WHERE ai.album_id = a.id AND m.hidden = 0) AS item_count FROM albums a";

/// Tag rows with their item count folded in, mirroring [`ALBUM_SELECT`].
pub(crate) const TAG_SELECT: &str = "SELECT t.id, t.name, t.color_index, t.created_at, \
     (SELECT COUNT(*) FROM media_tags mt JOIN media_items m ON m.id = mt.media_id \
      WHERE mt.tag_id = t.id AND m.hidden = 0) AS item_count FROM tags t";

/// Delete every catalog row in one transaction: a failure part-way leaves the
/// catalog exactly as it was instead of half-deleted.
pub(crate) async fn purge_catalog(db: &SqlitePool) -> Result<(), CommandError> {
    let mut tx = db.begin().await?;
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
            .map_err(|e| CommandError::database(format!("Could not clear {table}: {e}")))?;
    }
    tx.commit().await.map_err(CommandError::from)
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

/// One catalog row, in the shape the incremental scan needs.
#[derive(Debug, Clone)]
pub(crate) struct CatalogRow {
    pub id: String,
    pub path: String,
    pub size: i64,
    pub modified_at: i64,
    pub content_signature: Option<String>,
}

/// Half-open range covering every path inside `root`.
///
/// A range keeps SQLite on the `path` index; `substr(path, 1, length(?)) = ?`
/// looks equivalent but forces a scan of the whole catalog, which is exactly
/// what a per-root scan must avoid. The prefix always ends in `/`, so bumping
/// that byte yields an exclusive upper bound.
fn root_path_range(root: &str) -> (String, String) {
    let lower = format!("{}/", normalize_root(root).trim_end_matches('/'));
    let mut upper = lower.clone();
    upper.pop();
    upper.push('0');
    (lower, upper)
}

/// The catalog rows under `root`, and nothing else.
///
/// A scan used to read the whole `media_items` table two or three times: once
/// for the incremental "already known" check, once for move detection, once for
/// pruning. All three passes only ever look at paths inside the root being
/// walked, so the filter belongs in SQL and one load answers all three.
pub(crate) async fn catalog_rows_under_root(
    db: &SqlitePool,
    root: &str,
) -> Result<Vec<CatalogRow>, CommandError> {
    let (lower, upper) = root_path_range(root);
    let rows: Vec<(String, String, i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT id, path, size, modified_at, content_signature FROM media_items \
         WHERE path >= ? AND path < ?",
    )
    .bind(&lower)
    .bind(&upper)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, path, size, modified_at, content_signature)| CatalogRow {
                id,
                path,
                size,
                modified_at,
                content_signature,
            },
        )
        .collect())
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
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn relink_moved_items(
    db: &SqlitePool,
    root: &str,
    seen_paths: &HashSet<String>,
) -> Result<usize, CommandError> {
    let catalog = catalog_rows_under_root(db, root).await?;
    relink_moved_items_from(db, &catalog, root, seen_paths).await
}

/// [`relink_moved_items`] against an already-loaded catalog snapshot, so a scan
/// pays for the rows once.
pub(crate) async fn relink_moved_items_from(
    db: &SqlitePool,
    catalog: &[CatalogRow],
    root: &str,
    seen_paths: &HashSet<String>,
) -> Result<usize, CommandError> {
    let existing_paths: HashSet<&str> = catalog.iter().map(|row| row.path.as_str()).collect();
    let mut added: Vec<&String> = seen_paths
        .iter()
        .filter(|path| !existing_paths.contains(path.as_str()))
        .collect();
    if added.is_empty() {
        return Ok(0);
    }

    // Rows whose file this walk did not see are the only move candidates.
    let vanished: Vec<(&str, i64, i64, Option<String>)> = catalog
        .iter()
        .filter(|row| path_is_inside(&row.path, root) && !seen_paths.contains(&row.path))
        .map(|row| {
            (
                row.id.as_str(),
                row.size,
                row.modified_at,
                row.content_signature.clone(),
            )
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
        // A hash collision must not rewrite another row's key. The snapshot
        // only holds this root's rows, so ask the catalog about the new id.
        let new_id = stable_id(new_path);
        let collides: Option<i64> = sqlx::query_scalar("SELECT 1 FROM media_items WHERE id = ?")
            .bind(&new_id)
            .fetch_optional(db)
            .await?;
        if collides.is_some() {
            continue;
        }
        used[index] = true;
        moves.push((vanished[index].0, new_path.clone()));
    }
    if moves.is_empty() {
        return Ok(0);
    }

    let now = now_ms();
    let mut transaction = db.begin().await?;
    // Relations point at the row being re-keyed, so enforcement is deferred to
    // COMMIT and every table is updated inside the same transaction.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *transaction)
        .await?;
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
        ?;
        for table in ["media_tags", "album_items", "edit_recipes", "edit_backups"] {
            sqlx::query(&format!(
                "UPDATE {table} SET media_id = ? WHERE media_id = ?"
            ))
            .bind(&new_id)
            .bind(old_id)
            .execute(&mut *transaction)
            .await?;
        }
    }
    transaction.commit().await?;

    Ok(moves.len())
}

/// Secure export: the backend owns path selection via native dialog.
/// Writes to a temp file next to the destination, then renames atomically.
#[tauri::command]
pub async fn get_tags(catalog: State<'_, Catalog>) -> Result<Vec<Tag>, CommandError> {
    let db = crate::commands::get_db(&catalog)?;
    let tags = sqlx::query_as::<_, Tag>(&format!("{} ORDER BY t.name ASC", TAG_SELECT))
        .fetch_all(&db)
        .await?;
    Ok(tags)
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
) -> Result<(), CommandError> {
    let db = crate::commands::get_db(&catalog)?;
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

#[cfg(test)]
mod tests {
    use super::root_path_range;

    #[test]
    fn the_root_range_covers_only_paths_inside_it() {
        let (lower, upper) = root_path_range("/Users/dev/Pictures/");
        assert_eq!(lower, "/Users/dev/Pictures/");
        assert_eq!(upper, "/Users/dev/Pictures0");
        assert!("/Users/dev/Pictures/a.jpg" >= lower.as_str());
        assert!("/Users/dev/Pictures/a.jpg" < upper.as_str());
        // A sibling folder that merely shares the prefix must stay outside.
        assert!("/Users/dev/Pictures2/a.jpg" >= upper.as_str());
    }

    #[test]
    fn the_filesystem_root_range_covers_everything() {
        let (lower, upper) = root_path_range("/");
        assert_eq!(lower, "/");
        assert!("/a.jpg" >= lower.as_str());
        assert!("/a.jpg" < upper.as_str());
    }
}
