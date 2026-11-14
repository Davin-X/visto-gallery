use crate::errors::CommandError;
use serde::Serialize;
use sqlx::Row;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use ts_rs::TS;

/// Explicit, reviewable repair for a source root that moved on disk.
///
/// This never rewrites arbitrary absolute paths: the old path must be an
/// exactly registered library root, the new path must be an existing folder,
/// and only direct descendants of that root are rewritten inside one
/// transaction. Original media files are never modified.

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RootPathMappingPreview {
    pub old_root: String,
    pub new_root: String,
    pub item_count: i64,
    pub root_count: i64,
    pub sample_paths: Vec<String>,
    pub conflicting_paths: Vec<String>,
    pub existing_new_path_count: i64,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RootPathMappingResult {
    pub old_root: String,
    pub new_root: String,
    pub updated_item_count: i64,
}

/// The folder the user picked in the native dialog for the current mapping.
///
/// Recorded server-side so preview and apply accept the renderer's claimed
/// `new_root` only when the user actually chose it, matching the rule that a
/// registered library root must come from a native picker or a drop.
///
/// Single-slot by design: the mapping flow is modal and the app has one
/// window, so a newer pick replaces the previous one (last writer wins).
static MAPPING_PICK: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);

fn canonical_pick_path(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|path| super::normalize_root(&path.to_string_lossy()))
        .unwrap_or_else(|_| super::normalize_root(path))
}

fn remember_mapping_pick(old_root: &str, new_root: &str) {
    let mut pick = MAPPING_PICK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *pick = Some((old_root.to_string(), canonical_pick_path(new_root)));
}

fn mapping_pick_allows(old_root: &str, new_root: &str) -> bool {
    let pick = MAPPING_PICK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    pick.as_ref().is_some_and(|(picked_old, picked_new)| {
        picked_old == old_root && picked_new == &canonical_pick_path(new_root)
    })
}

fn clear_mapping_pick() {
    let mut pick = MAPPING_PICK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *pick = None;
}

fn normalize(path: &str) -> Result<String, CommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() || !trimmed.starts_with('/') {
        return Err(CommandError::invalid(
            "Choose absolute POSIX paths for the moved library mapping.".to_string(),
        ));
    }
    Ok(super::normalize_root(trimmed))
}

fn validate_mapping(old_root: &str, new_root: &str) -> Result<(String, String), CommandError> {
    let old_root = normalize(old_root)?;
    let new_root = normalize(new_root)?;
    if old_root == new_root {
        return Err(CommandError::invalid(
            "The new source root must be different from the missing one.".to_string(),
        ));
    }
    if new_root.len() <= 1 {
        return Err(CommandError::invalid(
            "Choose a real source folder as the new root.".to_string(),
        ));
    }
    if !std::path::Path::new(&new_root).is_dir() {
        return Err(CommandError::not_found(format!(
            "The new source root does not exist or is not a folder: {new_root}"
        )));
    }
    Ok((old_root, new_root))
}

async fn ensure_registered_root(db: &sqlx::SqlitePool, old_root: &str) -> Result<(), CommandError> {
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM library_folders WHERE path = ? LIMIT 1")
            .bind(old_root)
            .fetch_optional(db)
            .await?;
    if found.is_none() {
        return Err(CommandError::path(format!(
            "'{old_root}' is not a registered library source. Register the missing source first; arbitrary path rewrites are refused."
        )));
    }
    Ok(())
}

async fn rekey_moved_paths(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    old_root: &str,
    new_root: &str,
    affected: &[String],
) -> Result<(), CommandError> {
    // Re-keying ids rewrites rows the foreign keys point at, so the check is
    // deferred to commit; both the parent and its children move together.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut **tx)
        .await?;
    let now = super::now_ms();
    for old_path in affected {
        let new_path = mapped_path(old_root, new_root, old_path)
            .ok_or_else(|| format!("Internal mapping failure for {old_path}"))?;
        new_path_for(tx, old_path, &new_path, now).await?;
    }
    Ok(())
}

