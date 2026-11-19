use super::LibraryFilterDTO;
use crate::errors::CommandError;
use crate::models::MediaItem;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;
use ts_rs::TS;
use uuid::Uuid;

/// The only fields a saved Smart Album may contain.
///
/// `deny_unknown_fields` is deliberate: a definition imported from a future or
/// corrupted build fails visibly instead of being silently ignored. The
/// resulting SQL always binds these values; no part of a definition is ever
/// interpolated into a statement.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(optional_fields = nullable)]
pub struct SmartAlbumFilter {
    #[ts(optional, type = "\"photo\" | \"video\" | \"raw\"")]
    pub kind: Option<String>,
    pub favorite: Option<bool>,
    pub query: Option<String>,
    pub tags: Option<Vec<String>>,
    /// `any` (default) matches one of the tags, `all` requires every one.
    #[ts(optional, type = "\"any\" | \"all\"")]
    pub tag_match: Option<String>,
    /// File size range in bytes, inclusive on both ends.
    pub size_min: Option<i64>,
    pub size_max: Option<i64>,
    /// File extension without the leading dot, matched case-insensitively.
    pub extension: Option<String>,
    /// `Some(true)` narrows to animated items, `Some(false)` to still ones.
    pub animated: Option<bool>,
    /// `Some(true)` requires GPS coordinates, `Some(false)` excludes them.
    pub has_location: Option<bool>,
    /// Frame shape from width and height.
    #[ts(optional, type = "\"landscape\" | \"portrait\" | \"square\"")]
    pub orientation: Option<String>,
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    pub source_path: Option<String>,
    pub rating: Option<i32>,
    pub color_label: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    #[ts(
        optional,
        type = "\"capturedAt\" | \"modifiedAt\" | \"name\" | \"size\" | \"kind\""
    )]
    pub sort_by: Option<String>,
    #[ts(optional, type = "\"asc\" | \"desc\"")]
    pub sort_order: Option<String>,
}

