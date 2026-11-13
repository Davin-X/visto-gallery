use crate::errors::{CommandError, ErrorCode};
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

async fn open_read_only(path: &str) -> Result<SqliteConnection, CommandError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| CommandError::database(format!("Could not open backup '{}': {e}", path)))
}

/// Copy a user-selected catalog database to a temp file and return that path.
/// Opening/attaching only the isolated copy prevents SQLite from reading a
/// crafted sibling `-wal` file (RUSTSEC-2026-0459).
fn isolated_db_copy(path: &str) -> Result<IsolatedBackup, CommandError> {
    if !Path::new(path).is_file() {
        return Err(CommandError::not_found(format!(
            "Backup file not found: {path}"
        )));
    }
    let copy = IsolatedBackup {
        path: std::env::temp_dir().join(format!("visto-restore-{}.db", uuid::Uuid::new_v4())),
    };
    std::fs::copy(path, &copy.path)
        .map_err(|e| CommandError::io(format!("Could not read backup '{}': {e}", path)))?;
    Ok(copy)
}

/// A temporary copy of a user-picked backup. Dropping it deletes the copy and
/// any `-wal`, `-shm` or `-journal` file SQLite created next to it, on every
/// exit path, so a full catalog (with every file path in it) never lingers in
/// the temp folder.
struct IsolatedBackup {
    path: PathBuf,
}

impl IsolatedBackup {
    fn path_str(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    fn files(&self) -> [PathBuf; 4] {
        let side = |suffix: &str| {
            let mut name = self.path.clone().into_os_string();
            name.push(suffix);
            PathBuf::from(name)
        };
        [
            self.path.clone(),
            side("-wal"),
            side("-shm"),
            side("-journal"),
        ]
    }
}

impl Drop for IsolatedBackup {
    fn drop(&mut self) {
        for file in self.files() {
            let _ = std::fs::remove_file(file);
        }
    }
}

async fn table_exists(
    conn: &mut SqliteConnection,
    schema: &str,
    table: &str,
) -> Result<bool, CommandError> {
    let sql =
        format!("SELECT 1 FROM {schema}.sqlite_master WHERE type = 'table' AND name = ? LIMIT 1");
    let found: Option<i64> = sqlx::query_scalar(&sql)
        .bind(table)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(found.is_some())
}

/// Validate a snapshot without modifying it. Returns metadata only when the
/// file is a structurally sound, supported catalog backup.
async fn inspect_backup(path: &str) -> Result<BackupInfo, CommandError> {
    if !Path::new(path).is_file() {
        return Err(CommandError::not_found(format!(
            "Backup file not found: {path}"
        )));
    }
    let mut conn = open_read_only(path).await?;

    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| CommandError::database(format!("Could not verify backup: {e}")))?;
    if integrity != "ok" {
        return Err(CommandError::database(format!(
            "Backup failed its integrity check: {integrity}"
        )));
    }

    for table in REQUIRED_TABLES {
        if !table_exists(&mut conn, "main", table).await? {
            return Err(CommandError::invalid(format!(
                "This file is not a VistoGallery catalog backup (missing {table})."
            )));
        }
    }
    if !table_exists(&mut conn, "main", META_TABLE).await? {
        return Err(CommandError::invalid(
            "This file is not a versioned VistoGallery backup.".to_string(),
        ));
    }

    let (version, app_version, created_at): (i64, String, i64) =
        sqlx::query_as("SELECT version, app_version, created_at FROM visto_backup_meta LIMIT 1")
            .fetch_one(&mut conn)
            .await
            .map_err(|e| CommandError::database(format!("Could not read backup metadata: {e}")))?;
    if version != BACKUP_FORMAT_VERSION {
        return Err(CommandError::new(
            ErrorCode::UnsupportedFormat,
            format!(
                "Unsupported backup format {version}; this build restores version {BACKUP_FORMAT_VERSION}."
            ),
        ));
    }