async fn new_path_for(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    old_path: &String,
    new_path: &String,
    now: i64,
) -> Result<(), CommandError> {
    // The catalog key (`id`) is a function of the path, so a moved
    // source has to move its ids too or the catalog becomes
    // inconsistent and refuses to scan. Re-key dependent tables in the
    // same transaction.
    let new_id = crate::models::stable_id(new_path);
    let old_id: Option<String> = sqlx::query_scalar("SELECT id FROM media_items WHERE path = ?")
        .bind(old_path)
        .fetch_optional(&mut **tx)
        .await?;
    sqlx::query("UPDATE media_items SET id = ?, path = ?, updated_at = ? WHERE path = ?")
        .bind(&new_id)
        .bind(new_path)
        .bind(now)
        .bind(old_path)
        .execute(&mut **tx)
        .await
        .map_err(|e| {
            format!("Could not update {old_path} to {new_path}; the mapping was rolled back: {e}")
        })?;
    if let Some(old_id) = old_id {
        if old_id != new_id {
            for statement in [
                "UPDATE media_tags SET media_id = ? WHERE media_id = ?",
                "UPDATE album_items SET media_id = ? WHERE media_id = ?",
                "UPDATE edit_recipes SET media_id = ? WHERE media_id = ?",
                "UPDATE edit_backups SET media_id = ? WHERE media_id = ?",
            ] {
                sqlx::query(statement)
                    .bind(&new_id)
                    .bind(&old_id)
                    .execute(&mut **tx)
                    .await?;
            }
            // The journaled original path is the path the file had when it
            // was backed up, so it must track the remap too.
            sqlx::query("UPDATE edit_backups SET original_path = ? WHERE media_id = ?")
                .bind(new_path)
                .bind(&new_id)
                .execute(&mut **tx)
                .await?;
        }
    }

    Ok(())
}

fn mapped_path(old_root: &str, new_root: &str, path: &str) -> Option<String> {
    if path == old_root {
        return Some(new_root.to_string());
    }
    let prefix = format!("{old_root}/");
    path.strip_prefix(&prefix)
        .map(|suffix| format!("{new_root}/{suffix}"))
}

async fn find_affected_paths(
    db: &sqlx::SqlitePool,
    old_root: &str,
) -> Result<Vec<String>, CommandError> {
    let prefix = format!("{old_root}/");
    let rows = sqlx::query(
        "SELECT path FROM media_items WHERE path = ? OR substr(path, 1, ?) = ? ORDER BY path",
    )
    .bind(old_root)
    .bind(prefix.chars().count() as i64)
    .bind(&prefix)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.get::<String, _>("path"))
        .collect())
}

async fn find_conflicts(
    db: &sqlx::SqlitePool,
    old_paths: &[String],
    new_root: &str,
    old_root: &str,
) -> Result<Vec<String>, CommandError> {
    let affected: std::collections::HashSet<&String> = old_paths.iter().collect();
    let mut conflicts = Vec::new();
    for old_path in old_paths {
        let Some(new_path) = mapped_path(old_root, new_root, old_path) else {
            continue;
        };
        let owner: Option<String> =
            sqlx::query_scalar("SELECT path FROM media_items WHERE path = ? LIMIT 1")
                .bind(&new_path)
                .fetch_optional(db)
                .await?;
        // An owner that is itself being moved in this transaction is fine;
        // any other owner would be overwritten.
        if let Some(owner) = owner {
            if !affected.contains(&owner) {
                conflicts.push(new_path);
                if conflicts.len() >= 20 {
                    break;
                }
            }
        }
    }
    Ok(conflicts)
}

/// Native folder picker for a moved source root. The picked folder is the only
/// `new_root` preview and apply will accept for this mapping, and it is granted
/// for the session so scanning it works immediately.
#[tauri::command]
pub async fn choose_root_mapping_folder(
    app: tauri::AppHandle,
    old_root: String,
    catalog: State<'_, crate::Catalog>,
    state: State<'_, crate::AppState>,
) -> Result<Option<String>, CommandError> {
    let old_root = normalize(&old_root)?;
    let db = super::get_db(&catalog)?;
    ensure_registered_root(&db, &old_root).await?;

    let mut dialog = app
        .dialog()
        .file()
        .set_title("Choose the folder that now contains the moved library");
    if let Some(parent) = std::path::Path::new(&old_root).parent() {
        if parent.is_dir() {
            dialog = dialog.set_directory(parent);
        }
    }
    let Some(picked) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| CommandError::new(crate::errors::ErrorCode::Dialog, error.to_string()))?;
    let canonical = path.canonicalize().unwrap_or(path);
    let new_root = super::normalize_root(&canonical.to_string_lossy());

    if new_root.len() <= 1 || new_root == old_root {
        return Err(CommandError::invalid(
            "Choose a different real folder as the new source root.".to_string(),
        ));
    }

    remember_mapping_pick(&old_root, &new_root);
    state.grants.grant([&canonical]);
    Ok(Some(new_root))
}

