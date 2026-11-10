mod access;
mod albums;
mod backup;
mod batch;
mod batch_pipeline;
mod cancel;
mod duplicates;
mod edit_recipes;
mod finder_tags;
mod import_pipeline;
mod library;
mod media;
mod roots;
mod scan_jobs;
mod settings;
mod smart_albums;
mod system;
mod temp_files;
mod update;
use crate::errors::{CommandError, ErrorCode};
use crate::{models::*, Catalog};
pub use albums::*;
use anyhow::Result;
pub use backup::*;
pub use batch::*;
#[allow(unused_imports)]
pub(crate) use batch_pipeline::{export_batch_item, render_batch_filename};
pub use cancel::{cancel_move_to_trash, cancel_scan};
pub(crate) use cancel::{BATCH_CANCEL, DUPLICATE_CANCEL, TRASH_CANCEL};
pub use duplicates::*;
pub use edit_recipes::*;
pub use finder_tags::{merge_finder_tags, read_finder_tags, write_finder_tags};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageDecoder};
pub use import_pipeline::supported_extensions;
#[allow(unused_imports)]
pub(crate) use import_pipeline::{
    file_modified_at, import_media_file, inspect_media_file_with_metadata, is_media_file,
    prune_missing_items, remember_folder, upsert_media_batch, LIBRARY_COUNTS_CHANGED,
};
#[allow(unused_imports)]
pub(crate) use import_pipeline::{inspect_media_file, kind_for_ext};
pub use library::*;
pub use media::*;
use notify::Watcher;
pub use roots::*;
pub use scan_jobs::ScanJobs;
pub use settings::*;
pub use smart_albums::*;
use sqlx::{Row, Sqlite, SqlitePool};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
pub use system::{get_version, open_external};
use tauri::{AppHandle, Emitter, Manager, State};
pub use temp_files::*;
use time::OffsetDateTime;
pub use update::*;
use uuid::Uuid;

// ===== Request/Response Types =====
//
// Every struct that crosses the IPC boundary is annotated `rename_all =
// "camelCase"`, so Rust's snake_case fields line up with the TypeScript
// interfaces in src/engine/types. Commands take plain (flattened) arguments
// rather than a wrapper struct, because that is what the flat camelCase
// payloads in src/engine/commands/tauri.ts send.

mod dto;
pub(crate) mod repo;
pub mod security;
pub use dto::*;
pub use repo::{delete_library_database, get_tags};
pub(crate) use repo::{relink_moved_items, ALBUM_SELECT, TAG_SELECT};
// ===== Helper Functions =====

pub(crate) fn get_db(catalog: &State<'_, Catalog>) -> Result<SqlitePool, CommandError> {
    catalog.pool()
}

pub(crate) fn now_ms() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

/// Normalize a folder path so comparisons do not depend on a trailing slash.
pub(crate) use security::paths::{
    authorize_import_path, is_path_under_registered_roots, normalize_root, path_is_inside,
};
pub use security::paths::{
    pick_media_files, pick_source_folders, validate_path_under_registered_roots, GrantedPaths,
};

