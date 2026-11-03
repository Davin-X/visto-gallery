use super::LibraryFilterDTO;
use crate::AppState;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;
use uuid::Uuid;

/// The only fields a saved Smart Album may contain.
///
/// `deny_unknown_fields` is deliberate: a definition imported from a future or
/// corrupted build fails visibly instead of being silently ignored. The
/// resulting SQL always binds these values; no part of a definition is ever
/// interpolated into a statement.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmartAlbumFilter {
    pub kind: Option<String>,
    pub favorite: Option<bool>,
    pub query: Option<String>,
    pub tags: Option<Vec<String>>,
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    pub source_path: Option<String>,
    pub rating: Option<i32>,
    pub color_label: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub sort_by: Option<String>,
    pub sort_order: Option<String>,
}

impl SmartAlbumFilter {
    fn validate(&self) -> Result<(), String> {
        if let Some(kind) = &self.kind {
            if !matches!(kind.as_str(), "photo" | "video" | "raw") {
                return Err(format!("Unsupported media kind in Smart Album: {kind}"));
            }
        }
        if let Some(rating) = self.rating {
            if !(0..=5).contains(&rating) {
                return Err("Smart Album rating must be between 0 and 5".to_string());
            }
        }
        if let (Some(from), Some(to)) = (self.date_from, self.date_to) {
            if from > to {
                return Err("Smart Album start date must be before its end date".to_string());
            }
        }
        if let Some(sort_by) = &self.sort_by {
            if !matches!(
                sort_by.as_str(),
                "capturedAt" | "modifiedAt" | "name" | "size" | "kind"
            ) {
                return Err(format!("Unsupported Smart Album sort: {sort_by}"));
            }
        }
        if let Some(order) = &self.sort_order {
            if !matches!(order.as_str(), "asc" | "desc") {
                return Err(format!("Unsupported Smart Album sort order: {order}"));
            }
        }
        Ok(())
    }

