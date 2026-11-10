use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqlitePool};
use sqlx::{Connection, Row};
use std::path::{Path, PathBuf};
use tauri::{Manager, State};
use ts_rs::TS;

/// Bump only when the on-disk backup contract changes. Restore rejects any
/// other version instead of guessing.
const BACKUP_FORMAT_VERSION: i64 = 1;
const META_TABLE: &str = "visto_backup_meta";

const REQUIRED_TABLES: &[&str] = &[
    "media_items",
    "albums",
    "album_items",
    "tags",
    "media_tags",
    "library_folders",
];

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub version: i64,
    pub app_version: String,
    pub created_at: i64,
    pub item_count: i64,
    pub album_count: i64,
    pub tag_count: i64,
    pub folder_count: i64,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub backup: BackupInfo,
    pub pre_restore_backup: String,
    pub missing_item_count: i64,
    pub missing_paths: Vec<String>,
    pub missing_roots: Vec<String>,
}

async fn open_read_only(path: &str) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| format!("Could not open backup '{}': {e}", path))
}

/// Copy a user-selected catalog database to a temp file and return that path.
/// Opening/attaching only the isolated copy prevents SQLite from reading a
/// crafted sibling `-wal` file (RUSTSEC-2026-0459).
fn isolated_db_copy(path: &str) -> Result<PathBuf, String> {
    if !Path::new(path).is_file() {
        return Err(format!("Backup file not found: {path}"));
    }
    let tmp = std::env::temp_dir().join(format!("visto-restore-{}.db", uuid::Uuid::new_v4()));
    std::fs::copy(path, &tmp).map_err(|e| format!("Could not read backup '{}': {e}", path))?;
    Ok(tmp)
}

async fn table_exists(
    conn: &mut SqliteConnection,
    schema: &str,
    table: &str,
) -> Result<bool, String> {
    let sql =
        format!("SELECT 1 FROM {schema}.sqlite_master WHERE type = 'table' AND name = ? LIMIT 1");
    let found: Option<i64> = sqlx::query_scalar(&sql)
        .bind(table)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(found.is_some())
}

/// Validate a snapshot without modifying it. Returns metadata only when the
/// file is a structurally sound, supported catalog backup.
async fn inspect_backup(path: &str) -> Result<BackupInfo, String> {
    if !Path::new(path).is_file() {
        return Err(format!("Backup file not found: {path}"));
    }
    let mut conn = open_read_only(path).await?;

    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| format!("Could not verify backup: {e}"))?;
    if integrity != "ok" {
        return Err(format!("Backup failed its integrity check: {integrity}"));
    }

    for table in REQUIRED_TABLES {
        if !table_exists(&mut conn, "main", table).await? {
            return Err(format!(
                "This file is not a VistoGallery catalog backup (missing {table})."
            ));
        }
    }
    if !table_exists(&mut conn, "main", META_TABLE).await? {
        return Err("This file is not a versioned VistoGallery backup.".to_string());
    }

    let (version, app_version, created_at): (i64, String, i64) =
        sqlx::query_as("SELECT version, app_version, created_at FROM visto_backup_meta LIMIT 1")
            .fetch_one(&mut conn)
            .await
            .map_err(|e| format!("Could not read backup metadata: {e}"))?;
    if version != BACKUP_FORMAT_VERSION {
        return Err(format!(
            "Unsupported backup format {version}; this build restores version {BACKUP_FORMAT_VERSION}."
        ));
    }

    let item_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_items")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let album_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM albums")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let tag_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let folder_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_folders")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(BackupInfo {
        path: path.to_string(),
        version,
        app_version,
        created_at,
        item_count,
        album_count,
        tag_count,
        folder_count,
    })
}

/// Create a consistent snapshot (including committed WAL content) without
/// touching original media or the live catalog.
async fn snapshot_to(db: &SqlitePool, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Err(format!(
            "A file already exists at '{}'. Choose a new backup name.",
            destination.display()
        ));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let destination = destination.to_string_lossy().into_owned();
    let escaped = destination.replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{escaped}'"))
        .execute(db)
        .await
        .map_err(|e| format!("Could not create catalog snapshot: {e}"))?;
    Ok(())
}

