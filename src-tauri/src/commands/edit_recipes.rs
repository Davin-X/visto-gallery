use super::*;
use serde::Serialize;

/// Response: a single edit recipe.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRecipe {
    pub media_id: String,
    pub edits: serde_json::Value,
    pub crop: Option<serde_json::Value>,
    pub history: serde_json::Value,
    pub history_index: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Response: a named edit preset.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPreset {
    pub id: String,
    pub name: String,
    pub edits: serde_json::Value,
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
    state: State<'_, AppState>,
) -> Result<EditRecipe, String> {
    let db = super::get_db(&state)?;
    let now = chrono::Utc::now().timestamp_millis();

    let edits_json = serde_json::to_string(&edits).map_err(|e| e.to_string())?;
    let crop_json = crop
        .as_ref()
        .map(|c| serde_json::to_string(c).map_err(|e| e.to_string()))
        .transpose()?;
    let history_json = serde_json::to_string(&history).map_err(|e| e.to_string())?;

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
    .map_err(|e| e.to_string())?;

    // Return the saved recipe
    get_edit_recipe_inner(&db, &media_id)
        .await?
        .ok_or_else(|| format!("Failed to read back saved recipe for {}", media_id))
}

/// Get an edit recipe for a media item.
#[tauri::command]
pub async fn get_edit_recipe(
    media_id: String,
    state: State<'_, AppState>,
) -> Result<Option<EditRecipe>, String> {
    let db = super::get_db(&state)?;
    get_edit_recipe_inner(&db, &media_id).await
}

/// List all edit recipes.
#[tauri::command]
pub async fn list_edit_recipes(state: State<'_, AppState>) -> Result<Vec<EditRecipe>, String> {
    let db = super::get_db(&state)?;
    let rows = sqlx::query(
        "SELECT media_id, edits, crop, history, history_index, created_at, updated_at FROM edit_recipes ORDER BY updated_at DESC",
    )
    .fetch_all(&db)
    .await
    .map_err(|e| e.to_string())?;

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
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = super::get_db(&state)?;
    revert_edit_recipe_inner(&db, &media_id).await
}

async fn revert_edit_recipe_inner(db: &SqlitePool, media_id: &str) -> Result<bool, String> {
    let row = sqlx::query("SELECT path FROM media_items WHERE id = ?")
        .bind(media_id)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("No media item found for id {media_id}"))?;
    let source_path: String = row.get("path");

    // Prefer the journaled original. Only fall back to the legacy sidecar for
    // items edited before the journal existed.
    let journal =
        sqlx::query("SELECT backup_path, size, sha256 FROM edit_backups WHERE media_id = ?")
            .bind(media_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;

    let (backup_path, expected_size, expected_hash) = if let Some(row) = journal {
        let recorded: String = row.get("backup_path");
        let backup_path = PathBuf::from(&recorded);
        if !backup_path.is_file() {
            return Err(format!(
                "The journaled original for {media_id} is missing. Nothing to revert."
            ));
        }
        (
            backup_path,
            Some(row.get::<i64, _>("size")),
            row.get::<Option<String>, _>("sha256"),
        )
    } else {
        let backup_path = Path::new(&source_path).with_extension("bak");
        if !backup_path.is_file() {
            return Err(format!(
                "No backup found for {}. Nothing to revert.",
                media_id
            ));
        }
        (backup_path, None, None)
    };

    // Verify the backup before overwriting the live file, so a truncated or
    // tampered backup is refused instead of silently becoming the original.
    let verify_path = backup_path.clone();
    let (actual_size, actual_hash) = tokio::task::spawn_blocking(move || {
        let size = std::fs::metadata(&verify_path)
            .map(|meta| meta.len() as i64)
            .map_err(|e| format!("Could not read the backup: {e}"))?;
        Ok::<_, String>((size, compute_sha256(&verify_path)))
    })
    .await
    .map_err(|e| format!("Backup verification failed: {e}"))??;

    if let Some(expected) = expected_size {
        if actual_size != expected {
            return Err(
                "The journaled original is incomplete; refusing to restore it.".to_string(),
            );
        }
    }
    if let Some(expected) = expected_hash.as_deref() {
        if actual_hash.as_deref() != Some(expected) {
            return Err(
                "The journaled original does not match its recorded fingerprint; refusing to restore it."
                    .to_string(),
            );
        }
    }

    let source = source_path.clone();
    let backup = backup_path.clone();
    tokio::task::spawn_blocking(move || std::fs::copy(&backup, &source))
        .await
        .map_err(|e| format!("Restore task failed: {e}"))?
        .map_err(|e| format!("Failed to restore backup: {}", e))?;

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
        .await
        .map_err(|e| e.to_string())?;

    // Delete the edit recipe
    sqlx::query("DELETE FROM edit_recipes WHERE media_id = ?")
        .bind(media_id)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;

    let _ = std::fs::remove_file(&backup_path);

    Ok(true)
}

/// Delete an edit recipe for a media item.
#[tauri::command]
pub async fn delete_edit_recipe(
    media_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let db = super::get_db(&state)?;
    let result = sqlx::query("DELETE FROM edit_recipes WHERE media_id = ?")
        .bind(&media_id)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(result.rows_affected() > 0)
}

