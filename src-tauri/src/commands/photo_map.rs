use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;
use ts_rs::TS;

use crate::{errors::CommandError, Catalog};

#[derive(Serialize, sqlx::FromRow, TS)]
#[serde(rename_all = "camelCase")]
pub struct PhotoLocation {
    id: String,
    name: String,
    latitude: f64,
    longitude: f64,
    captured_at: Option<i64>,
    modified_at: i64,
}

async fn photo_locations(db: &SqlitePool) -> Result<Vec<PhotoLocation>, CommandError> {
    Ok(sqlx::query_as(
        "SELECT id, name, latitude, longitude, captured_at, modified_at FROM media_items
         WHERE hidden = 0 AND kind IN ('photo', 'raw')
           AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
           -- 0,0 is what broken GPS writers store for no fix.
           AND NOT (latitude = 0 AND longitude = 0)
         ORDER BY COALESCE(captured_at, modified_at) DESC, id",
    )
    .fetch_all(db)
    .await?)
}

#[tauri::command]
pub async fn get_photo_locations(
    catalog: State<'_, Catalog>,
) -> Result<Vec<PhotoLocation>, CommandError> {
    photo_locations(&super::get_db(&catalog)?).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn maps_visible_photos_with_valid_coordinates() {
        let db = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE media_items (
                id TEXT, name TEXT, kind TEXT, hidden INTEGER, latitude REAL, longitude REAL,
                captured_at INTEGER, modified_at INTEGER
            )",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO media_items VALUES
                ('zero', 'Zero.jpg', 'photo', 0, 0, 0, NULL, 1),
                ('raw', 'Raw.dng', 'raw', 0, -10, 145, 2, 0),
                ('hidden', 'Private.jpg', 'photo', 1, 30, 10, 3, 3),
                ('video', 'Video.mp4', 'video', 0, 30, 10, 3, 3),
                ('null', 'No fix.jpg', 'photo', 0, 30, NULL, 3, 3),
                ('bad', 'Bad fix.jpg', 'photo', 0, 91, 10, 3, 3)",
        )
        .execute(&db)
        .await
        .unwrap();
        let locations = photo_locations(&db).await.unwrap();
        let ids: Vec<_> = locations.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["raw"]);
    }
}
