//! Catalog SQL helpers (album/tag selects, purge, relink).

use std::collections::{HashMap, HashSet};
use std::path::Path;

use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

use crate::commands::{file_modified_at, now_ms, path_is_inside};
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
pub(crate) async fn relink_moved_items(
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

/// Secure export: the backend owns path selection via native dialog.
/// Writes to a temp file next to the destination, then renames atomically.
#[tauri::command]
pub async fn get_tags(catalog: State<'_, Catalog>) -> Result<Vec<Tag>, String> {
    let db = crate::commands::get_db(&catalog)?;
    let tags = sqlx::query_as::<_, Tag>(&format!("{} ORDER BY t.name ASC", TAG_SELECT))
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
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
) -> Result<(), String> {
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