/// Copy an edit recipe from one media item to another.
#[tauri::command]
pub async fn copy_edit_recipe(
    from_media_id: String,
    to_media_id: String,
    state: State<'_, AppState>,
) -> Result<EditRecipe, String> {
    let db = super::get_db(&state)?;
    let now = chrono::Utc::now().timestamp_millis();

    // Read the source recipe
    let source = get_edit_recipe_inner(&db, &from_media_id).await?;
    let source = source.ok_or_else(|| format!("No edit recipe found for {}", from_media_id))?;

    // Upsert into destination
    let edits_json = serde_json::to_string(&source.edits).map_err(|e| e.to_string())?;
    let crop_json = source
        .crop
        .as_ref()
        .map(|c| serde_json::to_string(c).map_err(|e| e.to_string()))
        .transpose()?;
    let history_json = serde_json::to_string(&source.history).map_err(|e| e.to_string())?;

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
    .map_err(|e| e.to_string())?;

    get_edit_recipe_inner(&db, &to_media_id)
        .await?
        .ok_or_else(|| format!("Failed to read back copied recipe for {}", to_media_id))
}

/// Batch-apply edits to multiple media items.
#[tauri::command]
pub async fn batch_apply_edit(
    media_ids: Vec<String>,
    edits: serde_json::Value,
    crop: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let db = super::get_db(&state)?;
    let now = chrono::Utc::now().timestamp_millis();

    let edits_json = serde_json::to_string(&edits).map_err(|e| e.to_string())?;
    let crop_json = crop
        .as_ref()
        .map(|c| serde_json::to_string(c).map_err(|e| e.to_string()))
        .transpose()?;
    let history_json = serde_json::to_string(&edits).map_err(|e| e.to_string())?;

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
        .map_err(|e| e.to_string())?;
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
    state: State<'_, AppState>,
) -> Result<EditPreset, String> {
    let db = super::get_db(&state)?;
    let now = chrono::Utc::now().timestamp_millis();
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let edits_json = serde_json::to_string(&edits).map_err(|e| e.to_string())?;
    let crop_json = crop
        .as_ref()
        .map(|c| serde_json::to_string(c).map_err(|e| e.to_string()))
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
    .await
    .map_err(|e| e.to_string())?;

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
        assert!(error.contains("incomplete"));
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
        assert!(error.contains("fingerprint"));
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
}

/// List all edit presets.
#[tauri::command]
pub async fn list_edit_presets(state: State<'_, AppState>) -> Result<Vec<EditPreset>, String> {
    let db = super::get_db(&state)?;
    let rows = sqlx::query(
        "SELECT id, name, edits, crop, created_at, updated_at FROM edit_presets ORDER BY name ASC",
    )
    .fetch_all(&db)
    .await
    .map_err(|e| e.to_string())?;

    let mut presets = Vec::new();
    for row in rows {
        presets.push(row_to_edit_preset(&row)?);
    }
    Ok(presets)
}

/// Delete an edit preset.
#[tauri::command]
pub async fn delete_edit_preset(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let db = super::get_db(&state)?;
    let result = sqlx::query("DELETE FROM edit_presets WHERE id = ?")
        .bind(&id)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(result.rows_affected() > 0)
}

/// Apply a named preset to a media item (creates/overwrites its edit recipe).
#[tauri::command]
pub async fn apply_edit_preset(
    preset_id: String,
    media_id: String,
    state: State<'_, AppState>,
) -> Result<EditRecipe, String> {
    let db = super::get_db(&state)?;
    let now = chrono::Utc::now().timestamp_millis();

    // Read the preset
    let preset_row = sqlx::query("SELECT edits, crop FROM edit_presets WHERE id = ?")
        .bind(&preset_id)
        .fetch_optional(&db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("No edit preset found with id {}", preset_id))?;

    let edits: serde_json::Value = preset_row.get("edits");
    let crop: Option<serde_json::Value> = preset_row.get("crop");

    let edits_json = serde_json::to_string(&edits).map_err(|e| e.to_string())?;
    let crop_json = crop
        .map(|c| serde_json::to_string(&c).map_err(|e| e.to_string()))
        .transpose()?;
    let history_json = serde_json::to_string(&edits).map_err(|e| e.to_string())?;

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
    .map_err(|e| e.to_string())?;

    get_edit_recipe_inner(&db, &media_id)
        .await?
        .ok_or_else(|| format!("Failed to read back applied recipe for {}", media_id))
}

// ---- Internal helpers ----

async fn get_edit_recipe_inner(
    db: &SqlitePool,
    media_id: &str,
) -> Result<Option<EditRecipe>, String> {
    let row = sqlx::query(
        "SELECT media_id, edits, crop, history, history_index, created_at, updated_at FROM edit_recipes WHERE media_id = ?",
    )
    .bind(media_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;

    match row {
        Some(r) => Ok(Some(row_to_edit_recipe(&r)?)),
        None => Ok(None),
    }
}

fn row_to_edit_recipe(row: &sqlx::sqlite::SqliteRow) -> Result<EditRecipe, String> {
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

fn row_to_edit_preset(row: &sqlx::sqlite::SqliteRow) -> Result<EditPreset, String> {
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
pub async fn vacuum_catalog(state: State<'_, AppState>) -> Result<(), String> {
    let db = super::get_db(&state)?;
    sqlx::query("VACUUM")
        .execute(&db)
        .await
        .map_err(|e| format!("VACUUM failed: {}", e))?;
    Ok(())
}