    let item_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_items")
        .fetch_one(&mut conn)
        .await?;
    let album_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM albums")
        .fetch_one(&mut conn)
        .await?;
    let tag_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
        .fetch_one(&mut conn)
        .await?;
    let folder_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM library_folders")
        .fetch_one(&mut conn)
        .await?;

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
async fn snapshot_to(db: &SqlitePool, destination: &Path) -> Result<(), CommandError> {
    if destination.exists() {
        return Err(CommandError::invalid(format!(
            "A file already exists at '{}'. Choose a new backup name.",
            destination.display()
        )));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let destination = destination.to_string_lossy().into_owned();
    let escaped = destination.replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{escaped}'"))
        .execute(db)
        .await
        .map_err(|e| CommandError::database(format!("Could not create catalog snapshot: {e}")))?;
    Ok(())
}

async fn annotate_snapshot(path: &str) -> Result<(), CommandError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let mut conn = SqliteConnection::connect_with(&options).await?;
    sqlx::query(&format!(
        "CREATE TABLE IF NOT EXISTS {META_TABLE} (
            version INTEGER NOT NULL,
            app_version TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )"
    ))
    .execute(&mut conn)
    .await?;
    sqlx::query(&format!("DELETE FROM {META_TABLE}"))
        .execute(&mut conn)
        .await?;
    sqlx::query(&format!(
        "INSERT INTO {META_TABLE} (version, app_version, created_at) VALUES (?, ?, ?)"
    ))
    .bind(BACKUP_FORMAT_VERSION)
    .bind(env!("CARGO_PKG_VERSION"))
    .bind(super::now_ms())
    .execute(&mut conn)
    .await?;
    conn.close().await?;
    Ok(())
}

