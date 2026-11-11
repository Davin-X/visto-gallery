use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::errors::CommandError;

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

/// A sibling temp path for `target`: `<name>.tmp-<uuid>` in the same folder.
/// Staying in the same folder keeps the final rename atomic and never crosses
/// a filesystem boundary. The name matches the sweep pattern in
/// [`is_app_export_temp`], so an abandoned temp is cleaned up by the scan.
pub(crate) fn temp_sibling(target: &Path) -> PathBuf {
    target.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()))
}

fn sync_file(path: &Path) -> Result<(), CommandError> {
    std::fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| CommandError::io(format!("Could not flush the file to disk: {e}")))
}

/// Write `target` by way of a temp file in the same folder, then rename.
///
/// A failed write leaves the destination untouched and removes the temp, so a
/// crash or an encode error can never leave a truncated file that later runs
/// mistake for a finished one.
pub(crate) fn write_atomically<F>(target: &Path, write: F) -> Result<(), CommandError>
where
    F: FnOnce(&Path) -> Result<(), CommandError>,
{
    let mut guard = TempFileGuard::new(temp_sibling(target));
    write(guard.path())?;
    sync_file(guard.path())?;
    std::fs::rename(guard.path(), target).map_err(|e| {
        CommandError::io(format!(
            "Could not finish writing {}: {}",
            target.display(),
            e
        ))
    })?;
    guard.commit();
    Ok(())
}

/// Replace `target` with a copy of `source` without exposing a partial file.
pub(crate) fn copy_atomically(source: &Path, target: &Path) -> Result<(), CommandError> {
    write_atomically(target, |temp| {
        std::fs::copy(source, temp)
            .map(|_| ())
            .map_err(|e| CommandError::io(format!("Could not copy the file: {e}")))
    })
}

/// Best-effort carry-over of the metadata a rewritten file would otherwise
/// lose when its inode is swapped: POSIX mode and extended attributes. On
/// macOS that includes Finder tags (`com.apple.metadata:_kMDItemUserTags`),
/// quarantine, and Finder info. Content is intentionally not copied.
pub(crate) fn preserve_metadata(from: &Path, to: &Path) {
    if let Ok(meta) = std::fs::metadata(from) {
        if let Err(error) = std::fs::set_permissions(to, meta.permissions()) {
            tracing::warn!(%error, "could not preserve file mode");
        }
    }

    let Ok(names) = xattr::list(from) else {
        return;
    };
    for name in names {
        let Ok(Some(value)) = xattr::get(from, &name) else {
            continue;
        };
        if let Err(error) = xattr::set(to, &name, &value) {
            tracing::warn!(%error, "could not preserve extended attribute");
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

/// Remove stale files from the export staging folder (`$TMPDIR/visto-export`).
/// Anything older than `min_age` is removed; the staging folder only holds
/// transient "save a copy" renders awaiting a destination dialog.
pub fn sweep_export_staging(min_age: Duration) -> Result<usize, std::io::Error> {
    sweep_dir(
        &std::env::temp_dir().join("visto-export"),
        stale_temp_cutoff(min_age),
    )
}

/// Remove every file in `dir` older than `cutoff`. Missing directories and
/// individual I/O failures are ignored so a partial sweep still cleans.
/// Returns the number of files removed.
pub fn sweep_dir(dir: &Path, cutoff: Option<SystemTime>) -> Result<usize, std::io::Error> {
    let Some(cutoff) = cutoff else {
        return Ok(0);
    };
    let mut removed = 0usize;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let age_ok = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .is_some_and(|modified| modified <= cutoff);
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
                && age_ok
                && std::fs::remove_file(entry.path()).is_ok()
            {
                removed += 1;
            }
        }
    }
    Ok(removed)
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
    fn sweep_dir_removes_only_files_older_than_cutoff() {
        let dir = tmpdir("staging");
        let old = dir.join("stale_edited.jpg");
        let fresh = dir.join("fresh_edited.jpg");
        fs::write(&old, b"data").unwrap();
        fs::write(&fresh, b"data").unwrap();
        let age =
            filetime::FileTime::from_system_time(SystemTime::now() - Duration::from_secs(7200));
        filetime::set_file_mtime(&old, age).unwrap();

        let removed = sweep_dir(&dir, stale_temp_cutoff(Duration::from_secs(3600))).unwrap();
        assert_eq!(removed, 1);
        assert!(!old.exists());
        assert!(fresh.exists());
        // Subdirectories are ignored, not recursed into.
        let nested = dir.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let nested_old = nested.join("stale.jpg");
        fs::write(&nested_old, b"data").unwrap();
        let nested_age =
            filetime::FileTime::from_system_time(SystemTime::now() - Duration::from_secs(7200));
        filetime::set_file_mtime(&nested_old, nested_age).unwrap();
        assert_eq!(
            sweep_dir(&dir, stale_temp_cutoff(Duration::from_secs(3600))).unwrap(),
            0
        );
        assert!(nested_old.exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn sweep_dir_on_missing_dir_is_zero() {
        let dir = tmpdir("staging-missing");
        let missing = dir.join("nope");
        assert_eq!(
            sweep_dir(&missing, stale_temp_cutoff(Duration::from_secs(1))).unwrap(),
            0
        );

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

    fn dir_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn write_atomically_replaces_and_leaves_no_temp() {
        let dir = tmpdir("atomic");
        let target = dir.join("photo.jpg");
        fs::write(&target, b"old").unwrap();

        write_atomically(&target, |temp| {
            fs::write(temp, b"new").unwrap();
            Ok(())
        })
        .unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(dir_names(&dir), vec!["photo.jpg".to_string()]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn write_atomically_keeps_target_when_the_write_fails() {
        let dir = tmpdir("atomic-fail");
        let target = dir.join("photo.jpg");
        fs::write(&target, b"old").unwrap();

        let result = write_atomically(&target, |temp| {
            fs::write(temp, b"partial").unwrap();
            Err(CommandError::io("encode failed".to_string()))
        });

        assert!(result.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert_eq!(dir_names(&dir), vec!["photo.jpg".to_string()]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn copy_atomically_replaces_target() {
        let dir = tmpdir("atomic-copy");
        let source = dir.join("source.jpg");
        let target = dir.join("target.jpg");
        fs::write(&source, b"restored bytes").unwrap();
        fs::write(&target, b"edited bytes").unwrap();

        copy_atomically(&source, &target).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"restored bytes");
        assert_eq!(
            dir_names(&dir),
            vec!["source.jpg".to_string(), "target.jpg".to_string()]
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn preserve_metadata_carries_mode_and_xattrs() {
        let dir = tmpdir("metadata");
        let from = dir.join("from.jpg");
        let to = dir.join("to.jpg");
        fs::write(&from, b"a").unwrap();
        fs::write(&to, b"b").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&from, fs::Permissions::from_mode(0o640)).unwrap();
        }

        let xattr_name = "com.visto-gallery.test";
        let xattr_supported = xattr::set(&from, xattr_name, b"finder-tag").is_ok();

        preserve_metadata(&from, &to);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&to).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o640);
        }
        if xattr_supported {
            assert_eq!(
                xattr::get(&to, xattr_name).unwrap().as_deref(),
                Some(&b"finder-tag"[..])
            );
        }
        let _ = fs::remove_dir_all(dir);
    }
}
