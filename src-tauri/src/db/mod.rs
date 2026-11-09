use anyhow::Result;
use chrono::Utc;
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::path::PathBuf;
use tauri::Manager;

pub struct Database {
    pool: SqlitePool,
}

impl Database {
    pub async fn open(app_handle: &tauri::AppHandle) -> Result<Self> {
        Self::new(app_handle).await
    }

    pub async fn new(app_handle: &tauri::AppHandle) -> Result<Self> {
        let db_path = get_db_path(app_handle)?;

        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true)
                    .foreign_keys(true)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                    .busy_timeout(std::time::Duration::from_secs(30)),
            )
            .await?;

        let db = Self { pool };
        db.migrate().await?;
        Ok(db)
    }

    pub async fn registered_folders(&self) -> Vec<String> {
        sqlx::query_scalar("SELECT path FROM library_folders")
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default()
    }

    async fn migrate(&self) -> Result<()> {
        // Run embedded migrations
        sqlx::migrate!("./migrations").run(&self.pool).await?;
        Ok(())
    }

    /// One-time data backfills that open media files. They can take minutes
    /// on a large or slow (external) library, so they run in the background
    /// after the window is up instead of blocking launch. Each is idempotent
    /// and records completion in `_migration_flags`, so an interrupted run
    /// simply resumes next launch.
    pub async fn run_backfills(&self) -> Result<()> {
        // Backfill dimensions for existing photos (runs once)
        self.backfill_dimensions().await?;

        // Refine `is_animated` for rows seeded by migration 008 (runs once)
        self.backfill_animation_flags().await?;

        // Re-read EXIF text fields stored with quotes or missing dates (runs once)
        self.backfill_exif_text().await?;

        Ok(())
    }

    /// Re-read EXIF for photos imported while text fields were read through
    /// `display_value()`: camera and lens names were stored in quotes, no
    /// capture date ever parsed, and southern/western GPS refs never matched.
    /// Camera, lens and coordinates are replaced outright with what the file
    /// says now (old values may be quoted, sign-flipped or a bogus 0,0); the
    /// capture date only when the file yields one.
    async fn backfill_exif_text(&self) -> Result<()> {
        const FLAG: &str = "backfill_exif_text_v1";
        let done: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM _migration_flags WHERE name = ? AND completed_at > 0",
        )
        .bind(FLAG)
        .fetch_optional(&self.pool)
        .await?;
        if done.is_some() {
            return Ok(());
        }

        let rows = sqlx::query(
            "SELECT id, path FROM media_items WHERE kind = 'photo' \
             AND (captured_at IS NULL OR camera LIKE '\"%' OR lens LIKE '\"%' OR latitude IS NOT NULL)",
        )
        .fetch_all(&self.pool)
        .await?;
        for row in rows {
            let id: String = row.get("id");
            let path: String = row.get("path");
            let exif = tokio::task::spawn_blocking(move || {
                crate::commands::extract_exif(std::path::Path::new(&path))
            })
            .await?;
            if exif.metadata_error.is_some() {
                continue;
            }
            sqlx::query(
                "UPDATE media_items SET camera = ?, lens = ?, \
                 captured_at = COALESCE(?, captured_at), \
                 latitude = ?, longitude = ? \
                 WHERE id = ?",
            )
            .bind(&exif.camera)
            .bind(&exif.lens)
            .bind(exif.captured_at)
            .bind(exif.latitude)
            .bind(exif.longitude)
            .bind(&id)
            .execute(&self.pool)
            .await?;
        }

        sqlx::query("INSERT OR REPLACE INTO _migration_flags (name, completed_at) VALUES (?, ?)")
            .bind(FLAG)
            .bind(Utc::now().timestamp_millis())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// A second handle on the same pool, for background work.
    pub fn handle(&self) -> Self {
        Self {
            pool: self.pool.clone(),
        }
    }

    /// Re-classify `is_animated` for rows that predate content-based detection.
    ///
    /// Migration 008 seeds the flag from the filename (`.gif`), which is only a
    /// guess: it misses animated WebP/APNG/AVIF and flags static GIFs. This pass
    /// probes the actual container headers for every candidate extension and
    /// writes the real answer. Rows whose file cannot be read keep the
    /// filename fallback, so an offline drive cannot silently lose state; a
    /// later rescan corrects them.
    async fn backfill_animation_flags(&self) -> Result<()> {
        let done: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM _migration_flags WHERE name = 'backfill_animation_flags' AND completed_at > 0"
        )
        .fetch_optional(&self.pool)
        .await?;

        if done.is_some() {
            return Ok(());
        }

        let rows = sqlx::query(
            "SELECT id, path, extension, is_animated FROM media_items
             WHERE extension IN ('gif', 'webp', 'png', 'avif', 'heic', 'heif')",
        )
        .fetch_all(&self.pool)
        .await?;

        for row in rows {
            let id: String = row.get("id");
            let path: String = row.get("path");
            let extension: String = row.get("extension");
            let current: bool = row.get("is_animated");
            let detected = tokio::task::spawn_blocking(move || {
                crate::media_animation::detect_animation(std::path::Path::new(&path), &extension)
            })
            .await?;
            if detected == current {
                continue;
            }
            sqlx::query("UPDATE media_items SET is_animated = ? WHERE id = ?")
                .bind(if detected { 1i32 } else { 0i32 })
                .bind(&id)
                .execute(&self.pool)
                .await?;
        }

        sqlx::query(
            "INSERT OR REPLACE INTO _migration_flags (name, completed_at) VALUES ('backfill_animation_flags', ?)"
        )
        .bind(Utc::now().timestamp_millis())
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// Fill in width and height for rows imported without them.
    ///
    /// Version 2 of this backfill: the first one only covered photos the
    /// `image` crate can read, so HEIC/AVIF, RAW and video rows, plus JPEGs
    /// whose dimensions only EXIF knew, stayed empty. Unreadable files are
    /// skipped and keep NULL; a later rescan fills them in.
    async fn backfill_dimensions(&self) -> Result<()> {
        const FLAG: &str = "backfill_dimensions_v2";
        let done: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM _migration_flags WHERE name = ? AND completed_at > 0",
        )
        .bind(FLAG)
        .fetch_optional(&self.pool)
        .await?;
        if done.is_some() {
            return Ok(());
        }

        let rows = sqlx::query(
            "SELECT id, path, extension, kind FROM media_items \
             WHERE width IS NULL OR width = 0 OR height IS NULL OR height = 0",
        )
        .fetch_all(&self.pool)
        .await?;
        for row in rows {
            let id: String = row.get("id");
            let path: String = row.get("path");
            let extension: String = row.get("extension");
            let kind: String = row.get("kind");
            let dims = tokio::task::spawn_blocking(move || {
                let path = std::path::Path::new(&path);
                let kind_enum = crate::media_kind::MediaKind::parse_str(&kind)
                    .unwrap_or(crate::media_kind::MediaKind::Photo);
                let exif = if kind_enum == crate::media_kind::MediaKind::Photo {
                    let exif = crate::commands::extract_exif(path);
                    exif.width
                        .zip(exif.height)
                        .map(|(w, h)| (w.max(0) as u32, h.max(0) as u32))
                } else {
                    None
                };
                crate::media_dimensions::probe_dimensions(path, &extension, kind_enum, exif)
            })
            .await?;
            if let Some((w, h)) = dims {
                sqlx::query("UPDATE media_items SET width = ?, height = ? WHERE id = ?")
                    .bind(w as i32)
                    .bind(h as i32)
                    .bind(&id)
                    .execute(&self.pool)
                    .await?;
            }
        }

        sqlx::query("INSERT OR REPLACE INTO _migration_flags (name, completed_at) VALUES (?, ?)")
            .bind(FLAG)
            .bind(Utc::now().timestamp_millis())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

fn get_db_path(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("Failed to get app data dir: {}", e))?;

    Ok(app_dir.join("visto-gallery.db"))
}
