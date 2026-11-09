//! Catalog SQL helpers (album/tag selects, purge).

use sqlx::SqlitePool;

/// Album rows with their item count folded in, so `Album.item_count` is always a
/// real column on the result set.
pub(crate) const ALBUM_SELECT: &str =
    "SELECT a.id, a.name, a.color_index, a.created_at, a.updated_at, \
     (SELECT COUNT(*) FROM album_items ai JOIN media_items m ON m.id = ai.media_id \
      WHERE ai.album_id = a.id AND m.hidden = 0) AS item_count FROM albums a";

/// Tag rows with their item count folded in, mirroring [`ALBUM_SELECT`].
pub(crate) const TAG_SELECT: &str = "SELECT t.id, t.name, t.color_index, t.created_at, \
     (SELECT COUNT(*) FROM media_tags mt JOIN media_items m ON m.id = mt.media_id \
      WHERE mt.tag_id = t.id AND m.hidden = 0) AS item_count FROM tags t";

/// Delete every catalog row in one transaction: a failure part-way leaves the
/// catalog exactly as it was instead of half-deleted.
pub(crate) async fn purge_catalog(db: &SqlitePool) -> Result<(), String> {
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;
    // Children first, so this also works without foreign-key cascades.
    for table in [
        "media_tags",
        "album_items",
        "edit_recipes",
        "edit_backups",
        "media_items",
        "albums",
        "tags",
        "smart_albums",
        "library_folders",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Could not clear {table}: {e}"))?;
    }
    tx.commit().await.map_err(|e| e.to_string())
}
