use super::*;
use crate::errors::CommandError;
use serde::Serialize;
use ts_rs::TS;

/// Response: a single edit recipe.
///
/// `edits`, `crop`, and `history` stay opaque JSON so recipes written by older
/// builds keep loading; the `#[ts(type = ...)]` overrides describe what the
/// editor writes. The applied edit path (`RenderRequest`) is fully typed, so
/// values are validated where they are used rather than when they are stored.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditRecipe {
    pub media_id: String,
    #[ts(type = "EditValues")]
    pub edits: serde_json::Value,
    #[ts(optional, type = "CropState | null")]
    pub crop: Option<serde_json::Value>,
    #[ts(type = "EditValues[]")]
    pub history: serde_json::Value,
    pub history_index: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Response: a named edit preset.
///
/// Like `EditRecipe`, the values are opaque JSON with TypeScript-only shape
/// overrides; see the note there.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditPreset {
    pub id: String,
    pub name: String,
    #[ts(type = "EditValues")]
    pub edits: serde_json::Value,
    #[ts(optional, type = "CropState | null")]
    pub crop: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Save or update an edit recipe for a media item.
#[tauri::command]
pub async fn save_edit_recipe(
    media_id: String,
    edits: serde_json::Value,
    crop: Option<serde_json::Value>,
    history: serde_json::Value,
    history_index: i32,
    catalog: State<'_, crate::Catalog>,
) -> Result<EditRecipe, CommandError> {
    let db = super::get_db(&catalog)?;
    let now = chrono::Utc::now().timestamp_millis();

    let edits_json = serde_json::to_string(&edits)?;
    let crop_json = crop
        .as_ref()
        .map(|c| serde_json::to_string(c).map_err(CommandError::from))
        .transpose()?;
    let history_json = serde_json::to_string(&history)?;

    // Upsert: insert or update existing recipe
    sqlx::query(
        r#"
        INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET
            edits = excluded.edits,
            crop = excluded.crop,
            history = excluded.history,
            history_index = excluded.history_index,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&media_id)
    .bind(&edits_json)
    .bind(&crop_json)
    .bind(&history_json)
    .bind(history_index)
    .bind(now)
    .bind(now)
    .execute(&db)
    .await
    ?;

    // Return the saved recipe
    get_edit_recipe_inner(&db, &media_id).await?.ok_or_else(|| {
        CommandError::database(format!("Failed to read back saved recipe for {}", media_id))
    })
}