/// Event asking the frontend to re-read catalog-wide counts.
///
/// `library-changed` is only emitted when rows are removed, and scans/imports
/// emit progress events only, so the sidebar and the type-chip counts used to
/// describe the catalog from before the import. Emitting this from the commands
/// that add rows covers every caller — picker, drag-and-drop, watch-folder
/// rescan — instead of relying on each UI path to refresh itself.
/// Replace characters macOS rejects in filenames and collapse whitespace.
pub(crate) fn apply_setting(settings: &mut AppSettings, key: &str, value: &str) {
    match key {
        "appearance" => settings.appearance = value.parse().unwrap_or_default(),
        "accent_color" => settings.accent_color = value.parse().unwrap_or_default(),
        "sidebar_width" => settings.sidebar_width = value.parse().unwrap_or(220),
        "inspector_width" => settings.inspector_width = value.parse().unwrap_or(300),
        "show_extensions" => settings.show_extensions = value.parse().unwrap_or(false),
        "animate_transitions" => settings.animate_transitions = value.parse().unwrap_or(true),
        "startup_view" => settings.startup_view = value.parse().unwrap_or_default(),
        "open_last_folder" => settings.open_last_folder = value.parse().unwrap_or(true),
        "restore_window_state" => settings.restore_window_state = value.parse().unwrap_or(true),
        "default_layout" => settings.default_layout = value.parse().unwrap_or_default(),
        "thumbnail_size" => settings.thumbnail_size = value.parse().unwrap_or_default(),
        "viewer_zoom_behavior" => settings.viewer_zoom_behavior = value.parse().unwrap_or_default(),
        "slideshow_interval" => settings.slideshow_interval = value.parse().unwrap_or(5),
        "slideshow_shuffle" => settings.slideshow_shuffle = value.parse().unwrap_or(false),
        "slideshow_loop" => settings.slideshow_loop = value.parse().unwrap_or(true),
        "video_auto_play" => settings.video_auto_play = value.parse().unwrap_or(true),
        "video_loop" => settings.video_loop = value.parse().unwrap_or(false),
        "watch_folders" => {
            settings.watch_folders = serde_json::from_str(value).unwrap_or_default();
        }
        "auto_import" => settings.auto_import = value.parse().unwrap_or(false),
        "pair_raw_jpeg" => settings.pair_raw_jpeg = value.parse().unwrap_or(true),
        "stack_bursts" => settings.stack_bursts = value.parse().unwrap_or(true),
        "stack_live_photos" => settings.stack_live_photos = value.parse().unwrap_or(true),
        "check_for_updates_on_launch" => {
            settings.check_for_updates_on_launch = value.parse().unwrap_or(false)
        }
        "max_cache_size_gb" => settings.max_cache_size_gb = value.parse().unwrap_or(5),
        "thumbnail_quality" => settings.thumbnail_quality = value.parse().unwrap_or(80),
        "enable_debug_logging" => settings.enable_debug_logging = value.parse().unwrap_or(false),
        "show_native_limit_warnings" => {
            settings.show_native_limit_warnings = value.parse().unwrap_or(true)
        }
        _ => {}
    }
}

