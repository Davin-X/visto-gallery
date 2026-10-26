use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Row};
use time::OffsetDateTime;
use uuid::Uuid;

// All structs that cross the IPC boundary serialise as camelCase, matching the
// TypeScript interfaces in src/engine/types. `sqlx` keeps using the snake_case
// field names for row mapping, so the attributes never affect the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub path: String,
    pub name: String,
    pub extension: String,
    pub kind: String,
    pub size: i64,
    pub modified_at: i64,
    pub captured_at: Option<i64>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub exposure: Option<String>,
    pub iso: Option<i32>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub sha256: Option<String>,
    pub favorite: bool,
    pub hidden: bool,
    pub import_session_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    // Derived, not stored on the row: hydrated per query so the UI always has
    // arrays to map over instead of `undefined`.
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub album_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub name: String,
    pub color_index: i32,
    pub created_at: i64,
    pub updated_at: i64,
    // Not a column on `albums`: every query selects it as a correlated count.
    pub item_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color_index: i32,
    pub created_at: i64,
    // Not a column on `tags`: every query selects it as a correlated count.
    pub item_count: i64,
}


/// Hand-written row mapping.
///
/// `tags` and `album_ids` are not columns — they are hydrated by the command
/// layer — so they start empty rather than making `Vec<String>` satisfy sqlx's
/// `Decode`/`Type` bounds.
impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for MediaItem {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            path: row.try_get("path")?,
            name: row.try_get("name")?,
            extension: row.try_get("extension")?,
            kind: row.try_get("kind")?,
            size: row.try_get("size")?,
            modified_at: row.try_get("modified_at")?,
            captured_at: row.try_get("captured_at")?,
            width: row.try_get("width")?,
            height: row.try_get("height")?,
            camera: row.try_get("camera")?,
            lens: row.try_get("lens")?,
            exposure: row.try_get("exposure")?,
            iso: row.try_get("iso")?,
            latitude: row.try_get("latitude")?,
            longitude: row.try_get("longitude")?,
            sha256: row.try_get("sha256")?,
            favorite: row.try_get("favorite")?,
            hidden: row.try_get("hidden")?,
            import_session_id: row.try_get("import_session_id")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            tags: Vec::new(),
            album_ids: Vec::new(),
        })
    }
}

/// Stable primary key for a media item.
///
/// The absolute path is the natural key for a local file, so hashing it means a
/// re-scan updates the existing row (`INSERT OR REPLACE`) instead of appending a
/// duplicate for every file, which a random id would do.
pub fn stable_id(path: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, path.as_bytes());
    hex::encode(&digest.as_ref()[..16])
}

impl MediaItem {
    pub fn new(path: String, name: String, extension: String, kind: String, size: i64, modified_at: i64) -> Self {
        let now = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
        Self {
            id: stable_id(&path),
            path,
            name,
            extension,
            kind,
            size,
            modified_at,
            captured_at: None,
            width: None,
            height: None,
            camera: None,
            lens: None,
            exposure: None,
            iso: None,
            latitude: None,
            longitude: None,
            sha256: None,
            favorite: false,
            hidden: false,
            import_session_id: None,
            created_at: now,
            updated_at: now,
            tags: Vec::new(),
            album_ids: Vec::new(),
        }
    }
}

impl Album {
    pub fn new(name: String, color_index: i32) -> Self {
        let now = (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
        Self {
            id: Uuid::new_v4().to_string(),
            name,
            color_index,
            created_at: now,
            updated_at: now,
            item_count: 0,
        }
    }
}