async fn annotate_snapshot(path: &str) -> Result<(), String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query(&format!(
        "CREATE TABLE IF NOT EXISTS {META_TABLE} (
            version INTEGER NOT NULL,
            app_version TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )"
    ))
    .execute(&mut conn)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(&format!("DELETE FROM {META_TABLE}"))
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query(&format!(
        "INSERT INTO {META_TABLE} (version, app_version, created_at) VALUES (?, ?, ?)"
    ))
    .bind(BACKUP_FORMAT_VERSION)
    .bind(env!("CARGO_PKG_VERSION"))
    .bind(super::now_ms())
    .execute(&mut conn)
    .await
    .map_err(|e| e.to_string())?;
    conn.close().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Write a versioned catalog backup to a user-chosen path.
#[tauri::command]
pub async fn create_catalog_backup(
    destination_path: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<BackupInfo, String> {
    let db = super::get_db(&catalog)?;
    let destination = PathBuf::from(&destination_path);
    snapshot_to(&db, &destination).await?;
    if let Err(error) = annotate_snapshot(&destination_path).await {
        let _ = std::fs::remove_file(&destination);
        return Err(error);
    }
    inspect_backup(&destination_path).await
}

/// Validate a path the user picked before showing a destructive confirmation.
#[tauri::command]
pub async fn validate_catalog_backup(path: String) -> Result<BackupInfo, String> {
    let isolated = isolated_db_copy(&path)?;
    let result = inspect_backup(isolated.to_string_lossy().as_ref()).await;
    let _ = std::fs::remove_file(&isolated);
    result
}

async fn copy_table(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &str,
    columns: &[&str],
) -> Result<(), String> {
    let columns = columns.join(", ");
    sqlx::query(&format!(
        "INSERT INTO {table} ({columns}) SELECT {columns} FROM restore_src.{table}"
    ))
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("Could not restore {table}: {e}"))?;
    Ok(())
}

async fn restore_backup_into_catalog(db: &SqlitePool, path: &str) -> Result<(), String> {
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;
    sqlx::query("ATTACH DATABASE ? AS restore_src")
        .bind(path)
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("Could not attach the backup: {e}"))?;

    let restore = async {
        let mut tx = conn.begin().await.map_err(|e| e.to_string())?;

        // Clear dependent rows first. Foreign keys are enabled on this pool.
        for statement in [
            "DELETE FROM edit_backups",
            "DELETE FROM edit_recipes",
            "DELETE FROM smart_albums",
            "DELETE FROM media_tags",
            "DELETE FROM album_items",
            "DELETE FROM media_items",
            "DELETE FROM albums",
            "DELETE FROM tags",
            "DELETE FROM library_folders",
        ] {
            sqlx::query(statement)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("Could not clear {statement}: {e}"))?;
        }

        copy_table(
            &mut tx,
            "media_items",
            &[
                "id",
                "path",
                "name",
                "extension",
                "kind",
                "size",
                "modified_at",
                "captured_at",
                "width",
                "height",
                "camera",
                "lens",
                "exposure",
                "iso",
                "latitude",
                "longitude",
                "sha256",
                "favorite",
                "hidden",
                "import_session_id",
                "created_at",
                "updated_at",
                "rating",
                "color_label",
            ],
        )
        .await?;
        copy_table(
            &mut tx,
            "albums",
            &["id", "name", "color_index", "created_at", "updated_at"],
        )
        .await?;
        copy_table(
            &mut tx,
            "tags",
            &["id", "name", "color_index", "created_at"],
        )
        .await?;
        copy_table(&mut tx, "library_folders", &["path", "added_at"]).await?;
        copy_table(&mut tx, "media_tags", &["media_id", "tag_id"]).await?;
        copy_table(
            &mut tx,
            "album_items",
            &["album_id", "media_id", "added_at"],
        )
        .await?;

        if table_exists(&mut tx, "restore_src", "edit_recipes").await? {
            copy_table(
                &mut tx,
                "edit_recipes",
                &[
                    "media_id",
                    "edits",
                    "crop",
                    "history",
                    "history_index",
                    "created_at",
                    "updated_at",
                ],
            )
            .await?;
        }
        if table_exists(&mut tx, "restore_src", "smart_albums").await? {
            copy_table(
                &mut tx,
                "smart_albums",
                &["id", "name", "filter_json", "created_at", "updated_at"],
            )
            .await?;
        }
        if table_exists(&mut tx, "restore_src", "edit_backups").await? {
            copy_table(
                &mut tx,
                "edit_backups",
                &[
                    "media_id",
                    "original_path",
                    "backup_path",
                    "size",
                    "sha256",
                    "created_at",
                ],
            )
            .await?;
        }

        tx.commit().await.map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    }
    .await;

    let _ = sqlx::query("DETACH DATABASE restore_src")
        .execute(&mut *conn)
        .await;

    restore
}

