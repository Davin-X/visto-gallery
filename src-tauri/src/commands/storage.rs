//! Disk usage of what VistoGallery keeps beside your media, and the caches the
//! user can clear from Settings.
//!
//! Layout (all per user, never inside a library folder):
//! - app data: `visto-gallery.db` (+ `-wal`/`-shm`) and `edit-originals/`
//! - app cache: `thumbnails/` and `playback/` (remuxed videos)
//!
//! Both caches evict by modification time. A cache hit refreshes that time
//! (see [`touch_if_stale`]) so eviction drops the least recently *used* file,
//! not merely the oldest one written.

use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::errors::CommandError;

/// Cache subfolder for rendered thumbnails.
pub(crate) const THUMBNAILS_DIR: &str = "thumbnails";
/// Cache subfolder for display-size and full-size photo previews (RAW, and
/// photos the web view cannot decode). Counted and cleared with thumbnails.
pub(crate) const PREVIEWS_DIR: &str = "previews";
/// Cache subfolder for videos remuxed for playback.
pub(crate) const PLAYBACK_DIR: &str = "playback";

/// A cache hit only rewrites the timestamp when it is older than this, so a
/// grid scroll does not turn every read into a metadata write.
const TOUCH_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// A remuxed video used this recently may still be streaming to the player,
/// which re-opens the file for every range request. Pruning and clearing skip
/// it, so a long film never disappears mid-play.
pub(crate) const PLAYBACK_IN_USE_GRACE: Duration = Duration::from_secs(3 * 60 * 60);

/// Mark a cache file as just used when its timestamp is older than
/// [`TOUCH_INTERVAL`]. Failure is harmless: the file is only evicted sooner.
pub(crate) fn touch_if_stale(path: &Path) {
    let now = SystemTime::now();
    let stale = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(|modified| now.duration_since(modified).unwrap_or_default() >= TOUCH_INTERVAL)
        .unwrap_or(false);
    if !stale {
        return;
    }
    if let Ok(file) = std::fs::File::options().append(true).open(path) {
        let _ = file.set_modified(now);
    }
}

/// Whether `modified` falls inside `grace` of now.
pub(crate) fn recently_used(modified: SystemTime, grace: Duration) -> bool {
    SystemTime::now()
        .duration_since(modified)
        .map(|age| age < grace)
        .unwrap_or(true)
}

/// Item ids that are safe to put in a file name (catalog ids are UUIDs).
fn file_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Cache file name for one rendering of an item: `<item id>.<digest>.jpg`,
/// so every rendering of an item can be found (and removed when it is
/// hidden). An id that is unsafe in a file name falls back to the digest.
pub(crate) fn thumbnail_file_name(item_id: &str, digest_hex: &str) -> String {
    if file_safe_id(item_id) {
        format!("{item_id}.{digest_hex}.jpg")
    } else {
        format!("{digest_hex}.jpg")
    }
}

/// The item id a cache file belongs to, or `None` for a file named only by
/// its digest (the layout before item ids were part of the name).
fn thumbnail_owner(file_name: &str) -> Option<&str> {
    let first = file_name.split('.').next()?;
    let legacy = first.len() == 64 && first.chars().all(|c| c.is_ascii_hexdigit());
    (!legacy && file_safe_id(first)).then_some(first)
}

