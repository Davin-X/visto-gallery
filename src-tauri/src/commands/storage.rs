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
    let (thumbnail_bytes, thumbnail_files) = dir_usage(&app_cache.join(THUMBNAILS_DIR));
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
    let dir = app.path().app_cache_dir()?.join(match kind {
        CacheKind::Thumbnails => THUMBNAILS_DIR,
        CacheKind::Playback => PLAYBACK_DIR,
    });
    tokio::task::spawn_blocking(move || clear_cache_dir(&dir, kind))
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