struct MissingPathReport {
    missing_item_count: i64,
    missing_paths: Vec<String>,
    missing_roots: Vec<String>,
}

/// Report media/roots that are no longer at the path stored in the backup.
/// Restore itself never rewrites paths.
async fn report_missing_paths(db: &SqlitePool) -> Result<MissingPathReport, String> {
    let rows = sqlx::query("SELECT path FROM media_items ORDER BY path")
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    let mut missing_paths = Vec::new();
    let mut missing_item_count = 0i64;
    for row in rows {
        let item_path: String = row.get("path");
        if !Path::new(&item_path).exists() {
            missing_item_count += 1;
            if missing_paths.len() < 50 {
                missing_paths.push(item_path);
            }
        }
    }

    let root_rows = sqlx::query("SELECT path FROM library_folders ORDER BY path")
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    let missing_roots: Vec<String> = root_rows
        .into_iter()
        .map(|row| row.get::<String, _>("path"))
        .filter(|root| !Path::new(root).exists())
        .collect();

    Ok(MissingPathReport {
        missing_item_count,
        missing_paths,
        missing_roots,
    })
}

/// Restore catalog organization from a validated backup.
///
/// The live database is updated inside one transaction on a dedicated
/// connection after the backup is ATTACHed. A malformed backup therefore rolls
/// back to the pre-restore catalog, and a pre-restore snapshot is retained on
/// disk as a second safety net. Original media files are never touched.
#[tauri::command]
pub async fn restore_catalog_backup(
    path: String,
    app: tauri::AppHandle,
    catalog: State<'_, crate::Catalog>,
) -> Result<RestoreResult, String> {
    // Open/attach only an isolated copy of the user-picked backup so a crafted
    // sibling -wal file cannot be read (RUSTSEC-2026-0459).
    let isolated = isolated_db_copy(&path)?;
    let isolated_path = isolated.to_string_lossy().into_owned();
    let backup = match inspect_backup(&isolated_path).await {
        Ok(info) => info,
        Err(error) => {
            let _ = std::fs::remove_file(&isolated);
            return Err(error);
        }
    };
    let db = super::get_db(&catalog)?;

    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not locate the app data folder: {e}"))?;
    let backup_dir = app_dir.join("backups");
    std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    let pre_restore_path = backup_dir.join(format!("pre-restore-{}.db", super::now_ms()));
    snapshot_to(&db, &pre_restore_path).await?;
    let pre_restore_path_string = pre_restore_path.to_string_lossy().into_owned();
    if let Err(error) = annotate_snapshot(&pre_restore_path_string).await {
        let _ = std::fs::remove_file(&pre_restore_path);
        let _ = std::fs::remove_file(&isolated);
        return Err(error);
    }

    let restore = restore_backup_into_catalog(&db, &isolated_path).await;
    let _ = std::fs::remove_file(&isolated);
    restore?;
    // The snapshot just taken is the newest, so it always survives pruning.
    prune_pre_restore_snapshots(&backup_dir, PRE_RESTORE_SNAPSHOTS_KEPT);
    let missing = report_missing_paths(&db).await?;

    Ok(RestoreResult {
        backup,
        pre_restore_backup: pre_restore_path_string,
        missing_item_count: missing.missing_item_count,
        missing_paths: missing.missing_paths,
        missing_roots: missing.missing_roots,
    })
}