impl SmartAlbumFilter {
    fn validate(&self) -> Result<(), CommandError> {
        if let Some(kind) = &self.kind {
            if !matches!(kind.as_str(), "photo" | "video" | "raw") {
                return Err(CommandError::invalid(format!(
                    "Unsupported media kind in Smart Album: {kind}"
                )));
            }
        }
        if let Some(rating) = self.rating {
            if !(0..=5).contains(&rating) {
                return Err(CommandError::invalid(
                    "Smart Album rating must be between 0 and 5".to_string(),
                ));
            }
        }
        if self.size_min.is_some_and(|size| size < 0) || self.size_max.is_some_and(|size| size < 0)
        {
            return Err(CommandError::invalid(
                "Smart Album file sizes cannot be negative".to_string(),
            ));
        }
        if let (Some(min), Some(max)) = (self.size_min, self.size_max) {
            if min > max {
                return Err(CommandError::invalid(
                    "Smart Album minimum size must not exceed its maximum size".to_string(),
                ));
            }
        }
        if let Some(extension) = &self.extension {
            let trimmed = extension.trim().trim_start_matches('.');
            if trimmed.is_empty() || trimmed.contains(['/', '\\']) {
                return Err(CommandError::invalid(
                    "Smart Album extension must be a file extension such as jpg".to_string(),
                ));
            }
        }
        if let Some(orientation) = &self.orientation {
            if !matches!(orientation.as_str(), "landscape" | "portrait" | "square") {
                return Err(CommandError::invalid(format!(
                    "Unsupported Smart Album orientation: {orientation}"
                )));
            }
        }
        if let Some(tag_match) = &self.tag_match {
            if !matches!(tag_match.as_str(), "any" | "all") {
                return Err(CommandError::invalid(format!(
                    "Unsupported Smart Album tag match: {tag_match}"
                )));
            }
        }
        if let (Some(from), Some(to)) = (self.date_from, self.date_to) {
            if from > to {
                return Err(CommandError::invalid(
                    "Smart Album start date must be before its end date".to_string(),
                ));
            }
        }
        if let Some(sort_by) = &self.sort_by {
            if !matches!(
                sort_by.as_str(),
                "capturedAt" | "modifiedAt" | "name" | "size" | "kind"
            ) {
                return Err(CommandError::invalid(format!(
                    "Unsupported Smart Album sort: {sort_by}"
                )));
            }
        }
        if let Some(order) = &self.sort_order {
            if !matches!(order.as_str(), "asc" | "desc") {
                return Err(CommandError::invalid(format!(
                    "Unsupported Smart Album sort order: {order}"
                )));
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
            tag_match: self.tag_match.clone(),
            size_min: self.size_min,
            size_max: self.size_max,
            extension: self.extension.clone(),
            animated: self.animated,
            has_location: self.has_location,
            orientation: self.orientation.clone(),
            date_from: self.date_from,
            date_to: self.date_to,
            month: None,
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

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SmartAlbum {
    pub id: String,
    pub name: String,
    pub filter: SmartAlbumFilter,
    pub item_count: i64,
    pub cover_items: Vec<MediaItem>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_to_album(
    row: &sqlx::sqlite::SqliteRow,
    item_count: i64,
    cover_items: Vec<MediaItem>,
) -> Result<SmartAlbum, CommandError> {
    let filter_json: String = row.try_get("filter_json")?;
    let filter: SmartAlbumFilter = serde_json::from_str(&filter_json)
        .map_err(|e| CommandError::invalid(format!("Invalid Smart Album filter: {e}")))?;
    filter.validate()?;
    Ok(SmartAlbum {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        filter,
        item_count,
        cover_items,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn count_matches(
    db: &sqlx::SqlitePool,
    filter: &SmartAlbumFilter,
) -> Result<i64, CommandError> {
    let page = super::library::get_library_items_page(
        db,
        LibraryFilterDTO {
            limit: Some(1),
            ..filter.to_library_filter()
        },
    )
    .await?;
    // A count request carries no cursor, so the page always carries the total.
    Ok(page
        .total_count
        .expect("count request must return a total_count"))
}

async fn cover_items_for(
    db: &sqlx::SqlitePool,
    filter: &SmartAlbumFilter,
) -> Result<Vec<MediaItem>, CommandError> {
    let page = super::library::get_library_items_page(
        db,
        LibraryFilterDTO {
            limit: Some(3),
            ..filter.to_library_filter()
        },
    )
    .await?;
    Ok(page.items)
}

/// Read and validate every persisted definition, including the dynamic match
/// count. Kept separate from the Tauri command so restart behavior can be
/// tested against a real file-backed catalog.
pub(crate) async fn get_smart_albums_in_catalog(
    db: &sqlx::SqlitePool,
) -> Result<Vec<SmartAlbum>, CommandError> {
    let rows = sqlx::query(
        "SELECT id, name, filter_json, created_at, updated_at FROM smart_albums ORDER BY name COLLATE NOCASE ASC",
    )
    .fetch_all(db)
    .await
    ?;

    let mut albums = Vec::with_capacity(rows.len());
    for row in rows {
        let filter_json: String = row.try_get("filter_json")?;
        let filter: SmartAlbumFilter = serde_json::from_str(&filter_json)
            .map_err(|e| CommandError::invalid(format!("Invalid Smart Album filter: {e}")))?;
        filter.validate()?;
        let item_count = count_matches(db, &filter).await?;
        let covers = cover_items_for(db, &filter).await?;
        albums.push(row_to_album(&row, item_count, covers)?);
    }
    Ok(albums)
}

/// Create and validate a Smart Album in the given catalog. Kept separate from
/// the Tauri command so restart behavior can be tested without a State.
pub(crate) async fn create_smart_album_in_catalog(
    db: &sqlx::SqlitePool,
    name: String,
    filter: SmartAlbumFilter,
) -> Result<SmartAlbum, CommandError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(CommandError::invalid(
            "Smart Album name cannot be empty".to_string(),
        ));
    }
    filter.validate()?;
    let id = Uuid::new_v4().to_string();
    let now = super::now_ms();
    let filter_json = serde_json::to_string(&filter)?;
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
    let covers = cover_items_for(db, &filter).await?;

    Ok(SmartAlbum {
        id,
        name,
        filter,
        item_count,
        cover_items: covers,
        created_at: now,
        updated_at: now,
    })
}

/// Replace a Smart Album's name and definition in place.
///
/// Editing must not change the album's identity: the id, and therefore every
/// reference the client holds, survives. The row is rewritten with the same
/// validation the create path uses, and the returned album carries fresh match
/// counts and covers so the caller can swap it into state without a reload.
pub(crate) async fn update_smart_album_in_catalog(
    db: &sqlx::SqlitePool,
    album_id: &str,
    name: String,
    filter: SmartAlbumFilter,
) -> Result<SmartAlbum, CommandError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(CommandError::invalid(
            "Smart Album name cannot be empty".to_string(),
        ));
    }
    filter.validate()?;
    let now = super::now_ms();
    let filter_json = serde_json::to_string(&filter)?;
    let result = sqlx::query(
        "UPDATE smart_albums SET name = ?, filter_json = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(&filter_json)
    .bind(now)
    .bind(album_id)
    .execute(db)
    .await
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("A Smart Album named \"{name}\" already exists")
        } else {
            e.to_string()
        }
    })?;
    if result.rows_affected() == 0 {
        return Err(CommandError::invalid(
            "Smart Album no longer exists".to_string(),
        ));
    }

    let row = sqlx::query(
        "SELECT id, name, filter_json, created_at, updated_at FROM smart_albums WHERE id = ?",
    )
    .bind(album_id)
    .fetch_one(db)
    .await?;
    let item_count = count_matches(db, &filter).await?;
    let covers = cover_items_for(db, &filter).await?;
    row_to_album(&row, item_count, covers)
}

#[tauri::command]
pub async fn get_smart_albums(
    catalog: State<'_, crate::Catalog>,
) -> Result<Vec<SmartAlbum>, CommandError> {
    let db = super::get_db(&catalog)?;
    get_smart_albums_in_catalog(&db).await
}

#[tauri::command]
pub async fn create_smart_album(
    name: String,
    filter: SmartAlbumFilter,
    catalog: State<'_, crate::Catalog>,
) -> Result<SmartAlbum, CommandError> {
    let db = super::get_db(&catalog)?;
    create_smart_album_in_catalog(&db, name, filter).await
}

#[tauri::command]
pub async fn update_smart_album(
    album_id: String,
    name: String,
    filter: SmartAlbumFilter,
    catalog: State<'_, crate::Catalog>,
) -> Result<SmartAlbum, CommandError> {
    let db = super::get_db(&catalog)?;
    update_smart_album_in_catalog(&db, &album_id, name, filter).await
}

#[tauri::command]
pub async fn rename_smart_album(
    album_id: String,
    name: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(CommandError::invalid(
            "Smart Album name cannot be empty".to_string(),
        ));
    }
    let db = super::get_db(&catalog)?;
    sqlx::query("UPDATE smart_albums SET name = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(super::now_ms())
        .bind(&album_id)
        .execute(&db)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_smart_album(
    album_id: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    sqlx::query("DELETE FROM smart_albums WHERE id = ?")
        .bind(&album_id)
        .execute(&db)
        .await?;
    Ok(())
}

/// Evaluate a saved definition through the exact same paged library query used
/// by regular filters. The client supplies only paging, never SQL.
#[tauri::command]
pub async fn get_smart_album_items(
    album_id: String,
    limit: Option<i32>,
    cursor: Option<String>,
    catalog: State<'_, crate::Catalog>,
) -> Result<super::LibraryItemsPage, CommandError> {
    let db = super::get_db(&catalog)?;
    let row = sqlx::query("SELECT filter_json FROM smart_albums WHERE id = ?")
        .bind(&album_id)
        .fetch_optional(&db)
        .await?
        .ok_or_else(|| "Smart Album no longer exists".to_string())?;
    let filter_json: String = row.try_get("filter_json")?;
    let filter: SmartAlbumFilter = serde_json::from_str(&filter_json)
        .map_err(|e| CommandError::invalid(format!("Invalid Smart Album filter: {e}")))?;
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
        assert!(error
            .message
            .contains("Smart Album rating must be between 0 and 5"));
    }

    #[tokio::test]
    async fn updating_a_smart_album_keeps_its_id_and_recomputes_matches() {
        use sqlx::sqlite::SqlitePoolOptions;

        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();

        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, rating, color_label) VALUES ('photo', '/photo.jpg', 'photo.jpg', 'jpg', 'photo', 1, 100, 100, 1, 1, 5, 'blue')")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, rating, color_label) VALUES ('video', '/clip.mov', 'clip.mov', 'mov', 'video', 1, 100, 100, 1, 1, 5, 'blue')")
            .execute(&db)
            .await
            .unwrap();

        let created = super::create_smart_album_in_catalog(
            &db,
            "Rated".into(),
            SmartAlbumFilter {
                rating: Some(4),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(created.item_count, 2);

        // Editing must preserve identity and creation time, and must recompute
        // the count from the new definition rather than carrying the old one.
        let updated = super::update_smart_album_in_catalog(
            &db,
            &created.id,
            "Videos only".into(),
            SmartAlbumFilter {
                kind: Some("video".into()),
                rating: Some(4),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "Videos only");
        assert_eq!(updated.created_at, created.created_at);
        assert!(updated.updated_at >= created.updated_at);
        assert_eq!(updated.item_count, 1);

        let listed = super::get_smart_albums_in_catalog(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
        assert_eq!(listed[0].filter.kind.as_deref(), Some("video"));

        // An id that no longer exists is an error, not a silent no-op.
        let missing = super::update_smart_album_in_catalog(
            &db,
            "does-not-exist",
            "Gone".into(),
            Default::default(),
        )
        .await
        .unwrap_err();
        assert!(missing.message.contains("no longer exists"));

        // Renaming onto another album's name keeps the UNIQUE constraint honest.
        let second = super::create_smart_album_in_catalog(&db, "Second".into(), Default::default())
            .await
            .unwrap();
        let duplicate = super::update_smart_album_in_catalog(
            &db,
            &second.id,
            "Videos only".into(),
            Default::default(),
        )
        .await
        .unwrap_err();
        assert!(duplicate.message.contains("already exists"));
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

    #[test]
    fn rejects_invalid_v2_values() {
        let bad_size = SmartAlbumFilter {
            size_min: Some(10),
            size_max: Some(5),
            ..Default::default()
        };
        assert!(bad_size.validate().is_err());

        let negative_size = SmartAlbumFilter {
            size_min: Some(-1),
            ..Default::default()
        };
        assert!(negative_size.validate().is_err());

        let bad_extension = SmartAlbumFilter {
            extension: Some("/photos/jpg".into()),
            ..Default::default()
        };
        assert!(bad_extension.validate().is_err());

        let blank_extension = SmartAlbumFilter {
            extension: Some(" . ".into()),
            ..Default::default()
        };
        assert!(blank_extension.validate().is_err());

        let bad_orientation = SmartAlbumFilter {
            orientation: Some("diagonal".into()),
            ..Default::default()
        };
        assert!(bad_orientation.validate().is_err());

        let bad_tag_match = SmartAlbumFilter {
            tag_match: Some("some".into()),
            ..Default::default()
        };
        assert!(bad_tag_match.validate().is_err());

        let valid = SmartAlbumFilter {
            size_min: Some(1),
            size_max: Some(2),
            extension: Some(".JPG".into()),
            orientation: Some("landscape".into()),
            tag_match: Some("all".into()),
            ..Default::default()
        };
        assert!(valid.validate().is_ok());
    }

    #[tokio::test]
    async fn v2_filters_narrow_by_size_extension_animation_location_orientation_and_tags() {
        use sqlx::sqlite::SqlitePoolOptions;

        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();

        for (id, extension, size, width, height, located, animated) in [
            (
                "portrait-jpg",
                "jpg",
                1_000_000_i64,
                300_i64,
                400_i64,
                false,
                false,
            ),
            ("landscape-gif", "gif", 5_000_000, 1600, 900, true, true),
            ("square-png", "png", 2_500_000, 800, 800, true, false),
        ] {
            sqlx::query(
                "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, width, height, latitude, longitude, is_animated) VALUES (?, ?, ?, ?, 'photo', ?, 1, 1, 1, 1, ?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(format!("/lib/{id}.{extension}"))
            .bind(format!("{id}.{extension}"))
            .bind(extension)
            .bind(size)
            .bind(width)
            .bind(height)
            .bind(if located { Some(12.34_f64) } else { None })
            .bind(if located { Some(56.78_f64) } else { None })
            .bind(if animated { 1_i64 } else { 0_i64 })
            .execute(&db)
            .await
            .unwrap();
        }
        for (id, name) in [("t-travel", "travel"), ("t-family", "family")] {
            sqlx::query("INSERT INTO tags (id, name, created_at) VALUES (?, ?, 1)")
                .bind(id)
                .bind(name)
                .execute(&db)
                .await
                .unwrap();
        }
        for (media, tag) in [
            ("portrait-jpg", "t-travel"),
            ("landscape-gif", "t-travel"),
            ("landscape-gif", "t-family"),
            ("square-png", "t-family"),
        ] {
            sqlx::query("INSERT INTO media_tags (media_id, tag_id) VALUES (?, ?)")
                .bind(media)
                .bind(tag)
                .execute(&db)
                .await
                .unwrap();
        }

        let mut names = 0;
        let mut count = |filter: SmartAlbumFilter| {
            names += 1;
            let db = db.clone();
            async move {
                super::create_smart_album_in_catalog(&db, format!("Album {names}"), filter)
                    .await
                    .unwrap()
                    .item_count
            }
        };

        assert_eq!(
            count(SmartAlbumFilter {
                size_min: Some(2_000_000),
                ..Default::default()
            })
            .await,
            2
        );
        assert_eq!(
            count(SmartAlbumFilter {
                size_max: Some(1_500_000),
                ..Default::default()
            })
            .await,
            1
        );
        assert_eq!(
            count(SmartAlbumFilter {
                size_min: Some(1_000_000),
                size_max: Some(2_500_000),
                ..Default::default()
            })
            .await,
            2
        );
        // The extension is matched case-insensitively and without its dot.
        assert_eq!(
            count(SmartAlbumFilter {
                extension: Some(".GIF".into()),
                ..Default::default()
            })
            .await,
            1
        );
        assert_eq!(
            count(SmartAlbumFilter {
                animated: Some(true),
                ..Default::default()
            })
            .await,
            1
        );
        assert_eq!(
            count(SmartAlbumFilter {
                animated: Some(false),
                ..Default::default()
            })
            .await,
            2
        );
        assert_eq!(
            count(SmartAlbumFilter {
                has_location: Some(true),
                ..Default::default()
            })
            .await,
            2
        );
        assert_eq!(
            count(SmartAlbumFilter {
                has_location: Some(false),
                ..Default::default()
            })
            .await,
            1
        );
        for (orientation, expected) in [("landscape", 1), ("portrait", 1), ("square", 1)] {
            assert_eq!(
                count(SmartAlbumFilter {
                    orientation: Some(orientation.into()),
                    ..Default::default()
                })
                .await,
                expected,
                "orientation {orientation}"
            );
        }
        assert_eq!(
            count(SmartAlbumFilter {
                tags: Some(vec!["travel".into()]),
                ..Default::default()
            })
            .await,
            2
        );
        assert_eq!(
            count(SmartAlbumFilter {
                tags: Some(vec!["travel".into(), "family".into()]),
                ..Default::default()
            })
            .await,
            3,
            "any matches one of the tags"
        );
        assert_eq!(
            count(SmartAlbumFilter {
                tags: Some(vec!["travel".into(), "family".into()]),
                tag_match: Some("all".into()),
                ..Default::default()
            })
            .await,
            1,
            "all requires every tag"
        );

        // Every clause composes into one narrowing definition.
        assert_eq!(
            count(SmartAlbumFilter {
                size_min: Some(2_000_000),
                animated: Some(true),
                has_location: Some(true),
                orientation: Some("landscape".into()),
                ..Default::default()
            })
            .await,
            1
        );
    }
}