    fn to_library_filter(&self) -> LibraryFilterDTO {
        LibraryFilterDTO {
            kind: self.kind.clone(),
            favorite: self.favorite,
            hidden: None,
            album_id: None,
            query: self.query.clone(),
            tags: self.tags.clone(),
            date_from: self.date_from,
            date_to: self.date_to,
            source_path: self.source_path.clone(),
            rating: self.rating,
            color_label: self.color_label.clone(),
            camera: self.camera.clone(),
            lens: self.lens.clone(),
            limit: None,
            cursor: None,
            sort_by: self.sort_by.clone(),
            sort_order: self.sort_order.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartAlbum {
    pub id: String,
    pub name: String,
    pub filter: SmartAlbumFilter,
    pub item_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_to_album(row: &sqlx::sqlite::SqliteRow, item_count: i64) -> Result<SmartAlbum, String> {
    let filter_json: String = row.try_get("filter_json").map_err(|e| e.to_string())?;
    let filter: SmartAlbumFilter = serde_json::from_str(&filter_json)
        .map_err(|e| format!("Invalid Smart Album filter: {e}"))?;
    filter.validate()?;
    Ok(SmartAlbum {
        id: row.try_get("id").map_err(|e| e.to_string())?,
        name: row.try_get("name").map_err(|e| e.to_string())?,
        filter,
        item_count,
        created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
        updated_at: row.try_get("updated_at").map_err(|e| e.to_string())?,
    })
}

async fn count_matches(db: &sqlx::SqlitePool, filter: &SmartAlbumFilter) -> Result<i64, String> {
    let page = super::library::get_library_items_page(
        db,
        LibraryFilterDTO {
            limit: Some(1),
            ..filter.to_library_filter()
        },
    )
    .await?;
    Ok(page.total_count)
}

/// Read and validate every persisted definition, including the dynamic match
/// count. Kept separate from the Tauri command so restart behavior can be
/// tested against a real file-backed catalog.
pub(crate) async fn get_smart_albums_in_catalog(
    db: &sqlx::SqlitePool,
) -> Result<Vec<SmartAlbum>, String> {
    let rows = sqlx::query(
        "SELECT id, name, filter_json, created_at, updated_at FROM smart_albums ORDER BY name COLLATE NOCASE ASC",
    )
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;

    let mut albums = Vec::with_capacity(rows.len());
    for row in rows {
        let filter_json: String = row.try_get("filter_json").map_err(|e| e.to_string())?;
        let filter: SmartAlbumFilter = serde_json::from_str(&filter_json)
            .map_err(|e| format!("Invalid Smart Album filter: {e}"))?;
        filter.validate()?;
        let item_count = count_matches(db, &filter).await?;
        albums.push(row_to_album(&row, item_count)?);
    }
    Ok(albums)
}

/// Create and validate a Smart Album in the given catalog. Kept separate from
/// the Tauri command so restart behavior can be tested without a State.
pub(crate) async fn create_smart_album_in_catalog(
    db: &sqlx::SqlitePool,
    name: String,
    filter: SmartAlbumFilter,
) -> Result<SmartAlbum, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Smart Album name cannot be empty".to_string());
    }
    filter.validate()?;
    let id = Uuid::new_v4().to_string();
    let now = super::now_ms();
    let filter_json = serde_json::to_string(&filter).map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO smart_albums (id, name, filter_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&filter_json)
    .bind(now)
    .bind(now)
    .execute(db)
    .await
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("A Smart Album named \"{name}\" already exists")
        } else {
            e.to_string()
        }
    })?;
    let item_count = count_matches(db, &filter).await?;

    Ok(SmartAlbum {
        id,
        name,
        filter,
        item_count,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
pub async fn get_smart_albums(state: State<'_, AppState>) -> Result<Vec<SmartAlbum>, String> {
    let db = super::get_db(&state)?;
    get_smart_albums_in_catalog(&db).await
}

#[tauri::command]
pub async fn create_smart_album(
    name: String,
    filter: SmartAlbumFilter,
    state: State<'_, AppState>,
) -> Result<SmartAlbum, String> {
    let db = super::get_db(&state)?;
    create_smart_album_in_catalog(&db, name, filter).await
}

#[tauri::command]
pub async fn rename_smart_album(
    album_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Smart Album name cannot be empty".to_string());
    }
    let db = super::get_db(&state)?;
    sqlx::query("UPDATE smart_albums SET name = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(super::now_ms())
        .bind(&album_id)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_smart_album(
    album_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = super::get_db(&state)?;
    sqlx::query("DELETE FROM smart_albums WHERE id = ?")
        .bind(&album_id)
        .execute(&db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Evaluate a saved definition through the exact same paged library query used
/// by regular filters. The client supplies only paging, never SQL.
#[tauri::command]
pub async fn get_smart_album_items(
    album_id: String,
    limit: Option<i32>,
    cursor: Option<String>,
    state: State<'_, AppState>,
) -> Result<super::LibraryItemsPage, String> {
    let db = super::get_db(&state)?;
    let row = sqlx::query("SELECT filter_json FROM smart_albums WHERE id = ?")
        .bind(&album_id)
        .fetch_optional(&db)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Smart Album no longer exists".to_string())?;
    let filter_json: String = row.try_get("filter_json").map_err(|e| e.to_string())?;
    let filter: SmartAlbumFilter = serde_json::from_str(&filter_json)
        .map_err(|e| format!("Invalid Smart Album filter: {e}"))?;
    filter.validate()?;

    super::library::get_library_items_page(
        &db,
        LibraryFilterDTO {
            limit,
            cursor,
            ..filter.to_library_filter()
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::SmartAlbumFilter;

    #[tokio::test]
    async fn smart_albums_survive_catalog_restart_and_counts_track_changes() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

        let catalog_dir = std::env::temp_dir().join(format!(
            "visto-smart-album-restart-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&catalog_dir).unwrap();
        let catalog_path = catalog_dir.join("catalog.db");

        let options = SqliteConnectOptions::new()
            .filename(&catalog_path)
            .create_if_missing(true);
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();

        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, rating, color_label) VALUES ('rated', '/rated.jpg', 'rated.jpg', 'jpg', 'photo', 1, 100, 100, 1, 1, 5, 'blue')")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO albums (id, name, color_index, created_at, updated_at) VALUES ('regular', 'Regular album', 0, 1, 1)")
            .execute(&db)
            .await
            .unwrap();

        let filter = SmartAlbumFilter {
            kind: Some("photo".into()),
            rating: Some(4),
            ..Default::default()
        };
        let created =
            super::create_smart_album_in_catalog(&db, "Rated photos".into(), filter.clone())
                .await
                .unwrap();
        assert_eq!(created.item_count, 1);
        db.close().await;

        // Reopen the same file and apply the migration set again, matching a restart.
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();

        let albums = super::get_smart_albums_in_catalog(&db).await.unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].id, created.id);
        assert_eq!(albums[0].name, "Rated photos");
        assert_eq!(albums[0].filter, filter);
        assert_eq!(albums[0].item_count, 1);
        let regular_album_name: String =
            sqlx::query_scalar("SELECT name FROM albums WHERE id = 'regular'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(regular_album_name, "Regular album");

        sqlx::query("UPDATE media_items SET rating = 2 WHERE id = 'rated'")
            .execute(&db)
            .await
            .unwrap();
        let albums = super::get_smart_albums_in_catalog(&db).await.unwrap();
        assert_eq!(albums[0].item_count, 0);

        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, rating, color_label) VALUES ('new-match', '/new.jpg', 'new.jpg', 'jpg', 'photo', 1, 101, 101, 1, 1, 5, 'blue')")
            .execute(&db)
            .await
            .unwrap();
        let albums = super::get_smart_albums_in_catalog(&db).await.unwrap();
        assert_eq!(albums[0].item_count, 1);

        db.close().await;
        let _ = std::fs::remove_dir_all(catalog_dir);
    }

    #[tokio::test]
    async fn invalid_persisted_smart_album_fails_visibly() {
        use sqlx::sqlite::SqlitePoolOptions;

        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        sqlx::query("INSERT INTO smart_albums (id, name, filter_json, created_at, updated_at) VALUES ('bad', 'Bad definition', '{\"rating\":99}', 1, 1)")
            .execute(&db)
            .await
            .unwrap();

        let error = super::get_smart_albums_in_catalog(&db).await.unwrap_err();
        assert!(error.contains("Smart Album rating must be between 0 and 5"));
    }

    #[test]
    fn rejects_unknown_fields() {
        let parsed = serde_json::from_str::<SmartAlbumFilter>(
            r#"{"dateFrom":1,"sql":"DROP TABLE media_items"}"#,
        );
        assert!(parsed.is_err());
    }

    #[test]
    fn rejects_invalid_values() {
        let kind = SmartAlbumFilter {
            kind: Some("video".into()),
            ..Default::default()
        };
        assert!(kind.validate().is_ok());

        let bad_kind = SmartAlbumFilter {
            kind: Some("executable".into()),
            ..Default::default()
        };
        assert!(bad_kind.validate().is_err());

        let bad_dates = SmartAlbumFilter {
            date_from: Some(10),
            date_to: Some(5),
            ..Default::default()
        };
        assert!(bad_dates.validate().is_err());

        let bad_rating = SmartAlbumFilter {
            rating: Some(9),
            ..Default::default()
        };
        assert!(bad_rating.validate().is_err());
    }
}