/// Delete every cached rendering of `item_id`, temp files included.
pub(crate) fn remove_item_thumbnails(dir: &Path, item_id: &str) -> usize {
    if !file_safe_id(item_id) {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if thumbnail_owner(name) == Some(item_id) && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Remove cached thumbnails that must not stay on disk: those of hidden items,
/// and any file named by digest alone (from before the owner was recorded, so
/// it may show a hidden item). Returns how many files were removed.
pub(crate) fn sweep_thumbnail_cache(
    dir: &Path,
    hidden_ids: &std::collections::HashSet<String>,
) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let drop = match thumbnail_owner(name) {
            Some(owner) => hidden_ids.contains(owner),
            None => true,
        };
        if drop && entry.path().is_file() && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Once per launch: purge cached thumbnails and converted videos of hidden
/// items (and digest-only thumbnails), so nothing hidden sits readable in
/// the cache folder.
pub(crate) async fn purge_hidden_from_caches(app: &AppHandle, db: &sqlx::SqlitePool) {
    let Ok(cache) = app.path().app_cache_dir() else {
        return;
    };
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, kind, path FROM media_items WHERE hidden = 1")
            .fetch_all(db)
            .await
            .unwrap_or_default();
    let hidden: std::collections::HashSet<String> =
        rows.iter().map(|(id, _, _)| id.clone()).collect();
    let videos: Vec<String> = rows
        .into_iter()
        .filter(|(_, kind, _)| kind == "video")
        .map(|(_, _, path)| path)
        .collect();
    let _ = tokio::task::spawn_blocking(move || {
        let thumbnails = sweep_thumbnail_cache(&cache.join(THUMBNAILS_DIR), &hidden)
            + sweep_thumbnail_cache(&cache.join(PREVIEWS_DIR), &hidden);
        let playback = cache.join(PLAYBACK_DIR);
        let remuxes = videos
            .iter()
            .filter(|path| super::playback::remove_cached_remux(&playback, Path::new(path)))
            .count();
        if thumbnails + remuxes > 0 {
            tracing::info!(
                "removed {thumbnails} cached thumbnail(s) and {remuxes} converted video(s) of hidden items"
            );
        }
    })
    .await;
}

#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    /// Catalog database including its write-ahead log.
    pub catalog_bytes: u64,
    pub thumbnail_bytes: u64,
    pub thumbnail_files: u64,
    pub playback_bytes: u64,
    pub playback_files: u64,
    /// Originals saved before in-place edits, kept so edits can be reverted.
    pub edit_original_bytes: u64,
    pub edit_original_files: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CacheKind {
    Thumbnails,
    Playback,
}

#[derive(Debug, Clone, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClearCacheResult {
    pub removed_files: u64,
    pub freed_bytes: u64,
    /// Files left in place because they were in use.
    pub kept_files: u64,
}

/// Total size and count of regular files directly inside `dir`.
fn dir_usage(dir: &Path) -> (u64, u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .fold((0, 0), |(bytes, files), metadata| {
            (bytes + metadata.len(), files + 1)
        })
}

fn catalog_usage(app_data: &Path) -> u64 {
    [
        "visto-gallery.db",
        "visto-gallery.db-wal",
        "visto-gallery.db-shm",
    ]
    .iter()
    .filter_map(|name| std::fs::metadata(app_data.join(name)).ok())
    .map(|metadata| metadata.len())
    .sum()
}

pub(crate) fn storage_usage_in(app_data: &Path, app_cache: &Path) -> StorageUsage {
    let (thumb_bytes, thumb_files) = dir_usage(&app_cache.join(THUMBNAILS_DIR));
    let (preview_bytes, preview_files) = dir_usage(&app_cache.join(PREVIEWS_DIR));
    let (thumbnail_bytes, thumbnail_files) =
        (thumb_bytes + preview_bytes, thumb_files + preview_files);
    let (playback_bytes, playback_files) = dir_usage(&app_cache.join(PLAYBACK_DIR));
    let (edit_original_bytes, edit_original_files) =
        dir_usage(&app_data.join(super::media::EDIT_ORIGINALS_DIR));
    StorageUsage {
        catalog_bytes: catalog_usage(app_data),
        thumbnail_bytes,
        thumbnail_files,
        playback_bytes,
        playback_files,
        edit_original_bytes,
        edit_original_files,
    }
}

/// Delete the cache files in `dir`. Only the cache's own file types are
/// removed; playback copies used within [`PLAYBACK_IN_USE_GRACE`] are kept.
pub(crate) fn clear_cache_dir(dir: &Path, kind: CacheKind) -> ClearCacheResult {
    let mut result = ClearCacheResult::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return result;
    };
    let extension = match kind {
        CacheKind::Thumbnails => "jpg",
        CacheKind::Playback => "mp4",
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some(extension)
        {
            continue;
        }
        if matches!(kind, CacheKind::Playback) {
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            if recently_used(modified, PLAYBACK_IN_USE_GRACE) {
                result.kept_files += 1;
                continue;
            }
        }
        if std::fs::remove_file(&path).is_ok() {
            result.removed_files += 1;
            result.freed_bytes += metadata.len();
        }
    }
    result
}