#[cfg(test)]
mod path_validation_tests {
    use super::validate_path_under_registered_roots;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn tmp(label: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("visto-path-test-{}-{}", label, Uuid::new_v4()));
        fs::create_dir_all(&p).expect("create temp dir");
        p
    }

    #[test]
    fn empty_roots_denies_everything() {
        let root = tmp("root");
        let file = root.join("a.jpg");
        fs::write(&file, b"x").unwrap();
        assert!(validate_path_under_registered_roots(file.to_str().unwrap(), &[]).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn legitimate_nested_path_passes() {
        let root = tmp("root");
        let nested = root.join("sub").join("a.jpg");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, b"x").unwrap();
        let registered = vec![root.to_string_lossy().into_owned()];
        assert!(
            validate_path_under_registered_roots(nested.to_str().unwrap(), &registered).is_ok()
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn traversal_is_rejected() {
        let root = tmp("root");
        let outside = std::env::temp_dir().join("visto-outside-traversal.jpg");
        fs::write(&outside, b"x").unwrap();
        // A `..` segment that escapes the root must be rejected.
        let escape = root.join("..").join(outside.file_name().unwrap());
        let registered = vec![root.to_string_lossy().into_owned()];
        assert!(
            validate_path_under_registered_roots(escape.to_str().unwrap(), &registered).is_err()
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn prefix_collision_is_rejected() {
        let base = tmp("base");
        let photos = base.join("Photos");
        let photos2 = base.join("Photos2");
        fs::create_dir_all(&photos).unwrap();
        fs::create_dir_all(&photos2).unwrap();
        let file = photos2.join("a.jpg");
        fs::write(&file, b"x").unwrap();
        let registered = vec![photos.to_string_lossy().into_owned()];
        assert!(validate_path_under_registered_roots(file.to_str().unwrap(), &registered).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn symlink_escape_is_rejected() {
        let root = tmp("root");
        let outside = tmp("outside");
        let outside_file = outside.join("secret.jpg");
        fs::write(&outside_file, b"x").unwrap();
        let link = root.join("escape.jpg");
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(&outside_file, &link);
        let registered = vec![root.to_string_lossy().into_owned()];
        // The symlink resolves outside the root, so it must be rejected.
        let result = validate_path_under_registered_roots(link.to_str().unwrap(), &registered);
        assert!(result.is_err(), "symlink escape should be rejected");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn exact_root_path_passes() {
        let root = tmp("root");
        let file = root.join("a.jpg");
        fs::write(&file, b"x").unwrap();
        let registered = vec![root.to_string_lossy().into_owned()];
        // The root directory itself is allowed.
        assert!(validate_path_under_registered_roots(root.to_str().unwrap(), &registered).is_ok());
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod rescan_preservation_tests {
    use super::upsert_media_batch;
    use crate::models::MediaItem;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn media_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at INTEGER, width INTEGER, height INTEGER, camera TEXT, lens TEXT, exposure TEXT, iso INTEGER, latitude REAL, longitude REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, favorite INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, is_animated INTEGER NOT NULL DEFAULT 0, content_signature TEXT, sha256 TEXT, rating INTEGER, color_label TEXT)")
            .execute(&db)
            .await
            .expect("create media_items");
        db
    }

    #[tokio::test]
    async fn forced_rescan_preserves_favorite_and_hidden() {
        let db = media_db().await;
        let path = "/tmp/rescan-preserve.jpg".to_string();
        let item = MediaItem::new(
            path.clone(),
            "photo.jpg".into(),
            "jpg".into(),
            "photo".into(),
            10,
            1000,
        );
        upsert_media_batch(&db, &[(item.clone(), Some(800), Some(600))])
            .await
            .expect("initial upsert");

        // The user curates the item.
        sqlx::query("UPDATE media_items SET favorite = 1, hidden = 1 WHERE id = ?")
            .bind(&item.id)
            .execute(&db)
            .await
            .expect("curate");

        // A forced rescan re-upserts the same row.
        let rescanned = MediaItem::new(
            path,
            "photo.jpg".into(),
            "jpg".into(),
            "photo".into(),
            10,
            1000,
        );
        upsert_media_batch(&db, &[(rescanned, Some(800), Some(600))])
            .await
            .expect("rescan upsert");

        let (favorite, hidden): (i64, i64) =
            sqlx::query_as("SELECT favorite, hidden FROM media_items WHERE id = ?")
                .bind(&item.id)
                .fetch_one(&db)
                .await
                .expect("read back");
        assert_eq!(favorite, 1, "favorite must survive a forced rescan");
        assert_eq!(hidden, 1, "hidden must survive a forced rescan");
    }
}

#[cfg(test)]
mod purge_catalog_tests {
    use super::repo::purge_catalog;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn migrated_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory catalog");
        sqlx::migrate!("./migrations")
            .run(&db)
            .await
            .expect("run migrations");
        db
    }

    async fn count(db: &sqlx::SqlitePool, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(db)
            .await
            .expect("count rows")
    }

    #[tokio::test]
    async fn purge_clears_catalog_tables_and_keeps_settings() {
        let db = migrated_db().await;
        for sql in [
            "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES ('m', '/p/a.jpg', 'a.jpg', 'jpg', 'photo', 1, 1, 1, 1)",
            "INSERT INTO albums (id, name, created_at, updated_at) VALUES ('a', 'Album', 1, 1)",
            "INSERT INTO album_items (album_id, media_id, added_at) VALUES ('a', 'm', 1)",
            "INSERT INTO library_folders (path, added_at) VALUES ('/p', 1)",
            "INSERT INTO smart_albums (id, name, filter_json, created_at, updated_at) VALUES ('s', 'Smart', '{}', 1, 1)",
            "INSERT INTO settings (key, value) VALUES ('appearance', '\"dark\"')",
        ] {
            sqlx::query(sql).execute(&db).await.expect(sql);
        }

        let settings_before = count(&db, "settings").await;
        purge_catalog(&db).await.expect("purge");

        for table in [
            "media_items",
            "albums",
            "album_items",
            "library_folders",
            "smart_albums",
        ] {
            assert_eq!(count(&db, table).await, 0, "{table} should be empty");
        }
        assert_eq!(count(&db, "settings").await, settings_before);
    }
}

#[cfg(test)]
mod extension_tests {
    use super::{is_media_file, kind_for_ext, supported_extensions};

    #[test]
    fn picker_list_and_scanner_agree() {
        let exts = supported_extensions();
        assert!(exts.iter().all(|ext| is_media_file(ext)));
        assert!(!is_media_file("txt"));
        let unique: std::collections::HashSet<_> = exts.iter().collect();
        assert_eq!(unique.len(), exts.len(), "no extension is listed twice");
    }

    #[test]
    fn kinds_follow_the_lists() {
        assert_eq!(kind_for_ext("mkv"), "video");
        assert_eq!(kind_for_ext("cr3"), "raw");
        assert_eq!(kind_for_ext("heic"), "photo");
    }
}
