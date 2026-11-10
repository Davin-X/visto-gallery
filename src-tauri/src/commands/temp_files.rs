use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// A temp file that is removed on drop unless explicitly committed. This keeps
/// `<name>.tmp-<uuid>` export/edit outputs from leaking on write or rename
/// failures.
pub struct TempFileGuard {
    path: PathBuf,
    committed: bool,
}

impl TempFileGuard {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// True when `name` is a temp export file this app creates: `<stem>.tmp-<uuid>`.
fn is_app_export_temp(name: &str) -> bool {
    let Some((_, ext)) = name.rsplit_once('.') else {
        return false;
    };
    // "tmp-" (4) + UUID "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (36) = 40.
    if ext.len() != 40 || !ext.starts_with("tmp-") {
        return false;
    }
    let id = &ext[4..];
    let bytes = id.as_bytes();
    // 8-4-4-4-12 with '-' at 8,13,18,23.
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        };
        if !ok {
            return false;
        }
    }
    true
}

/// Remove stale export temp files under `root`. Only files matching the app's
/// exact `<name>.tmp-<uuid>` pattern and older than `min_age` are touched, so
/// an active write (still within the grace period) is never raced.
///
/// Returns the number of files removed. Errors reading individual entries are
/// ignored so a partial scan still cleans what it can.
/// The folder scan does the same cleanup inside its own walk (see
/// `collect_media_paths`); this standalone form exercises the rule in tests.
#[cfg(test)]
pub fn sweep_stale_export_temps(root: &Path, min_age: Duration) -> usize {
    if !root.is_dir() {
        return 0;
    }
    let Some(cutoff) = stale_temp_cutoff(min_age) else {
        return 0;
    };
    walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|entry| remove_if_stale_export_temp(entry, cutoff))
        .count()
}

/// The modification time at or before which an export temp counts as stale.
pub fn stale_temp_cutoff(min_age: Duration) -> Option<SystemTime> {
    SystemTime::now().checked_sub(min_age)
}

/// Remove `entry` when it is an app export temp (`<name>.tmp-<uuid>`) last
/// modified at or before `cutoff`. Returns whether a file was removed.
///
/// Callers that already walk a tree (the folder scan) use this per entry so
/// cleanup needs no second walk.
pub fn remove_if_stale_export_temp(entry: &walkdir::DirEntry, cutoff: SystemTime) -> bool {
    if !entry.file_type().is_file() || !is_app_export_temp(&entry.file_name().to_string_lossy()) {
        return false;
    }
    let stale = entry
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .is_some_and(|modified| modified <= cutoff);
    stale && std::fs::remove_file(entry.path()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("visto-tmpfiles-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn guard_removes_uncommitted_file() {
        let dir = tmpdir("guard");
        let path = dir.join("photo.tmp-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        fs::write(&path, b"data").unwrap();
        {
            let _guard = TempFileGuard::new(path.clone());
        }
        assert!(!path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn guard_keeps_committed_file() {
        let dir = tmpdir("commit");
        let path = dir.join("photo.tmp-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        fs::write(&path, b"data").unwrap();
        {
            let mut guard = TempFileGuard::new(path.clone());
            guard.commit();
        }
        assert!(path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sweep_removes_only_stale_matching_temps() {
        let dir = tmpdir("sweep");
        let stale = dir.join("image.tmp-d6575189-8154-4ede-938b-1239538dd153");
        let fresh = dir.join("fresh.tmp-d6575189-8154-4ede-938b-1239538dd154");
        let other = dir.join("notes.tmp-backup");
        let bak = dir.join("image.jpg.bak");
        fs::write(&stale, b"").unwrap();
        fs::write(&fresh, b"").unwrap();
        fs::write(&other, b"").unwrap();
        fs::write(&bak, b"").unwrap();
        // Make stale old enough.
        let old =
            filetime::FileTime::from_system_time(SystemTime::now() - Duration::from_secs(3600));
        filetime::set_file_mtime(&stale, old).unwrap();

        let removed = sweep_stale_export_temps(&dir, Duration::from_secs(300));
        assert_eq!(removed, 1);
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(other.exists());
        assert!(bak.exists());
        let _ = fs::remove_dir_all(dir);
    }
}