/// Write a versioned catalog backup to a user-chosen path.
#[tauri::command]
pub async fn create_catalog_backup(
    destination_path: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<BackupInfo, CommandError> {
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
pub async fn validate_catalog_backup(path: String) -> Result<BackupInfo, CommandError> {
    let isolated = isolated_db_copy(&path)?;
    inspect_backup(&isolated.path_str()).await
}

/// Copies one table between the two attached databases, keeping only the
/// columns the backup actually carries. Backups written by older builds may
/// lack columns this build has (e.g. hidden_reason before 2026-11); restore
/// what is present rather than fail the whole restore.
async fn copy_table(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &str,
    columns: &[&str],
) -> Result<(), CommandError> {
    let present: std::collections::HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT name FROM restore_src.pragma_table_info(?)")
            .bind(table)
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| CommandError::database(format!("Could not read {table}'s schema: {e}")))?
            .into_iter()
            .collect();
    let kept: Vec<String> = columns
        .iter()
        .filter(|column| present.contains(**column))
        .map(|column| column.to_string())
        .collect();
    if kept.is_empty() {
        return Ok(());
    }
    let columns = kept.join(", ");
    sqlx::query(&format!(
        "INSERT INTO {table} ({columns}) SELECT {columns} FROM restore_src.{table}"
    ))
    .execute(&mut **tx)
    .await
    .map_err(|e| CommandError::database(format!("Could not restore {table}: {e}")))?;
    Ok(())
}

async fn restore_backup_into_catalog(db: &SqlitePool, path: &str) -> Result<(), CommandError> {
    let mut conn = db.acquire().await?;
    sqlx::query("ATTACH DATABASE ? AS restore_src")
        .bind(path)
        .execute(&mut *conn)
        .await
        .map_err(|e| CommandError::database(format!("Could not attach the backup: {e}")))?;

    let restore = async {
        let mut tx = conn.begin().await?;

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
                .map_err(|e| CommandError::database(format!("Could not clear {statement}: {e}")))?;
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
                "hidden_reason",
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
            &["id", "name", "color_index", "created_at", "updated_at", "position"],
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

        tx.commit().await?;
        Ok::<(), CommandError>(())
    }
    .await;

    if let Err(error) = sqlx::query("DETACH DATABASE restore_src")
        .execute(&mut *conn)
        .await
    {
        // Never return a connection that still has `restore_src` attached to
        // the pool: every later query on it would unexpectedly see the
        // backup's tables. Closing retires the connection instead. The restore
        // itself is committed, so the caller still gets a success result.
        tracing::error!(
            "could not detach the restore database; closing the connection so the ATTACH cannot leak into the pool: {error}"
        );
        let _ = conn.close().await;
    }

    restore
}

/// Grant asset-protocol read access for every folder the catalog now lists,
/// returning the folders whose grant failed.
///
/// `library_folders` is replaced wholesale by a restore, but the asset scope is
/// only populated at startup and by each import. Without replaying the grants
/// here, a restored library renders as blank tiles through the asset protocol
/// until the next launch. Grant failures are reported, not fatal: the catalog
/// is already committed.
async fn grant_restored_folders<F>(
    db: &SqlitePool,
    mut grant: F,
) -> Result<Vec<String>, sqlx::Error>
where
    F: FnMut(&str) -> Result<(), String>,
{
    let folders: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders ORDER BY path")
        .fetch_all(db)
        .await?;
    Ok(folders
        .into_iter()
        .filter(|folder| grant(folder).is_err())
        .collect())
}

struct MissingPathReport {
    missing_item_count: i64,
    missing_paths: Vec<String>,
    missing_roots: Vec<String>,
}

/// Report media/roots that are no longer at the path stored in the backup.
/// Restore itself never rewrites paths.
async fn report_missing_paths(db: &SqlitePool) -> Result<MissingPathReport, CommandError> {
    let rows = sqlx::query("SELECT path FROM media_items ORDER BY path")
        .fetch_all(db)
        .await?;
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
        .await?;
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
) -> Result<RestoreResult, CommandError> {
    // Open/attach only an isolated copy of the user-picked backup so a crafted
    // sibling -wal file cannot be read (RUSTSEC-2026-0459).
    // The guard deletes the copy and its side files however this returns.
    let isolated = isolated_db_copy(&path)?;
    let isolated_path = isolated.path_str();
    let backup = inspect_backup(&isolated_path).await?;
    let db = super::get_db(&catalog)?;

    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::io(format!("Could not locate the app data folder: {e}")))?;
    let backup_dir = app_dir.join("backups");
    std::fs::create_dir_all(&backup_dir)?;
    let pre_restore_path = backup_dir.join(format!("pre-restore-{}.db", super::now_ms()));
    snapshot_to(&db, &pre_restore_path).await?;
    let pre_restore_path_string = pre_restore_path.to_string_lossy().into_owned();
    if let Err(error) = annotate_snapshot(&pre_restore_path_string).await {
        let _ = std::fs::remove_file(&pre_restore_path);
        return Err(error);
    }

    restore_backup_into_catalog(&db, &isolated_path).await?;
    drop(isolated);

    // The restore replaced `library_folders`, so replay those paths into the
    // asset scope before returning a catalog whose media the UI cannot render.
    match grant_restored_folders(&db, |folder| {
        app.asset_protocol_scope()
            .allow_directory(folder, true)
            .map_err(|error| error.to_string())
    })
    .await
    {
        Ok(failed) if failed.is_empty() => {}
        Ok(failed) => tracing::error!(
            "restored folders could not be granted to the asset protocol scope: {failed:?}"
        ),
        Err(error) => {
            tracing::error!("could not read restored folders to grant asset scope: {error}")
        }
    }

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
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at INTEGER, width INTEGER, height INTEGER, camera TEXT, lens TEXT, exposure TEXT, iso INTEGER, latitude REAL, longitude REAL, sha256 TEXT, favorite INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, hidden_reason TEXT, is_animated INTEGER NOT NULL DEFAULT 0, content_signature TEXT, import_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rating INTEGER, color_label TEXT)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color_index INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0)")
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

    /// Every database currently visible on the pool's connection. `restore_src`
    /// must never be among them: the pool connection is reused by later
    /// queries, so a leaked ATTACH would silently expose the backup.
    async fn attached_databases(db: &SqlitePool) -> Vec<String> {
        sqlx::query("PRAGMA database_list")
            .fetch_all(db)
            .await
            .expect("list attached databases")
            .into_iter()
            .map(|row| row.get::<String, _>("name"))
            .collect()
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
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.message.contains("not a VistoGallery catalog backup"));
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
        assert_eq!(error.code, ErrorCode::UnsupportedFormat);
        assert!(error.message.contains("Unsupported backup format 99"));
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
        assert_eq!(
            attached_databases(&db).await,
            vec!["main".to_string()],
            "the restore source must be detached before the connection is reused"
        );
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
        assert!(
            error.message.contains("smart_albums"),
            "unexpected error: {error}"
        );
        assert_eq!(
            attached_databases(&db).await,
            vec!["main".to_string()],
            "a failed restore must still detach its source before reuse"
        );

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

    #[tokio::test]
    async fn grant_restored_folders_grants_each_folder_and_reports_failures() {
        let (db, catalog_path) = catalog_db().await;
        for folder in ["/library/one", "/library/two", "/library/three"] {
            sqlx::query("INSERT INTO library_folders (path, added_at) VALUES (?, 0)")
                .bind(folder)
                .execute(&db)
                .await
                .unwrap();
        }

        let mut granted = Vec::new();
        let failed = grant_restored_folders(&db, |folder| {
            granted.push(folder.to_string());
            if folder == "/library/two" {
                Err("scope refused".to_string())
            } else {
                Ok(())
            }
        })
        .await
        .unwrap();

        assert_eq!(
            granted,
            ["/library/one", "/library/three", "/library/two"],
            "every restored folder is offered to the scope, not just the first"
        );
        assert_eq!(
            failed,
            ["/library/two".to_string()],
            "a refused folder is reported so it can be logged"
        );

        db.close().await;
        let _ = std::fs::remove_file(catalog_path);
    }

    #[test]
    fn isolated_copy_removes_itself_and_sqlite_side_files() {
        let source = temp_backup("isolated-source");
        std::fs::write(&source, b"not really sqlite").unwrap();
        let copy = super::isolated_db_copy(source.to_str().unwrap()).expect("copy");
        let files = copy.files();
        for side in &files[1..] {
            std::fs::write(side, b"side").unwrap();
        }
        assert!(files.iter().all(|f| f.exists()));

        drop(copy);

        assert!(files.iter().all(|f| !f.exists()), "{files:?}");
        assert!(source.exists(), "the user's backup is never touched");
        let _ = std::fs::remove_file(&source);
    }

    #[tokio::test]
    async fn restored_albums_keep_the_custom_order() {
        let (db, catalog_path) = catalog_db().await;
        // Custom order differs from creation order.
        sqlx::query("INSERT INTO albums (id, name, created_at, updated_at, position) VALUES ('al-a', 'Alpha', 1, 1, 2)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO albums (id, name, created_at, updated_at, position) VALUES ('al-b', 'Beta', 2, 2, 1)")
            .execute(&db)
            .await
            .unwrap();

        let backup_path = temp_backup("album-order");
        snapshot_to(&db, &backup_path).await.unwrap();
        annotate_snapshot(backup_path.to_str().unwrap()).await.unwrap();

        // Scramble the live order, then restore the snapshot. The custom
        // order must come back, not Alpha-then-Beta.
        sqlx::query("UPDATE albums SET position = 2 WHERE id = 'al-b'")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("UPDATE albums SET position = 1 WHERE id = 'al-a'")
            .execute(&db)
            .await
            .unwrap();

        restore_backup_into_catalog(&db, backup_path.to_str().unwrap())
            .await
            .unwrap();

        let names: Vec<String> =
            sqlx::query_scalar("SELECT name FROM albums ORDER BY position ASC")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(names, vec!["Beta".to_string(), "Alpha".to_string()]);

        db.close().await;
        let _ = std::fs::remove_file(backup_path);
        let _ = std::fs::remove_file(catalog_path);
    }

    #[test]
    fn isolated_copy_of_missing_backup_is_not_found() {
        assert!(super::isolated_db_copy("/visto/no/such/backup.db").is_err());
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
