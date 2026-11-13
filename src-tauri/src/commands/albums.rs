use crate::errors::CommandError;
use crate::models::*;
use serde::Serialize;
use sqlx::sqlite::Sqlite;
use sqlx::{QueryBuilder, Row};
use std::collections::HashMap;
use tauri::State;
use ts_rs::TS;

/// Bounded card data for the Albums overview.
///
/// `item_count` is the full visible membership, while `cover_items` contains at
/// most four poster candidates. Opening an album fetches the complete, paged
/// membership through the normal library query.
#[derive(Serialize, TS)]
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
pub async fn get_album_overviews(
    catalog: State<'_, crate::Catalog>,
) -> Result<Vec<AlbumOverview>, CommandError> {
    let db = super::get_db(&catalog)?;
    load_album_overviews(&db).await
}

pub(crate) async fn load_album_overviews(
    db: &sqlx::SqlitePool,
) -> Result<Vec<AlbumOverview>, CommandError> {
    let albums = sqlx::query_as::<_, Album>(&format!(
        "{} ORDER BY a.created_at ASC",
        super::ALBUM_SELECT
    ))
    .fetch_all(db)
    .await?;

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
    .await?;

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
        let items = qb.build_query_as::<MediaItem>().fetch_all(db).await?;
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
                .filter_map(|id| items_by_id.get(&id).cloned())
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
pub async fn get_albums(catalog: State<'_, crate::Catalog>) -> Result<Vec<Album>, CommandError> {
    let db = super::get_db(&catalog)?;
    let mut albums = sqlx::query_as::<_, Album>(&format!(
        "{} ORDER BY a.created_at ASC",
        super::ALBUM_SELECT
    ))
    .fetch_all(&db)
    .await?;

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
            .await?;
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
    catalog: State<'_, crate::Catalog>,
) -> Result<Album, CommandError> {
    let db = super::get_db(&catalog)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(CommandError::internal(
            "Album name cannot be empty".to_string(),
        ));
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
    .await?;
    Ok(album)
}

#[tauri::command]
pub async fn delete_album(
    album_id: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    sqlx::query("DELETE FROM albums WHERE id = ?")
        .bind(&album_id)
        .execute(&db)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_album(
    album_id: String,
    name: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    sqlx::query("UPDATE albums SET name = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(super::now_ms())
        .bind(&album_id)
        .execute(&db)
        .await?;
    Ok(())
}

async fn fetch_album_items(
    db: &sqlx::SqlitePool,
    album_id: &str,
) -> Result<Vec<MediaItem>, CommandError> {
    // `SELECT m.*` keeps this query in sync with MediaItem's row mapper.
    // Listing columns by hand previously dropped `is_animated` and
    // `content_signature`, so every album open failed to decode a row.
    let items = sqlx::query_as::<_, MediaItem>(
        "SELECT m.*
         FROM media_items m
         JOIN album_items ai ON ai.media_id = m.id
         WHERE ai.album_id = ? AND m.hidden = 0
         ORDER BY m.captured_at ASC",
    )
    .bind(album_id)
    .fetch_all(db)
    .await?;
    Ok(items)
}

#[tauri::command]
pub async fn get_album_items(
    album_id: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<Vec<MediaItem>, CommandError> {
    let db = super::get_db(&catalog)?;
    fetch_album_items(&db, &album_id).await
}

/// Batched add, with every row in one transaction. Filling a 100k-item album
/// with per-id `INSERT OR IGNORE` was both slow and left a partially filled
/// album behind on failure.
pub async fn add_to_album_db(
    db: &sqlx::SqlitePool,
    album_id: &str,
    item_ids: &[String],
) -> Result<(), CommandError> {
    if item_ids.is_empty() {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    let now = super::now_ms();
    let mut changed = false;
    for chunk in item_ids.chunks(400) {
        // Which of these are already members? One lookup per chunk, then a
        // multi-row insert of only the missing ones — with no UNIQUE index on
        // album_items, we have to de-duplicate here rather than in SQL.
        let mut lookup = QueryBuilder::new("SELECT media_id FROM album_items WHERE album_id = ");
        lookup.push_bind(album_id).push(" AND media_id IN (");
        {
            let mut separated = lookup.separated(", ");
            for id in chunk {
                separated.push_bind(id);
            }
        }
        lookup.push(")");
        let existing: std::collections::HashSet<String> = lookup
            .build_query_scalar::<String>()
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .collect();

        let fresh: Vec<&String> = chunk.iter().filter(|id| !existing.contains(*id)).collect();
        if fresh.is_empty() {
            continue;
        }
        let mut insert =
            QueryBuilder::new("INSERT OR IGNORE INTO album_items (album_id, media_id, added_at) ");
        insert.push_values(fresh, |mut row, id| {
            row.push_bind(album_id).push_bind(id).push_bind(now);
        });
        insert.build().execute(&mut *tx).await?;
        changed = true;
    }
    if changed {
        // The card shows "updated" from this column; a membership change that
        // leaves it untouched makes a fresh album look untouched for weeks.
        sqlx::query("UPDATE albums SET updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(album_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn add_to_album(
    album_id: String,
    item_ids: Vec<String>,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    add_to_album_db(&db, &album_id, &item_ids).await
}

/// Batched remove, transactionally; same scale story as `add_to_album_db`.
pub async fn remove_from_album_db(
    db: &sqlx::SqlitePool,
    album_id: &str,
    item_ids: &[String],
) -> Result<(), CommandError> {
    if item_ids.is_empty() {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    let now = super::now_ms();
    let mut changed = false;
    for chunk in item_ids.chunks(400) {
        let mut qb = QueryBuilder::new("DELETE FROM album_items WHERE album_id = ");
        qb.push_bind(album_id);
        qb.push(" AND media_id IN (");
        {
            let mut separated = qb.separated(", ");
            for id in chunk {
                separated.push_bind(id);
            }
        }
        qb.push(")");
        let result = qb.build().execute(&mut *tx).await?;
        changed |= result.rows_affected() > 0;
    }
    if changed {
        sqlx::query("UPDATE albums SET updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(album_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn remove_from_album(
    album_id: String,
    item_ids: Vec<String>,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    remove_from_album_db(&db, &album_id, &item_ids).await
}

#[cfg(test)]
mod tests {
    use super::{add_to_album_db, fetch_album_items, remove_from_album_db};
    use sqlx::sqlite::SqlitePoolOptions;

    async fn album_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory album database");
        sqlx::query(
            "CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at INTEGER, width INTEGER, height INTEGER, camera TEXT, lens TEXT, exposure TEXT, iso INTEGER, latitude REAL, longitude REAL, sha256 TEXT, favorite INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, is_animated INTEGER NOT NULL DEFAULT 0, content_signature TEXT, import_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rating INTEGER, color_label TEXT)",
        )
        .execute(&db)
        .await
        .expect("create media table");
        sqlx::query("CREATE TABLE album_items (album_id TEXT NOT NULL, media_id TEXT NOT NULL, added_at INTEGER NOT NULL DEFAULT 0)")
            .execute(&db)
            .await
            .expect("create album items table");
        sqlx::query("CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL, color_index INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)")
            .execute(&db)
            .await
            .expect("create albums table");
        db
    }

    #[tokio::test]
    async fn add_and_remove_album_items_handle_large_batches() {
        let db = album_db().await;
        for i in 0..850 {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES (?, ?, ?, 'jpg', 'photo', 1, 1, 1, 1)")
                .bind(format!("m-{i}"))
                .bind(format!("/tmp/item-{i}.jpg"))
                .bind(format!("item-{i}.jpg"))
                .execute(&db)
                .await
                .expect("insert media row");
        }
        let ids: Vec<String> = (0..850).map(|i| format!("m-{i}")).collect();

        add_to_album_db(&db, "a1", &ids)
            .await
            .expect("batch add should succeed across multiple chunks");

        // Re-adding must not duplicate membership (INSERT OR IGNORE).
        add_to_album_db(&db, "a1", &ids)
            .await
            .expect("re-adding a member is a no-op");

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM album_items WHERE album_id = 'a1'")
                .fetch_one(&db)
                .await
                .expect("count album memberships");
        assert_eq!(count, 850);

        remove_from_album_db(&db, "a1", &ids[..425])
            .await
            .expect("batch remove should succeed across multiple chunks");

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM album_items WHERE album_id = 'a1'")
                .fetch_one(&db)
                .await
                .expect("count album memberships after remove");
        assert_eq!(count, 425);
    }

    #[tokio::test]
    async fn membership_changes_bump_album_updated_at() {
        let db = album_db().await;
        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES ('m1', '/tmp/a.jpg', 'a.jpg', 'jpg', 'photo', 1, 1, 1, 1)")
            .execute(&db)
            .await
            .expect("insert media row");
        sqlx::query(
            "INSERT INTO albums (id, name, created_at, updated_at) VALUES ('a1', 'Trip', 1, 1)",
        )
        .execute(&db)
        .await
        .expect("insert album row");

        add_to_album_db(&db, "a1", &["m1".to_string()])
            .await
            .expect("add member");
        let after_add: i64 = sqlx::query_scalar("SELECT updated_at FROM albums WHERE id = 'a1'")
            .fetch_one(&db)
            .await
            .expect("read updated_at after add");
        assert!(after_add > 1, "adding a member must touch updated_at");

        // Re-adding the same member changes nothing, so the timestamp must not move.
        add_to_album_db(&db, "a1", &["m1".to_string()])
            .await
            .expect("re-add is a no-op");
        let after_readd: i64 = sqlx::query_scalar("SELECT updated_at FROM albums WHERE id = 'a1'")
            .fetch_one(&db)
            .await
            .expect("read updated_at after re-add");
        assert_eq!(after_readd, after_add);

        remove_from_album_db(&db, "a1", &["m1".to_string()])
            .await
            .expect("remove member");
        let after_remove: i64 = sqlx::query_scalar("SELECT updated_at FROM albums WHERE id = 'a1'")
            .fetch_one(&db)
            .await
            .expect("read updated_at after remove");
        assert!(
            after_remove >= after_add,
            "removing a member must leave updated_at at least as new"
        );
    }

    #[tokio::test]
    async fn album_items_decode_animation_and_signature_columns() {
        let db = album_db().await;
        sqlx::query(
            "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at, is_animated, content_signature) VALUES ('m1', '/tmp/a.gif', 'a.gif', 'gif', 'photo', 1, 1, 1, 1, 1, 'sig')",
        )
        .execute(&db)
        .await
        .expect("insert media row");
        sqlx::query("INSERT INTO album_items (album_id, media_id) VALUES ('a1', 'm1')")
            .execute(&db)
            .await
            .expect("insert album membership");

        let items = fetch_album_items(&db, "a1")
            .await
            .expect("decode album items");

        assert_eq!(items.len(), 1);
        assert!(items[0].is_animated);
        assert_eq!(items[0].content_signature.as_deref(), Some("sig"));
    }
}
