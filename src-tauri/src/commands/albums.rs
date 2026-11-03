use crate::{models::*, AppState};
use serde::Serialize;
use sqlx::sqlite::Sqlite;
use sqlx::{QueryBuilder, Row};
use std::collections::HashMap;
use tauri::State;

/// Bounded card data for the Albums overview.
///
/// `item_count` is the full visible membership, while `cover_items` contains at
/// most four poster candidates. Opening an album fetches the complete, paged
/// membership through the normal library query.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumOverview {
    pub id: String,
    pub name: String,
    pub color_index: i32,
    pub created_at: i64,
    pub updated_at: i64,
    pub item_count: i64,
    pub cover_items: Vec<MediaItem>,
}

const ALBUM_COVER_LIMIT: i64 = 4;

#[tauri::command]
pub async fn get_album_overviews(state: State<'_, AppState>) -> Result<Vec<AlbumOverview>, String> {
    let db = super::get_db(&state)?;
    load_album_overviews(&db).await
}

pub(crate) async fn load_album_overviews(
    db: &sqlx::SqlitePool,
) -> Result<Vec<AlbumOverview>, String> {
    let albums = sqlx::query_as::<_, Album>(&format!(
        "{} ORDER BY a.created_at ASC",
        super::ALBUM_SELECT
    ))
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;

    if albums.is_empty() {
        return Ok(Vec::new());
    }

    // Pick at most four photo/video covers per album in one bounded query.
    // Window functions are available in the SQLite version bundled with the
    // app; the result set is capped by album count × 4 rows, never by library
    // size.
    let cover_rows = sqlx::query(
        "SELECT album_id, media_id FROM (
            SELECT ai.album_id, ai.media_id,
                   ROW_NUMBER() OVER (
                       PARTITION BY ai.album_id
                       ORDER BY COALESCE(m.captured_at, m.modified_at) DESC, m.id
                   ) AS rn
            FROM album_items ai
            JOIN media_items m ON m.id = ai.media_id
            WHERE m.hidden = 0 AND m.kind IN ('photo', 'video')
        ) WHERE rn <= ?",
    )
    .bind(ALBUM_COVER_LIMIT)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;

    let mut cover_ids_by_album: HashMap<String, Vec<String>> = HashMap::new();
    for row in cover_rows {
        let album_id: String = row.get("album_id");
        let media_id: String = row.get("media_id");
        cover_ids_by_album
            .entry(album_id)
            .or_default()
            .push(media_id);
    }

    let all_cover_ids: Vec<String> = cover_ids_by_album
        .values()
        .flat_map(|ids| ids.iter().cloned())
        .collect();
    let mut items_by_id: HashMap<String, MediaItem> = HashMap::new();
    if !all_cover_ids.is_empty() {
        let mut qb = QueryBuilder::<Sqlite>::new("SELECT * FROM media_items WHERE id IN (");
        let mut separated = qb.separated(", ");
        for id in &all_cover_ids {
            separated.push_bind(id);
        }
        separated.push_unseparated(")");
        let items = qb
            .build_query_as::<MediaItem>()
            .fetch_all(db)
            .await
            .map_err(|e| e.to_string())?;
        for item in items {
            items_by_id.insert(item.id.clone(), item);
        }
    }

    Ok(albums
        .into_iter()
        .map(|album| {
            let cover_items = cover_ids_by_album
                .remove(&album.id)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|id| items_by_id.remove(&id))
                .collect();
            AlbumOverview {
                id: album.id,
                name: album.name,
                color_index: album.color_index,
                created_at: album.created_at,
                updated_at: album.updated_at,
                item_count: album.item_count,
                cover_items,
            }
        })
        .collect())
}

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
    let items = sqlx::query_as::<_, MediaItem>(
        "SELECT m.id, m.path, m.name, m.extension, m.kind, m.size,
               m.modified_at, m.captured_at, m.width, m.height, m.camera, m.lens,
               m.exposure, m.iso, m.latitude, m.longitude, m.sha256,
               m.favorite, m.hidden, m.import_session_id,
               m.created_at, m.updated_at, m.rating, m.color_label
        FROM media_items m
        JOIN album_items ai ON ai.media_id = m.id
        WHERE ai.album_id = ? AND m.hidden = 0
        ORDER BY m.captured_at ASC",
    )
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
