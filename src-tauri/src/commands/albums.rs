use crate::{AppState, models::*};
use tauri::State;

#[tauri::command]
pub async fn get_albums(state: State<'_, AppState>) -> Result<Vec<Album>, String> {
    let db = super::get_db(&state)?;
    let albums = sqlx::query_as::<_, Album>(&format!("{} ORDER BY a.created_at ASC", super::ALBUM_SELECT))
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(albums)
}


#[tauri::command]
pub async fn create_album(name: String, color_index: Option<i32>, state: State<'_, AppState>) -> Result<Album, String> {
    let db = super::get_db(&state)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Album name cannot be empty".to_string());
    }
    let album = Album::new(name, color_index.unwrap_or(0));
    sqlx::query("INSERT INTO albums (id, name, color_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
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
pub async fn rename_album(album_id: String, name: String, state: State<'_, AppState>) -> Result<(), String> {
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
pub async fn add_to_album(album_id: String, item_ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let db = super::get_db(&state)?;
    for item_id in &item_ids {
        sqlx::query("INSERT OR IGNORE INTO album_items (album_id, media_id, added_at) VALUES (?, ?, ?)")
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
pub async fn remove_from_album(album_id: String, item_ids: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
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