#[tauri::command]
pub async fn get_storage_usage(app: AppHandle) -> Result<StorageUsage, CommandError> {
    let app_data = app.path().app_data_dir()?;
    let app_cache = app.path().app_cache_dir()?;
    tokio::task::spawn_blocking(move || storage_usage_in(&app_data, &app_cache))
        .await
        .map_err(|error| CommandError::internal(format!("Storage scan failed: {error}")))
}

#[tauri::command]
pub async fn clear_cache(
    app: AppHandle,
    kind: CacheKind,
) -> Result<ClearCacheResult, CommandError> {
    let cache = app.path().app_cache_dir()?;
    let dirs: Vec<std::path::PathBuf> = match kind {
        CacheKind::Thumbnails => vec![cache.join(THUMBNAILS_DIR), cache.join(PREVIEWS_DIR)],
        CacheKind::Playback => vec![cache.join(PLAYBACK_DIR)],
    };
    tokio::task::spawn_blocking(move || {
        dirs.iter().map(|dir| clear_cache_dir(dir, kind)).fold(
            ClearCacheResult::default(),
            |total, part| ClearCacheResult {
                removed_files: total.removed_files + part.removed_files,
                freed_bytes: total.freed_bytes + part.freed_bytes,
                kept_files: total.kept_files + part.kept_files,
            },
        )
    })
    .await
    .map_err(|error| CommandError::internal(format!("Clearing the cache failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("visto-storage-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn age(path: &Path, by: Duration) {
        let file = std::fs::File::options()
            .append(true)
            .open(path)
            .expect("open");
        file.set_modified(SystemTime::now() - by)
            .expect("set mtime");
    }

    #[test]
    fn touch_refreshes_only_stale_files() {
        let dir = temp_dir("touch");
        let old = dir.join("old.jpg");
        let fresh = dir.join("fresh.jpg");
        std::fs::write(&old, b"x").unwrap();
        std::fs::write(&fresh, b"x").unwrap();
        age(&old, Duration::from_secs(5 * 24 * 60 * 60));
        age(&fresh, Duration::from_secs(60));
        let fresh_before = std::fs::metadata(&fresh).unwrap().modified().unwrap();

        touch_if_stale(&old);
        touch_if_stale(&fresh);

        let old_after = std::fs::metadata(&old).unwrap().modified().unwrap();
        assert!(
            recently_used(old_after, Duration::from_secs(60)),
            "stale hit is marked used"
        );
        assert_eq!(
            std::fs::metadata(&fresh).unwrap().modified().unwrap(),
            fresh_before,
            "a recently touched file is not rewritten"
        );
        assert_eq!(
            std::fs::read(&old).unwrap(),
            b"x",
            "touching never changes the bytes"
        );
    }

    #[test]
    fn usage_counts_each_area() {
        let data = temp_dir("data");
        let cache = temp_dir("cache");
        std::fs::write(data.join("visto-gallery.db"), vec![0; 100]).unwrap();
        std::fs::write(data.join("visto-gallery.db-wal"), vec![0; 20]).unwrap();
        std::fs::create_dir_all(data.join("edit-originals")).unwrap();
        std::fs::write(data.join("edit-originals/a.jpg"), vec![0; 7]).unwrap();
        std::fs::create_dir_all(cache.join(THUMBNAILS_DIR)).unwrap();
        std::fs::write(cache.join(THUMBNAILS_DIR).join("t.jpg"), vec![0; 3]).unwrap();
        std::fs::write(cache.join(THUMBNAILS_DIR).join("u.jpg"), vec![0; 4]).unwrap();

        let usage = storage_usage_in(&data, &cache);
        assert_eq!(usage.catalog_bytes, 120);
        assert_eq!((usage.thumbnail_bytes, usage.thumbnail_files), (7, 2));
        assert_eq!((usage.playback_bytes, usage.playback_files), (0, 0));
        assert_eq!(
            (usage.edit_original_bytes, usage.edit_original_files),
            (7, 1)
        );
    }

    #[test]
    fn hidden_items_and_digest_only_files_are_swept_from_the_thumbnail_cache() {
        let dir = temp_dir("sweep");
        let digest = "a".repeat(64);
        let visible = "11111111-2222-3333-4444-555555555555";
        let hidden = "66666666-7777-8888-9999-000000000000";
        let keep = dir.join(thumbnail_file_name(visible, &digest));
        let secret = dir.join(thumbnail_file_name(hidden, &digest));
        let secret_temp = dir.join(format!("{hidden}.{digest}.abcd.tmp.jpg"));
        let legacy = dir.join(format!("{digest}.jpg"));
        for path in [&keep, &secret, &secret_temp, &legacy] {
            std::fs::write(path, b"jpeg").unwrap();
        }

        let hidden_ids = std::collections::HashSet::from([hidden.to_string()]);
        assert_eq!(sweep_thumbnail_cache(&dir, &hidden_ids), 3);
        assert!(keep.exists(), "a visible item's thumbnail stays");
        assert!(
            !secret.exists() && !secret_temp.exists(),
            "hidden renderings go"
        );
        assert!(
            !legacy.exists(),
            "a file with no recorded owner may be hidden"
        );
    }

    #[test]
    fn hiding_one_item_removes_only_its_renderings() {
        let dir = temp_dir("remove-item");
        let a = "item-a";
        let b = "item-b";
        let small = dir.join(thumbnail_file_name(a, &"1".repeat(64)));
        let large = dir.join(thumbnail_file_name(a, &"2".repeat(64)));
        let other = dir.join(thumbnail_file_name(b, &"1".repeat(64)));
        for path in [&small, &large, &other] {
            std::fs::write(path, b"jpeg").unwrap();
        }
        assert_eq!(remove_item_thumbnails(&dir, a), 2);
        assert!(other.exists());
        // An id unsafe in a file name never matches anything.
        assert_eq!(remove_item_thumbnails(&dir, "../item-b"), 0);
        assert_eq!(thumbnail_file_name("../x", "ff"), "ff.jpg");
    }

    #[test]
    fn clearing_thumbnails_removes_only_jpegs() {
        let dir = temp_dir("clear-thumbs");
        std::fs::write(dir.join("a.jpg"), vec![0; 5]).unwrap();
        std::fs::write(dir.join("notes.txt"), b"keep").unwrap();

        let result = clear_cache_dir(&dir, CacheKind::Thumbnails);
        assert_eq!((result.removed_files, result.freed_bytes), (1, 5));
        assert!(dir.join("notes.txt").exists());
    }

    #[test]
    fn clearing_playback_keeps_videos_in_use() {
        let dir = temp_dir("clear-playback");
        let playing = dir.join("playing.mp4");
        let idle = dir.join("idle.mp4");
        std::fs::write(&playing, vec![0; 9]).unwrap();
        std::fs::write(&idle, vec![0; 11]).unwrap();
        age(&idle, PLAYBACK_IN_USE_GRACE + Duration::from_secs(60));

        let result = clear_cache_dir(&dir, CacheKind::Playback);
        assert_eq!(
            (result.removed_files, result.freed_bytes, result.kept_files),
            (1, 11, 1)
        );
        assert!(playing.exists(), "a video that may be streaming stays");
        assert!(!idle.exists());
    }
}
