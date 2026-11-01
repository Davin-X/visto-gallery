use super::*;
use serde::{Deserialize, Serialize};

/// Request to save (upsert) an edit recipe for a media item.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEditRecipeRequest {
    pub media_id: String,
    pub edits: serde_json::Value,
    pub crop: Option<serde_json::Value>,
    pub history: serde_json::Value,
    pub history_index: i32,
}

/// Request to copy an edit recipe from one media item to another.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyEditRecipeRequest {
    pub from_media_id: String,
    pub to_media_id: String,
}

/// Request to batch-apply edits to multiple media items.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchApplyEditRequest {
    pub media_ids: Vec<String>,
    pub edits: serde_json::Value,
    pub crop: Option<serde_json::Value>,
}

/// Request to save a named edit preset.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEditPresetRequest {
    pub id: Option<String>,
    pub name: String,
    pub edits: serde_json::Value,
    pub crop: Option<serde_json::Value>,
}

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
    req: SaveEditRecipeRequest,
    state: State<'_, AppState>,
) -> Result<EditRecipe, String> {
    let db = super::get_db(&state)?;
    let now = chrono::Utc::now().timestamp_millis();

    let edits_json = serde_json::to_string(&req.edits).map_err(|e| e.to_string())?;
    let crop_json = req
        .crop
        .as_ref()
        .map(|c| serde_json::to_string(c).map_err(|e| e.to_string()))
        .transpose()?;
    let history_json = serde_json::to_string(&req.history).map_err(|e| e.to_string())?;

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
    .bind(&req.media_id)
    .bind(&edits_json)
    .bind(&crop_json)
    .bind(&history_json)
    .bind(req.history_index)
    .bind(now)
    .bind(now)
    .execute(&db)
    .await
    .map_err(|e| e.to_string())?;

    // Return the saved recipe
    get_edit_recipe_inner(&db, &req.media_id)
        .await?
        .ok_or_else(|| format!("Failed to read back saved recipe for {}", req.media_id))
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
    req: CopyEditRecipeRequest,
    state: State<'_, AppState>,
) -> Result<EditRecipe, String> {
    let db = super::get_db(&state)?;
    let now = chrono::Utc::now().timestamp_millis();

    // Read the source recipe
    let source = get_edit_recipe_inner(&db, &req.from_media_id).await?;
    let source = source.ok_or_else(|| format!("No edit recipe found for {}", req.from_media_id))?;

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
    .bind(&req.to_media_id)
    .bind(&edits_json)
    .bind(&crop_json)
    .bind(&history_json)
    .bind(source.history_index)
    .bind(now)
    .bind(now)
    .execute(&db)
    .await
    .map_err(|e| e.to_string())?;

    get_edit_recipe_inner(&db, &req.to_media_id)
        .await?
        .ok_or_else(|| format!("Failed to read back copied recipe for {}", req.to_media_id))
}

/// Batch-apply edits to multiple media items.
#[tauri::command]
pub async fn batch_apply_edit(
    req: BatchApplyEditRequest,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let db = super::get_db(&state)?;
    let now = chrono::Utc::now().timestamp_millis();

    let edits_json = serde_json::to_string(&req.edits).map_err(|e| e.to_string())?;
    let crop_json = req
        .crop
        .as_ref()
        .map(|c| serde_json::to_string(c).map_err(|e| e.to_string()))
        .transpose()?;
    let history_json = serde_json::to_string(&req.edits).map_err(|e| e.to_string())?;

    let mut count = 0usize;
    for media_id in &req.media_ids {
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
    req: SaveEditPresetRequest,
    state: State<'_, AppState>,
) -> Result<EditPreset, String> {
    let db = super::get_db(&state)?;
    let now = chrono::Utc::now().timestamp_millis();
    let id = req.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let edits_json = serde_json::to_string(&req.edits).map_err(|e| e.to_string())?;
    let crop_json = req
        .crop
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
    .bind(&req.name)
    .bind(&edits_json)
    .bind(&crop_json)
    .bind(now)
    .bind(now)
    .execute(&db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(EditPreset {
        id,
        name: req.name,
        edits: req.edits,
        crop: req.crop,
        created_at: now,
        updated_at: now,
    })
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