/// Get an edit recipe for a media item.
#[tauri::command]
pub async fn get_edit_recipe(
    media_id: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<Option<EditRecipe>, CommandError> {
    let db = super::get_db(&catalog)?;
    get_edit_recipe_inner(&db, &media_id).await
}

/// List all edit recipes.
#[tauri::command]
pub async fn list_edit_recipes(
    catalog: State<'_, crate::Catalog>,
) -> Result<Vec<EditRecipe>, CommandError> {
    let db = super::get_db(&catalog)?;
    let rows = sqlx::query(
        "SELECT media_id, edits, crop, history, history_index, created_at, updated_at FROM edit_recipes ORDER BY updated_at DESC",
    )
    .fetch_all(&db)
    .await
    ?;

    let mut recipes = Vec::new();
    for row in rows {
        recipes.push(row_to_edit_recipe(&row)?);
    }
    Ok(recipes)
}

/// Revert a media item to its original state by restoring the journaled
/// original created during the first in-place edit, then deleting the edit
/// recipe. Legacy `.bak` files from older versions are still supported.
#[tauri::command]
pub async fn revert_edit_recipe(
    media_id: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<bool, CommandError> {
    let db = super::get_db(&catalog)?;
    revert_edit_recipe_inner(&db, &media_id).await
}

async fn revert_edit_recipe_inner(db: &SqlitePool, media_id: &str) -> Result<bool, CommandError> {
    let row = sqlx::query("SELECT path FROM media_items WHERE id = ?")
        .bind(media_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| CommandError::not_found(format!("No media item found for id {media_id}")))?;
    let source_path: String = row.get("path");

    // Prefer the journaled original. Only fall back to the legacy sidecar for
    // items edited before the journal existed.
    let journal =
        sqlx::query("SELECT backup_path, size, sha256 FROM edit_backups WHERE media_id = ?")
            .bind(media_id)
            .fetch_optional(db)
            .await?;

    let (backup_path, expected_size, expected_hash) = if let Some(row) = journal {
        let recorded: String = row.get("backup_path");
        let backup_path = PathBuf::from(&recorded);
        if !backup_path.is_file() {
            return Err(CommandError::internal(format!(
                "The journaled original for {media_id} is missing. Nothing to revert."
            )));
        }
        (
            backup_path,
            Some(row.get::<i64, _>("size")),
            row.get::<Option<String>, _>("sha256"),
        )
    } else {
        let backup_path = Path::new(&source_path).with_extension("bak");
        if !backup_path.is_file() {
            // The file was never replaced in place — only a draft/edit
            // recipe exists. That is not an error: drop the stale recipe
            // so Revert can reset the draft, and report "nothing to revert"
            // via Ok(false) so the UI can discard adjustments instead of
            // showing a failure toast.
            let _ = sqlx::query("DELETE FROM edit_recipes WHERE media_id = ?")
                .bind(media_id)
                .execute(db)
                .await;
            return Ok(false);
        }
        (backup_path, None, None)
    };

    // Verify the backup before overwriting the live file, so a truncated or
    // tampered backup is refused instead of silently becoming the original.
    let verify_path = backup_path.clone();
    let (actual_size, actual_hash) = tokio::task::spawn_blocking(move || {
        let size = std::fs::metadata(&verify_path)
            .map(|meta| meta.len() as i64)
            .map_err(|e| CommandError::io(format!("Could not read the backup: {e}")))?;
        Ok::<_, CommandError>((size, compute_sha256(&verify_path)))
    })
    .await
    .map_err(|e| CommandError::internal(format!("Backup verification failed: {e}")))??;

    if let Some(expected) = expected_size {
        if actual_size != expected {
            return Err(CommandError::invalid(
                "The journaled original is incomplete; refusing to restore it.",
            ));
        }
    }
    if let Some(expected) = expected_hash.as_deref() {
        if actual_hash.as_deref() != Some(expected) {
            return Err(CommandError::invalid(
                "The journaled original does not match its recorded fingerprint; refusing to restore it.",
            ));
        }
    }

    let source = source_path.clone();
    let backup = backup_path.clone();
    let verify_hash = expected_hash.clone();
    tokio::task::spawn_blocking(move || {
        // Copy next to the source, flush, then rename: a failed restore leaves
        // the edited file intact instead of a half-written replacement.
        super::copy_atomically(&backup, Path::new(&source))?;

        // Confirm the bytes that landed on disk match the journal before the
        // backup record is dropped, so a bad copy cannot become the only copy.
        if let Some(expected) = verify_hash.as_deref() {
            let restored = compute_sha256(Path::new(&source));
            if restored.as_deref() != Some(expected) {
                return Err(CommandError::internal(
                    "The restored file does not match the journaled original; the backup was kept.",
                ));
            }
        }
        Ok::<_, CommandError>(())
    })
    .await
    .map_err(|e| CommandError::internal(format!("Restore task failed: {e}")))??;

    // Refresh the catalog row so thumbnails regenerate for the restored bytes.
    if let Ok(meta) = std::fs::metadata(&source_path) {
        let size = meta.len() as i64;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(super::now_ms);
        let _ = sqlx::query(
            "UPDATE media_items SET size = ?, modified_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(size)
        .bind(modified)
        .bind(super::now_ms())
        .bind(media_id)
        .execute(db)
        .await;
    }

    // Delete the journal and recipe first; only then remove the backup file.
    // If the database write fails, the journal still points at an existing
    // file instead of a missing one.
    sqlx::query("DELETE FROM edit_backups WHERE media_id = ?")
        .bind(media_id)
        .execute(db)
        .await?;

    // Delete the edit recipe
    sqlx::query("DELETE FROM edit_recipes WHERE media_id = ?")
        .bind(media_id)
        .execute(db)
        .await?;

    let _ = std::fs::remove_file(&backup_path);

    Ok(true)
}

/// Delete an edit recipe for a media item.
#[tauri::command]
pub async fn delete_edit_recipe(
    media_id: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<bool, CommandError> {
    let db = super::get_db(&catalog)?;
    let result = sqlx::query("DELETE FROM edit_recipes WHERE media_id = ?")
        .bind(&media_id)
        .execute(&db)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Copy an edit recipe from one media item to another.
#[tauri::command]
pub async fn copy_edit_recipe(
    from_media_id: String,
    to_media_id: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<EditRecipe, CommandError> {
    let db = super::get_db(&catalog)?;
    let now = chrono::Utc::now().timestamp_millis();

    // Read the source recipe
    let source = get_edit_recipe_inner(&db, &from_media_id).await?;
    let source = source.ok_or_else(|| {
        CommandError::not_found(format!("No edit recipe found for {}", from_media_id))
    })?;

    // Upsert into destination
    let edits_json = serde_json::to_string(&source.edits)?;
    let crop_json = source
        .crop
        .as_ref()
        .map(|c| serde_json::to_string(c).map_err(CommandError::from))
        .transpose()?;
    let history_json = serde_json::to_string(&source.history)?;

    sqlx::query(
        r#"
        INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET
            edits = excluded.edits,
            crop = excluded.crop,
            history = excluded.history,
            history_index = excluded.history_index,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&to_media_id)
    .bind(&edits_json)
    .bind(&crop_json)
    .bind(&history_json)
    .bind(source.history_index)
    .bind(now)
    .bind(now)
    .execute(&db)
    .await
    ?;

    get_edit_recipe_inner(&db, &to_media_id)
        .await?
        .ok_or_else(|| {
            CommandError::internal(format!(
                "Failed to read back copied recipe for {}",
                to_media_id
            ))
        })
}

/// Batch-apply edits to multiple media items.
#[tauri::command]
pub async fn batch_apply_edit(
    media_ids: Vec<String>,
    edits: serde_json::Value,
    crop: Option<serde_json::Value>,
    catalog: State<'_, crate::Catalog>,
) -> Result<usize, CommandError> {
    let db = super::get_db(&catalog)?;
    let now = chrono::Utc::now().timestamp_millis();

    let edits_json = serde_json::to_string(&edits)?;
    let crop_json = crop
        .as_ref()
        .map(|c| serde_json::to_string(c).map_err(CommandError::from))
        .transpose()?;
    let history_json = serde_json::to_string(&edits)?;

    let mut count = 0usize;
    for media_id in &media_ids {
        sqlx::query(
            r#"
            INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
                edits = excluded.edits,
                crop = excluded.crop,
                history = excluded.history,
                history_index = excluded.history_index,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(media_id)
        .bind(&edits_json)
        .bind(&crop_json)
        .bind(&history_json)
        .bind(0i32)
        .bind(now)
        .bind(now)
        .execute(&db)
        .await
        ?;
        count += 1;
    }
    Ok(count)
}

/// Save a named edit preset.
#[tauri::command]
pub async fn save_edit_preset(
    id: Option<String>,
    name: String,
    edits: serde_json::Value,
    crop: Option<serde_json::Value>,
    catalog: State<'_, crate::Catalog>,
) -> Result<EditPreset, CommandError> {
    let db = super::get_db(&catalog)?;
    let now = chrono::Utc::now().timestamp_millis();
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let edits_json = serde_json::to_string(&edits)?;
    let crop_json = crop
        .as_ref()
        .map(|c| serde_json::to_string(c).map_err(CommandError::from))
        .transpose()?;

    sqlx::query(
        r#"
        INSERT INTO edit_presets (id, name, edits, crop, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            edits = excluded.edits,
            crop = excluded.crop,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&id)
    .bind(&name)
    .bind(&edits_json)
    .bind(&crop_json)
    .bind(now)
    .bind(now)
    .execute(&db)
    .await?;

    Ok(EditPreset {
        id,
        name,
        edits,
        crop,
        created_at: now,
        updated_at: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_db() -> SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
        )
        .execute(&db)
        .await
        .expect("create media_items");

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS edit_recipes (
                media_id TEXT PRIMARY KEY REFERENCES media_items (id) ON DELETE CASCADE,
                edits TEXT NOT NULL,
                crop TEXT,
                history TEXT NOT NULL,
                history_index INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS edit_presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                edits TEXT NOT NULL,
                crop TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS edit_backups (
                media_id TEXT PRIMARY KEY,
                original_path TEXT NOT NULL,
                backup_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                sha256 TEXT,
                created_at INTEGER NOT NULL
            );
            "#,
        )
        .execute(&db)
        .await
        .expect("create edit tables");

        db
    }

    /// `EditRecipe`/`EditPreset` store opaque JSON but advertise `EditValues`
    /// and `CropState` to TypeScript. Keep those overrides honest: the shapes
    /// the editor sends must deserialize into the Rust types.
    #[test]
    fn ts_override_shapes_deserialize() {
        let edits: EditValues = serde_json::from_value(serde_json::json!({
            "exposure": 25,
            "contrast": -10,
            "warmth": 0,
            "shadows": 0,
            "highlights": 0,
            "saturation": 0,
            "rotation": 90,
            "flip": false
        }))
        .expect("EditValues shape");
        assert_eq!(edits.rotation, 90);
        assert!(!edits.flip);

        let numeric: CropState = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "x": 0.1,
            "y": 0.1,
            "width": 0.8,
            "height": 0.8,
            "aspectRatio": 1.5
        }))
        .expect("CropState with a numeric ratio");
        assert_eq!(numeric.aspect_ratio, serde_json::json!(1.5));

        let free: CropState = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "x": 0.0,
            "y": 0.0,
            "width": 1.0,
            "height": 1.0,
            "aspectRatio": "free"
        }))
        .expect("CropState with a free ratio");
        assert_eq!(free.aspect_ratio, serde_json::json!("free"));
    }

    #[tokio::test]
    async fn test_save_and_get_edit_recipe() {
        let db = test_db().await;

        // Insert dummy media item
        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES ('item-1', '/tmp/1.jpg', '1.jpg', 'jpg', 'photo', 100, 1, 1, 1)")
            .execute(&db)
            .await
            .expect("insert media item");

        let edits = serde_json::json!({
            "exposure": 25,
            "contrast": -10,
            "rotation": 90,
            "flip": false
        });
        let history = serde_json::json!([edits]);

        let edits_json = serde_json::to_string(&edits).unwrap();
        let history_json = serde_json::to_string(&history).unwrap();
        let now = 1000i64;

        sqlx::query(
            r#"
            INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind("item-1")
        .bind(&edits_json)
        .bind(None::<String>)
        .bind(&history_json)
        .bind(0i32)
        .bind(now)
        .bind(now)
        .execute(&db)
        .await
        .expect("insert recipe");

        let fetched = get_edit_recipe_inner(&db, "item-1").await;
        assert!(
            fetched.is_ok(),
            "get_edit_recipe_inner failed: {:?}",
            fetched.err()
        );
        let recipe = fetched.unwrap().expect("recipe should exist");
        assert_eq!(recipe.media_id, "item-1");
        assert_eq!(recipe.edits["exposure"], 25);
    }

    #[tokio::test]
    async fn test_upsert_and_delete_recipe() {
        let db = test_db().await;

        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES ('item-2', '/tmp/2.jpg', '2.jpg', 'jpg', 'photo', 100, 1, 1, 1)")
            .execute(&db)
            .await
            .expect("insert media item");

        let edits1 = serde_json::json!({ "exposure": 10 });
        let edits2 = serde_json::json!({ "exposure": 50, "warmth": 20 });
        let crop =
            serde_json::json!({ "enabled": true, "x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8 });

        // Save v1
        let edits1_json = serde_json::to_string(&edits1).unwrap();
        let history1_json = serde_json::to_string(&serde_json::json!([edits1])).unwrap();
        sqlx::query(
            r#"
            INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
                edits = excluded.edits, crop = excluded.crop, history = excluded.history,
                history_index = excluded.history_index, updated_at = excluded.updated_at
            "#,
        )
        .bind("item-2")
        .bind(&edits1_json)
        .bind(None::<String>)
        .bind(&history1_json)
        .bind(0i32)
        .bind(100i64)
        .bind(100i64)
        .execute(&db)
        .await
        .unwrap();

        // Update to v2
        let edits2_json = serde_json::to_string(&edits2).unwrap();
        let crop_json = serde_json::to_string(&crop).unwrap();
        let history2_json = serde_json::to_string(&serde_json::json!([edits1, edits2])).unwrap();
        sqlx::query(
            r#"
            INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
                edits = excluded.edits, crop = excluded.crop, history = excluded.history,
                history_index = excluded.history_index, updated_at = excluded.updated_at
            "#,
        )
        .bind("item-2")
        .bind(&edits2_json)
        .bind(Some(&crop_json))
        .bind(&history2_json)
        .bind(1i32)
        .bind(100i64)
        .bind(200i64)
        .execute(&db)
        .await
        .unwrap();

        let updated = get_edit_recipe_inner(&db, "item-2").await.unwrap().unwrap();
        assert_eq!(updated.edits["exposure"], 50);
        assert_eq!(updated.edits["warmth"], 20);
        assert_eq!(updated.history_index, 1);
        assert!(updated.crop.is_some());

        // Delete
        sqlx::query("DELETE FROM edit_recipes WHERE media_id = ?")
            .bind("item-2")
            .execute(&db)
            .await
            .unwrap();

        let after_delete = get_edit_recipe_inner(&db, "item-2").await.unwrap();
        assert!(after_delete.is_none());
    }

    #[tokio::test]
    async fn test_copy_recipe_and_presets() {
        let db = test_db().await;

        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES ('src-1', '/tmp/s.jpg', 's.jpg', 'jpg', 'photo', 100, 1, 1, 1), ('dst-1', '/tmp/d.jpg', 'd.jpg', 'jpg', 'photo', 100, 1, 1, 1)")
            .execute(&db)
            .await
            .expect("insert items");

        let edits = serde_json::json!({ "saturation": 30, "contrast": 15 });
        let edits_json = serde_json::to_string(&edits).unwrap();
        let history_json = serde_json::to_string(&serde_json::json!([edits])).unwrap();

        sqlx::query(
            "INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("src-1")
        .bind(&edits_json)
        .bind(None::<String>)
        .bind(&history_json)
        .bind(0i32)
        .bind(100i64)
        .bind(100i64)
        .execute(&db)
        .await
        .unwrap();

        // Copy from src-1 to dst-1
        let src = get_edit_recipe_inner(&db, "src-1").await.unwrap().unwrap();
        sqlx::query(
            r#"
            INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
                edits = excluded.edits, crop = excluded.crop, history = excluded.history,
                history_index = excluded.history_index, updated_at = excluded.updated_at
            "#,
        )
        .bind("dst-1")
        .bind(serde_json::to_string(&src.edits).unwrap())
        .bind(None::<String>)
        .bind(serde_json::to_string(&src.history).unwrap())
        .bind(src.history_index)
        .bind(200i64)
        .bind(200i64)
        .execute(&db)
        .await
        .unwrap();

        let dst = get_edit_recipe_inner(&db, "dst-1").await.unwrap().unwrap();
        assert_eq!(dst.media_id, "dst-1");
        assert_eq!(dst.edits["saturation"], 30);
        assert_eq!(dst.edits["contrast"], 15);
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("visto-revert-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    async fn insert_media(db: &SqlitePool, id: &str, path: &Path) {
        sqlx::query(
            "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES (?, ?, 'photo.jpg', 'jpg', 'photo', 1, 1, 1, 1)",
        )
        .bind(id)
        .bind(path.to_string_lossy().into_owned())
        .execute(db)
        .await
        .expect("insert media item");
    }

    async fn insert_journal(db: &SqlitePool, id: &str, source: &Path, backup: &Path) {
        let size = std::fs::metadata(backup).expect("backup metadata").len() as i64;
        let hash = super::compute_sha256(backup);
        sqlx::query(
            "INSERT INTO edit_backups (media_id, original_path, backup_path, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, 1)",
        )
        .bind(id)
        .bind(source.to_string_lossy().into_owned())
        .bind(backup.to_string_lossy().into_owned())
        .bind(size)
        .bind(hash)
        .execute(db)
        .await
        .expect("insert journal");
    }

    #[tokio::test]
    async fn test_revert_restores_journaled_original_and_cleans_up() {
        let db = test_db().await;
        let dir = temp_dir("journal");
        let source = dir.join("photo.jpg");
        let backup = dir.join("originals").join("item-1.jpg");
        std::fs::create_dir_all(backup.parent().unwrap()).unwrap();
        std::fs::write(&source, b"edited-bytes").unwrap();
        std::fs::write(&backup, b"original-bytes").unwrap();

        insert_media(&db, "item-1", &source).await;
        insert_journal(&db, "item-1", &source, &backup).await;
        sqlx::query(
            "INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at) VALUES ('item-1', '{}', NULL, '[]', 0, 1, 1)",
        )
        .execute(&db)
        .await
        .unwrap();

        assert!(revert_edit_recipe_inner(&db, "item-1").await.unwrap());
        assert_eq!(std::fs::read(&source).unwrap(), b"original-bytes");
        assert!(!backup.exists());
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "the atomic restore must not leave temp files behind: {leftovers:?}"
        );
        let journals: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM edit_backups WHERE media_id = 'item-1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(journals, 0);
        let recipes: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM edit_recipes WHERE media_id = 'item-1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(recipes, 0);
    }

    #[tokio::test]
    async fn test_revert_refuses_a_wrong_size_backup() {
        let db = test_db().await;
        let dir = temp_dir("wrong-size");
        let source = dir.join("photo.jpg");
        let backup = dir.join("originals").join("item-2.jpg");
        std::fs::create_dir_all(backup.parent().unwrap()).unwrap();
        std::fs::write(&source, b"edited-bytes").unwrap();
        std::fs::write(&backup, b"original-bytes").unwrap();

        insert_media(&db, "item-2", &source).await;
        sqlx::query(
            "INSERT INTO edit_backups (media_id, original_path, backup_path, size, sha256, created_at) VALUES ('item-2', ?, ?, 999, NULL, 1)",
        )
        .bind(source.to_string_lossy().into_owned())
        .bind(backup.to_string_lossy().into_owned())
        .execute(&db)
        .await
        .unwrap();

        let error = revert_edit_recipe_inner(&db, "item-2")
            .await
            .expect_err("wrong-size backup should be refused");
        assert!(error.message.contains("incomplete"));
        assert_eq!(std::fs::read(&source).unwrap(), b"edited-bytes");
    }

    #[tokio::test]
    async fn test_revert_refuses_a_wrong_hash_backup() {
        let db = test_db().await;
        let dir = temp_dir("wrong-hash");
        let source = dir.join("photo.jpg");
        let backup = dir.join("originals").join("item-3.jpg");
        std::fs::create_dir_all(backup.parent().unwrap()).unwrap();
        std::fs::write(&source, b"edited-bytes").unwrap();
        std::fs::write(&backup, b"original-bytes").unwrap();

        insert_media(&db, "item-3", &source).await;
        sqlx::query(
            "INSERT INTO edit_backups (media_id, original_path, backup_path, size, sha256, created_at) VALUES ('item-3', ?, ?, ?, 'deadbeef', 1)",
        )
        .bind(source.to_string_lossy().into_owned())
        .bind(backup.to_string_lossy().into_owned())
        .bind(14i64)
        .execute(&db)
        .await
        .unwrap();

        let error = revert_edit_recipe_inner(&db, "item-3")
            .await
            .expect_err("wrong-hash backup should be refused");
        assert!(error.message.contains("fingerprint"));
        assert_eq!(std::fs::read(&source).unwrap(), b"edited-bytes");
    }

    #[tokio::test]
    async fn test_revert_uses_legacy_bak_when_no_journal_exists() {
        let db = test_db().await;
        let dir = temp_dir("legacy");
        let source = dir.join("photo.jpg");
        let backup = dir.join("photo.bak");
        std::fs::write(&source, b"edited-bytes").unwrap();
        std::fs::write(&backup, b"original-bytes").unwrap();

        insert_media(&db, "item-4", &source).await;

        assert!(revert_edit_recipe_inner(&db, "item-4").await.unwrap());
        assert_eq!(std::fs::read(&source).unwrap(), b"original-bytes");
        assert!(!backup.exists());
    }

    #[tokio::test]
    async fn test_revert_with_no_backup_returns_false_and_clears_recipe() {
        let db = test_db().await;
        let dir = temp_dir("no-backup");
        let source = dir.join("photo.jpg");
        std::fs::write(&source, b"original-bytes").unwrap();

        insert_media(&db, "item-5", &source).await;
        sqlx::query(
            "INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at) VALUES ('item-5', '{}', NULL, '[]', 0, 1, 1)",
        )
        .execute(&db)
        .await
        .unwrap();

        assert!(!revert_edit_recipe_inner(&db, "item-5").await.unwrap());
        assert_eq!(std::fs::read(&source).unwrap(), b"original-bytes");
        let recipes: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM edit_recipes WHERE media_id = 'item-5'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(recipes, 0);
    }

    #[tokio::test]
    async fn test_failed_revert_keeps_the_edited_file_and_the_journal() {
        let db = test_db().await;
        let dir = temp_dir("restore-fails");
        // The catalog says this path is a file, but a directory now sits
        // there, so the final rename cannot replace it.
        let source = dir.join("photo.jpg");
        std::fs::create_dir(&source).expect("create blocking directory");
        let backup = dir.join("originals").join("item-6.jpg");
        std::fs::create_dir_all(backup.parent().unwrap()).unwrap();
        std::fs::write(&backup, b"original-bytes").unwrap();

        insert_media(&db, "item-6", &source).await;
        insert_journal(&db, "item-6", &source, &backup).await;

        let error = revert_edit_recipe_inner(&db, "item-6")
            .await
            .expect_err("a restore that cannot replace the target must fail");
        assert!(
            error.message.contains("Could not finish writing"),
            "unexpected error: {}",
            error.message
        );

        assert!(backup.exists(), "the journaled original must be kept");
        let journals: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM edit_backups WHERE media_id = 'item-6'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(journals, 1, "the journal must survive a failed restore");
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "a failed restore must not leave temp files behind: {leftovers:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}

/// List all edit presets.
#[tauri::command]
pub async fn list_edit_presets(
    catalog: State<'_, crate::Catalog>,
) -> Result<Vec<EditPreset>, CommandError> {
    let db = super::get_db(&catalog)?;
    let rows = sqlx::query(
        "SELECT id, name, edits, crop, created_at, updated_at FROM edit_presets ORDER BY name ASC",
    )
    .fetch_all(&db)
    .await?;

    let mut presets = Vec::new();
    for row in rows {
        presets.push(row_to_edit_preset(&row)?);
    }
    Ok(presets)
}

/// Delete an edit preset.
#[tauri::command]
pub async fn delete_edit_preset(
    id: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<bool, CommandError> {
    let db = super::get_db(&catalog)?;
    let result = sqlx::query("DELETE FROM edit_presets WHERE id = ?")
        .bind(&id)
        .execute(&db)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Apply a named preset to a media item (creates/overwrites its edit recipe).
#[tauri::command]
pub async fn apply_edit_preset(
    preset_id: String,
    media_id: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<EditRecipe, CommandError> {
    let db = super::get_db(&catalog)?;
    let now = chrono::Utc::now().timestamp_millis();

    // Read the preset
    let preset_row = sqlx::query("SELECT edits, crop FROM edit_presets WHERE id = ?")
        .bind(&preset_id)
        .fetch_optional(&db)
        .await?
        .ok_or_else(|| {
            CommandError::not_found(format!("No edit preset found with id {}", preset_id))
        })?;

    let edits: serde_json::Value = preset_row.get("edits");
    let crop: Option<serde_json::Value> = preset_row.get("crop");

    let edits_json = serde_json::to_string(&edits)?;
    let crop_json = crop
        .map(|c| serde_json::to_string(&c).map_err(CommandError::from))
        .transpose()?;
    let history_json = serde_json::to_string(&edits)?;

    sqlx::query(
        r#"
        INSERT INTO edit_recipes (media_id, edits, crop, history, history_index, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET
            edits = excluded.edits,
            crop = excluded.crop,
            history = excluded.history,
            history_index = excluded.history_index,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(&media_id)
    .bind(&edits_json)
    .bind(&crop_json)
    .bind(&history_json)
    .bind(0i32)
    .bind(now)
    .bind(now)
    .execute(&db)
    .await
    ?;

    get_edit_recipe_inner(&db, &media_id).await?.ok_or_else(|| {
        CommandError::internal(format!(
            "Failed to read back applied recipe for {}",
            media_id
        ))
    })
}

// ---- Internal helpers ----

async fn get_edit_recipe_inner(
    db: &SqlitePool,
    media_id: &str,
) -> Result<Option<EditRecipe>, CommandError> {
    let row = sqlx::query(
        "SELECT media_id, edits, crop, history, history_index, created_at, updated_at FROM edit_recipes WHERE media_id = ?",
    )
    .bind(media_id)
    .fetch_optional(db)
    .await
    ?;

    match row {
        Some(r) => Ok(Some(row_to_edit_recipe(&r)?)),
        None => Ok(None),
    }
}

fn row_to_edit_recipe(row: &sqlx::sqlite::SqliteRow) -> Result<EditRecipe, CommandError> {
    let media_id: String = row.get("media_id");
    let edits: serde_json::Value = row.get("edits");
    let crop: Option<serde_json::Value> = row.get("crop");
    let history: serde_json::Value = row.get("history");
    let history_index: i32 = row.get("history_index");
    let created_at: i64 = row.get("created_at");
    let updated_at: i64 = row.get("updated_at");

    Ok(EditRecipe {
        media_id,
        edits,
        crop,
        history,
        history_index,
        created_at,
        updated_at,
    })
}

fn row_to_edit_preset(row: &sqlx::sqlite::SqliteRow) -> Result<EditPreset, CommandError> {
    let id: String = row.get("id");
    let name: String = row.get("name");
    let edits: serde_json::Value = row.get("edits");
    let crop: Option<serde_json::Value> = row.get("crop");
    let created_at: i64 = row.get("created_at");
    let updated_at: i64 = row.get("updated_at");

    Ok(EditPreset {
        id,
        name,
        edits,
        crop,
        created_at,
        updated_at,
    })
}

/// Vacuum the SQLite library catalog to reclaim disk space and defragment.
/// Runs `VACUUM` on the catalog database. Original media files are never touched.
#[tauri::command]
pub async fn vacuum_catalog(catalog: State<'_, crate::Catalog>) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    sqlx::query("VACUUM")
        .execute(&db)
        .await
        .map_err(|e| CommandError::internal(format!("VACUUM failed: {}", e)))?;
    Ok(())
}
