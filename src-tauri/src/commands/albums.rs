use crate::{models::*, AppState};
use sqlx::sqlite::Sqlite;
use sqlx::QueryBuilder;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub async fn get_albums(state: State<'_, AppState>) -> Result<Vec<Album>, String> {
    let db = super::get_db(&state)?;
    let mut albums = sqlx::query_as::<_, Album>(&format!(
        "{} ORDER BY a.created_at ASC",
        super::ALBUM_SELECT
    ))
    .fetch_all(&db)
    .await
    .map_err(|e| e.to_string())?;

    // Hydrate item_ids per album from album_items join table.
    let album_ids: Vec<String> = albums.iter().map(|a| a.id.clone()).collect();
    if !album_ids.is_empty() {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "SELECT album_id, media_id FROM album_items WHERE album_id IN (",
        );
        let mut separated = qb.separated(", ");
        for id in &album_ids {
            separated.push_bind(id);
        }
        separated.push_unseparated(")");
        let rows = qb
            .build_query_as::<(String, String)>()
            .fetch_all(&db)
            .await
            .map_err(|e| e.to_string())?;
        let mut by_album: HashMap<String, Vec<String>> = HashMap::new();
        for (album_id, media_id) in rows {
            by_album.entry(album_id).or_default().push(media_id);
        }
        for album in &mut albums {
            album.item_ids = by_album.remove(&album.id).unwrap_or_default();
        }
    }

    Ok(albums)
}

#[tauri::command]
pub async fn create_album(
    name: String,
    color_index: Option<i32>,
    state: State<'_, AppState>,
) -> Result<Album, String> {
    let db = super::get_db(&state)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Album name cannot be empty".to_string());
    }
    let album = Album::new(name, color_index.unwrap_or(0));
    sqlx::query(
        "INSERT INTO albums (id, name, color_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&album.id)
    .bind(&album.name)
    .bind(album.color_index)
    .bind(album.created_at)
    .bind(album.updated_at)
    .execute(&db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(album)
}

#[tauri::command]
pub async fn delete_album(album_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = super::get_db(&state)?;
    sqlx::query("DELETE FROM albums WHERE id = ?")
        .bind(&album_id)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn rename_album(
    album_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = super::get_db(&state)?;
    sqlx::query("UPDATE albums SET name = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(super::now_ms())
        .bind(&album_id)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_album_items(
    album_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<MediaItem>, String> {
    let db = super::get_db(&state)?;
    let items = sqlx::query_as::<_, MediaItem>(&format!(
        "{} WHERE m.id IN (SELECT media_id FROM album_items WHERE album_id = ?) ORDER BY m.captured_at ASC",
        super::ALBUM_SELECT
    ))
    .bind(&album_id)
    .fetch_all(&db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(items)
}

#[tauri::command]
pub async fn add_to_album(
    album_id: String,
    item_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = super::get_db(&state)?;
    for item_id in &item_ids {
        sqlx::query(
            "INSERT OR IGNORE INTO album_items (album_id, media_id, added_at) VALUES (?, ?, ?)",
        )
        .bind(&album_id)
        .bind(item_id)
        .bind(super::now_ms())
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_from_album(
    album_id: String,
    item_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = super::get_db(&state)?;
    for item_id in &item_ids {
        sqlx::query("DELETE FROM album_items WHERE album_id = ? AND media_id = ?")
            .bind(&album_id)
            .bind(item_id)
            .execute(&db)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