/// Pre-restore snapshots are a safety net for the latest restores, not an
/// archive: keep this many and delete older ones.
const PRE_RESTORE_SNAPSHOTS_KEPT: usize = 5;

/// Delete all but the `keep` newest `pre-restore-<ms>.db` files in `dir`.
/// Files with any other name are never touched. Best effort: a file that
/// cannot be removed is left for the next restore.
fn prune_pre_restore_snapshots(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut snapshots: Vec<(i64, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let stamp = name.strip_prefix("pre-restore-")?.strip_suffix(".db")?;
            Some((stamp.parse::<i64>().ok()?, entry.path()))
        })
        .collect();
    snapshots.sort_by_key(|(stamp, _)| std::cmp::Reverse(*stamp));
    for (_, path) in snapshots.into_iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
}

/// Tests build small in-memory catalogs with the production migration set and
/// exercise the same snapshot/validation/copy helpers used by the commands.
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn catalog_db() -> (SqlitePool, PathBuf) {
        let catalog_path = temp_backup("catalog");
        let options = SqliteConnectOptions::new()
            .filename(&catalog_path)
            .create_if_missing(true);
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open catalog");
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at INTEGER, width INTEGER, height INTEGER, camera TEXT, lens TEXT, exposure TEXT, iso INTEGER, latitude REAL, longitude REAL, sha256 TEXT, favorite INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, is_animated INTEGER NOT NULL DEFAULT 0, content_signature TEXT, import_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rating INTEGER, color_label TEXT)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color_index INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color_index INTEGER DEFAULT 0, created_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE media_tags (media_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (media_id, tag_id))")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE album_items (album_id TEXT NOT NULL, media_id TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (album_id, media_id))")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE library_folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE edit_recipes (media_id TEXT PRIMARY KEY, edits TEXT NOT NULL, crop TEXT, history TEXT NOT NULL, history_index INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE edit_backups (media_id TEXT PRIMARY KEY, original_path TEXT NOT NULL, backup_path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT, created_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE smart_albums (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, filter_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        (db, catalog_path)
    }

    fn temp_backup(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "visto-backup-test-{label}-{}.db",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[tokio::test]
    async fn snapshot_round_trips_catalog_metadata() {
        let (db, catalog_path) = catalog_db().await;
        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at, rating, color_label) VALUES ('m1', '/tmp/a.jpg', 'a.jpg', 'jpg', 'photo', 10, 1, 1, 1, 4, 'blue')")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO albums (id, name, created_at, updated_at) VALUES ('al1', 'Trip', 1, 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO album_items (album_id, media_id, added_at) VALUES ('al1', 'm1', 1)",
        )
        .execute(&db)
        .await
        .unwrap();

        let path = temp_backup("roundtrip");
        snapshot_to(&db, &path).await.unwrap();
        annotate_snapshot(path.to_str().unwrap()).await.unwrap();
        let info = inspect_backup(path.to_str().unwrap()).await.unwrap();
        assert_eq!(info.version, BACKUP_FORMAT_VERSION);
        assert_eq!(info.item_count, 1);
        assert_eq!(info.album_count, 1);
        db.close().await;
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(catalog_path);
    }

    #[tokio::test]
    async fn rejects_a_non_catalog_sqlite_file() {
        let path = temp_backup("invalid");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE unrelated (id INTEGER)")
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();

        let error = inspect_backup(path.to_str().unwrap()).await.unwrap_err();
        assert!(error.contains("not a VistoGallery catalog backup"));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn rejects_an_unsupported_version() {
        let (db, catalog_path) = catalog_db().await;
        let path = temp_backup("version");
        snapshot_to(&db, &path).await.unwrap();
        annotate_snapshot(path.to_str().unwrap()).await.unwrap();
        let options = SqliteConnectOptions::new().filename(&path);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("UPDATE visto_backup_meta SET version = 99")
            .execute(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();

        let error = inspect_backup(path.to_str().unwrap()).await.unwrap_err();
        assert!(error.contains("Unsupported backup format 99"));
        db.close().await;
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(catalog_path);
    }

    async fn insert_catalog_item(db: &SqlitePool, id: &str, path: &str) {
        sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at, rating, color_label) VALUES (?, ?, 'a.jpg', 'jpg', 'photo', 10, 1, 1, 1, 4, 'blue')")
            .bind(id)
            .bind(path)
            .execute(db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn restore_replaces_catalog_without_touching_media_file() {
        let media_path = temp_backup("media");
        std::fs::write(&media_path, b"not an actual jpeg, just fixture bytes").unwrap();
        let media = std::fs::metadata(&media_path).unwrap();
        let modified_before = media.modified().unwrap();

        let (db, catalog_path) = catalog_db().await;
        insert_catalog_item(&db, "m1", media_path.to_str().unwrap()).await;
        let backup_path = temp_backup("restore");
        snapshot_to(&db, &backup_path).await.unwrap();
        annotate_snapshot(backup_path.to_str().unwrap())
            .await
            .unwrap();

        sqlx::query("UPDATE media_items SET path = '/different/path.jpg' WHERE id = 'm1'")
            .execute(&db)
            .await
            .unwrap();

        restore_backup_into_catalog(&db, backup_path.to_str().unwrap())
            .await
            .unwrap();
        let restored_path: String =
            sqlx::query_scalar("SELECT path FROM media_items WHERE id = 'm1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(restored_path, media_path.to_str().unwrap());
        let modified_after = std::fs::metadata(&media_path).unwrap().modified().unwrap();
        assert_eq!(modified_after, modified_before);
        assert_eq!(
            std::fs::read(&media_path).unwrap(),
            b"not an actual jpeg, just fixture bytes"
        );

        db.close().await;
        let _ = std::fs::remove_file(media_path);
        let _ = std::fs::remove_file(backup_path);
        let _ = std::fs::remove_file(catalog_path);
    }

    #[tokio::test]
    async fn interrupted_restore_rolls_back_to_the_current_catalog() {
        let (db, catalog_path) = catalog_db().await;
        insert_catalog_item(&db, "m1", "/current/photo.jpg").await;
        let backup_path = temp_backup("rollback");
        snapshot_to(&db, &backup_path).await.unwrap();
        annotate_snapshot(backup_path.to_str().unwrap())
            .await
            .unwrap();

        sqlx::query("UPDATE media_items SET path = '/current/changed.jpg' WHERE id = 'm1'")
            .execute(&db)
            .await
            .unwrap();

        // Replace only the optional Smart Album table with an incompatible
        // shape. Validation does not require this table, so restore reaches
        // the copy step and fails inside the transaction.
        let mut backup =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&backup_path))
                .await
                .unwrap();
        sqlx::query("DROP TABLE smart_albums")
            .execute(&mut backup)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE smart_albums (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&mut backup)
            .await
            .unwrap();
        backup.close().await.unwrap();

        let error = restore_backup_into_catalog(&db, backup_path.to_str().unwrap())
            .await
            .unwrap_err();
        assert!(error.contains("smart_albums"), "unexpected error: {error}");

        let current_path: String =
            sqlx::query_scalar("SELECT path FROM media_items WHERE id = 'm1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(current_path, "/current/changed.jpg");

        db.close().await;
        let _ = std::fs::remove_file(catalog_path);
        let _ = std::fs::remove_file(backup_path);
    }

    #[test]
    fn prune_keeps_newest_snapshots_and_ignores_other_files() {
        let dir = temp_backup("prune-dir");
        std::fs::create_dir_all(&dir).unwrap();
        for stamp in [100, 300, 200, 500, 400] {
            std::fs::write(dir.join(format!("pre-restore-{stamp}.db")), b"x").unwrap();
        }
        std::fs::write(dir.join("my-backup.db"), b"keep").unwrap();

        super::prune_pre_restore_snapshots(&dir, 2);

        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["my-backup.db", "pre-restore-400.db", "pre-restore-500.db"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