#[tauri::command]
pub async fn preview_root_path_mapping(
    old_root: String,
    new_root: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<RootPathMappingPreview, CommandError> {
    let (old_root, new_root) = validate_mapping(&old_root, &new_root)?;
    if !mapping_pick_allows(&old_root, &new_root) {
        return Err(CommandError::path(
            "Choose the new source folder with the folder picker before previewing a mapping."
                .to_string(),
        ));
    }
    let db = super::get_db(&catalog)?;
    ensure_registered_root(&db, &old_root).await?;

    let affected = find_affected_paths(&db, &old_root).await?;
    let sample_paths: Vec<String> = affected.iter().take(20).cloned().collect();
    let existing_new_path_count = affected
        .iter()
        .filter_map(|path| mapped_path(&old_root, &new_root, path))
        .filter(|path| std::path::Path::new(path).exists())
        .count() as i64;
    let conflicting_paths = find_conflicts(&db, &affected, &new_root, &old_root).await?;

    Ok(RootPathMappingPreview {
        old_root: old_root.clone(),
        new_root,
        item_count: affected.len() as i64,
        root_count: 1,
        sample_paths,
        conflicting_paths,
        existing_new_path_count,
    })
}

#[tauri::command]
pub async fn apply_root_path_mapping(
    old_root: String,
    new_root: String,
    app: tauri::AppHandle,
    catalog: State<'_, crate::Catalog>,
) -> Result<RootPathMappingResult, CommandError> {
    let (old_root, new_root) = validate_mapping(&old_root, &new_root)?;
    if !mapping_pick_allows(&old_root, &new_root) {
        return Err(CommandError::path(
            "Choose the new source folder with the folder picker before applying a mapping."
                .to_string(),
        ));
    }
    let db = super::get_db(&catalog)?;
    ensure_registered_root(&db, &old_root).await?;
    let affected = find_affected_paths(&db, &old_root).await?;
    let conflicts = find_conflicts(&db, &affected, &new_root, &old_root).await?;
    if !conflicts.is_empty() {
        return Err(CommandError::invalid(format!(
            "The new root already contains catalog paths that conflict with the move (for example {}). No library paths were changed.",
            conflicts.join(", ")
        )));
    }

    let mut tx = db.begin().await?;
    let updated_root = sqlx::query("UPDATE library_folders SET path = ? WHERE path = ?")
        .bind(&new_root)
        .bind(&old_root)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            CommandError::database(format!("Could not update the registered source root: {e}"))
        })?;
    if updated_root.rows_affected() != 1 {
        return Err(CommandError::path(format!(
            "'{old_root}' is not a registered library source. No paths were changed."
        )));
    }

    rekey_moved_paths(&mut tx, &old_root, &new_root, &affected)
        .await
        .map_err(|e| format!("{e}; the mapping was rolled back"))?;

    tx.commit().await.map_err(|e| {
        format!("Could not commit the root mapping; the mapping was rolled back: {e}")
    })?;

    // The catalog now points at the new root, so its originals must load
    // through `asset://` without waiting for a relaunch. Failing to widen the
    // scope after the commit is logged rather than reported as a mapping
    // failure: the paths have already moved.
    if let Err(error) = app.asset_protocol_scope().allow_directory(&new_root, true) {
        tracing::error!("remapped root could not be granted to the asset protocol scope: {error}");
    }
    clear_mapping_pick();

    Ok(RootPathMappingResult {
        old_root,
        new_root,
        updated_item_count: affected.len() as i64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn mapping_db() -> (sqlx::SqlitePool, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("visto-root-map-test-{}.db", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_file(&path);
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE library_folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO library_folders (path, added_at) VALUES ('/old-root', 1)")
            .execute(&db)
            .await
            .unwrap();
        (db, path)
    }

    #[tokio::test]
    async fn remap_rekeys_ids_and_dependent_rows() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        sqlx::query("INSERT INTO library_folders (path, added_at) VALUES ('/old-root', 1)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES ('oldid', '/old-root/a.jpg', 'a.jpg', 'jpg', 'photo', 1, 1, 1, 1)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO tags (id, name, color_index, created_at) VALUES ('t1', 'tag', 0, 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO media_tags (media_id, tag_id) VALUES ('oldid', 't1')")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO albums (id, name, color_index, created_at, updated_at) VALUES ('alb', 'album', 0, 1, 1)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO album_items (album_id, media_id, added_at) VALUES ('alb', 'oldid', 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at) VALUES ('oldid', '{}', NULL, '[]', 0, 1, 1)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO edit_backups (media_id, original_path, backup_path, size, sha256, created_at) VALUES ('oldid', '/old-root/a.jpg', '/tmp/visto-backup/a.jpg', 1, NULL, 1)")
            .execute(&db)
            .await
            .unwrap();

        let mut tx = db.begin().await.unwrap();
        rekey_moved_paths(
            &mut tx,
            "/old-root",
            "/new-root",
            &["/old-root/a.jpg".to_string()],
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let new_id = crate::models::stable_id("/new-root/a.jpg");
        let fetched: String =
            sqlx::query_scalar("SELECT id FROM media_items WHERE path = '/new-root/a.jpg'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(fetched, new_id);
        let tag: String = sqlx::query_scalar("SELECT media_id FROM media_tags")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(tag, new_id);
        let item: String = sqlx::query_scalar("SELECT media_id FROM album_items")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(item, new_id);
        let recipe: String = sqlx::query_scalar("SELECT media_id FROM edit_recipes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(recipe, new_id);
        let bak: String = sqlx::query_scalar("SELECT media_id FROM edit_backups")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(bak, new_id);
        let orig: String = sqlx::query_scalar("SELECT original_path FROM edit_backups")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(orig, "/new-root/a.jpg");
    }

    #[tokio::test]
    async fn mapping_updates_only_paths_under_the_registered_root() {
        let (db, db_path) = mapping_db().await;
        let new_root =
            std::env::temp_dir().join(format!("visto-root-map-target-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&new_root).unwrap();
        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES ('a', '/old-root/a.jpg', 'a.jpg', 'jpg', 'photo', 1, 1, 1, 1), ('b', '/old-root/nested/b.jpg', 'b.jpg', 'jpg', 'photo', 1, 1, 1, 1), ('c', '/other/c.jpg', 'c.jpg', 'jpg', 'photo', 1, 1, 1, 1)")
            .execute(&db)
            .await
            .unwrap();

        let new_root = normalize(new_root.to_str().unwrap()).unwrap();
        let preview = RootPathMappingPreview {
            old_root: "/old-root".to_string(),
            new_root: new_root.clone(),
            item_count: 2,
            root_count: 1,
            sample_paths: vec![],
            conflicting_paths: vec![],
            existing_new_path_count: 0,
        };
        assert_eq!(preview.item_count, 2);
        let affected = find_affected_paths(&db, "/old-root").await.unwrap();
        assert_eq!(affected, vec!["/old-root/a.jpg", "/old-root/nested/b.jpg"]);
        assert_eq!(
            mapped_path("/old-root", &new_root, "/old-root/nested/b.jpg").as_deref(),
            Some(format!("{new_root}/nested/b.jpg").as_str())
        );
        assert!(mapped_path("/old-root", &new_root, "/old-root2/a.jpg").is_none());

        // Exercise the same updates as apply_root_path_mapping, without a Tauri State.
        let now = 123;
        let mut tx = db.begin().await.unwrap();
        sqlx::query("UPDATE library_folders SET path = ? WHERE path = ?")
            .bind(&new_root)
            .bind("/old-root")
            .execute(&mut *tx)
            .await
            .unwrap();
        for old_path in affected {
            let new_path = mapped_path("/old-root", &new_root, &old_path).unwrap();
            sqlx::query("UPDATE media_items SET path = ?, updated_at = ? WHERE path = ?")
                .bind(new_path)
                .bind(now)
                .bind(old_path)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();

        let paths: Vec<String> = sqlx::query_scalar("SELECT path FROM media_items ORDER BY id")
            .fetch_all(&db)
            .await
            .unwrap();
        assert_eq!(paths[0], format!("{new_root}/a.jpg"));
        assert_eq!(paths[1], format!("{new_root}/nested/b.jpg"));
        assert_eq!(paths[2], "/other/c.jpg");
        let root: String = sqlx::query_scalar("SELECT path FROM library_folders")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(root, new_root);

        db.close().await;
        let _ = std::fs::remove_file(db_path);
        let _ = std::fs::remove_dir_all(new_root);
    }

    #[tokio::test]
    async fn mapping_rejects_an_unregistered_old_root() {
        let (db, db_path) = mapping_db().await;
        let error = ensure_registered_root(&db, "/not-registered")
            .await
            .unwrap_err();
        assert!(error.message.contains("not a registered library source"));
        db.close().await;
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn only_the_picked_folder_is_allowed_for_a_mapping() {
        clear_mapping_pick();
        assert!(!mapping_pick_allows("/old-root", "/new-root"));

        remember_mapping_pick("/old-root", "/new-root");
        assert!(mapping_pick_allows("/old-root", "/new-root"));
        assert!(!mapping_pick_allows("/old-root", "/somewhere-else"));
        assert!(!mapping_pick_allows("/another-root", "/new-root"));

        // A newer pick replaces the previous one; the stale path is refused.
        remember_mapping_pick("/old-root", "/newer-root");
        assert!(!mapping_pick_allows("/old-root", "/new-root"));
        assert!(mapping_pick_allows("/old-root", "/newer-root"));

        clear_mapping_pick();
        assert!(!mapping_pick_allows("/old-root", "/new-root"));
    }
}
