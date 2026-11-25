use std::path::{Path, PathBuf};

use crate::commands::storage;

/// Cache identity prefixes. A changed ffmpeg recipe gets a new version so old
/// copies are never mistaken for ones produced by the current flags.
pub(super) const REMUX_VERSION: &str = "remux-v1";
pub(super) const TRANSCODE_VERSION: &str = "transcode-v1";

/// A `.partial.mp4` older than this is a crashed remux, not one in flight.
const CACHE_TEMP_GRACE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Drop the oldest remuxed files until the cache fits its budget. Leftover
/// `.partial.mp4` files from a crashed remux are swept even when the cache is
/// under budget, so they cannot accumulate forever.
pub(super) fn prune_cache(root: &Path, max_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let cutoff = std::time::SystemTime::now().checked_sub(CACHE_TEMP_GRACE);
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total = 0_u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if name.ends_with(".partial.mp4") {
            let stale = cutoff.is_some_and(|cutoff| {
                metadata
                    .modified()
                    .map(|modified| modified <= cutoff)
                    .unwrap_or(false)
            });
            if stale {
                let _ = std::fs::remove_file(&path);
            }
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("mp4") {
            continue;
        }
        total += metadata.len();
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        files.push((modified, metadata.len(), path));
    }
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    for (modified, size, path) in files {
        if total <= max_bytes {
            break;
        }
        // The player re-opens the file for every range request, so a copy
        // that may still be streaming is never deleted, even over budget.
        if storage::recently_used(modified, storage::PLAYBACK_IN_USE_GRACE) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

/// Delete the converted copies of `source`, if any are cached. Used when an
/// item is hidden, so its video does not stay readable in the cache folder.
pub(crate) fn remove_cached_remux(cache_root: &Path, source: &Path) -> bool {
    let Some((length, modified_ms)) = source_identity(source) else {
        return false;
    };
    let mut removed = false;
    for version in [REMUX_VERSION, TRANSCODE_VERSION] {
        let key = cache_key(version, source, length, modified_ms);
        removed |= std::fs::remove_file(cache_root.join(format!("{key}.mp4"))).is_ok();
    }
    removed
}

/// Size and modification time, the parts of a file's identity that a cache key
/// needs. `None` when the file cannot be read.
pub(super) fn source_identity(source: &Path) -> Option<(u64, u128)> {
    let metadata = std::fs::metadata(source).ok()?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    Some((metadata.len(), modified_ms))
}

/// Cache identity: the recipe version, the source, and everything that changes
/// its bytes.
pub(super) fn cache_key(version: &str, source: &Path, length: u64, modified_ms: u128) -> String {
    let identity = format!(
        "{version}:{}:{length}:{modified_ms}",
        source.to_string_lossy()
    );
    let digest = ring::digest::digest(&ring::digest::SHA256, identity.as_bytes());
    hex::encode(digest.as_ref())
}
