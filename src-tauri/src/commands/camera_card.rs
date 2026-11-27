//! Import a camera card: copy its media into date-based folders, skipping duplicates.

use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri_plugin_dialog::DialogExt;
use ts_rs::TS;
use walkdir::WalkDir;

use crate::commands::is_media_file;
use crate::errors::CommandError;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CameraCardImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    pub destination: String,
}

#[tauri::command]
pub async fn import_camera_card(
    source: String,
    app: tauri::AppHandle,
    catalog: tauri::State<'_, crate::Catalog>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Option<CameraCardImportResult>, CommandError> {
    let db = super::get_db(&catalog)?;
    super::authorize_import_path(&source, &db, &state.grants).await?;
    let Some(destination) = app
        .dialog()
        .file()
        .set_title("Choose camera card import destination")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let destination = destination
        .into_path()
        .map_err(|_| CommandError::path("Could not read the selected destination folder."))?;
    state.grants.grant([&destination]);
    let destination = destination.to_string_lossy().into_owned();
    super::authorize_import_path(&destination, &db, &state.grants).await?;
    tokio::task::spawn_blocking(move || import_blocking(&source, &destination))
        .await
        .map_err(|e| CommandError::internal(format!("Camera card import task failed: {e}")))?
        .map(Some)
}

fn import_blocking(
    source: &str,
    destination: &str,
) -> Result<CameraCardImportResult, CommandError> {
    let src = Path::new(source);
    let dst = Path::new(destination);
    if !src.is_dir() {
        return Err(CommandError::invalid("Source is not a folder"));
    }
    std::fs::create_dir_all(dst)
        .map_err(|e| CommandError::io(format!("Could not create destination folder: {e}")))?;

    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;

    for entry in WalkDir::new(src) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !is_media_file(&ext) {
            continue;
        }

        let captured = crate::commands::media::extract_exif(path).captured_at;
        let ms = captured.unwrap_or_else(|| {
            std::fs::metadata(path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });
        let folder_name = crate::commands::batch_pipeline::batch_date_label(ms);
        let target_dir = dst.join(&folder_name);
        if std::fs::create_dir_all(&target_dir).is_err() {
            failed += 1;
            continue;
        }
        let file_name = match path.file_name() {
            Some(n) => n,
            None => {
                failed += 1;
                continue;
            }
        };
        let target = target_dir.join(file_name);
        let mut candidate = target.clone();
        let mut suffix = 1usize;
        loop {
            if candidate.exists() {
                if files_match(path, &candidate) {
                    skipped += 1;
                    break;
                }
                candidate = collision_name(&target, suffix);
                suffix += 1;
                continue;
            }

            let temp = target_dir.join(format!(".visto-import-{}.tmp", uuid::Uuid::new_v4()));
            if std::fs::copy(path, &temp).is_err() {
                let _ = std::fs::remove_file(&temp);
                failed += 1;
                break;
            }
            match publish_copy(&temp, &candidate) {
                Ok(()) => {
                    imported += 1;
                    break;
                }
                Err(error) => {
                    let _ = std::fs::remove_file(&temp);
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        continue;
                    }
                }
            }
            failed += 1;
            break;
        }
    }

    Ok(CameraCardImportResult {
        imported,
        skipped,
        failed,
        destination: destination.to_string(),
    })
}

fn files_match(left: &Path, right: &Path) -> bool {
    let (Ok(left), Ok(right)) = (std::fs::File::open(left), std::fs::File::open(right)) else {
        return false;
    };
    let (Ok(left_len), Ok(right_len)) = (left.metadata(), right.metadata()) else {
        return false;
    };
    if left_len.len() != right_len.len() {
        return false;
    }
    let (mut left, mut right) = (BufReader::new(left), BufReader::new(right));
    let (mut left_buf, mut right_buf) = ([0; 64 * 1024], [0; 64 * 1024]);
    loop {
        let (Ok(left_len), Ok(right_len)) = (left.read(&mut left_buf), right.read(&mut right_buf))
        else {
            return false;
        };
        if left_len != right_len || left_buf[..left_len] != right_buf[..right_len] {
            return false;
        }
        if left_len == 0 {
            return true;
        }
    }
}

fn collision_name(path: &Path, suffix: usize) -> PathBuf {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path.extension().map(|ext| ext.to_string_lossy());
    let name = match ext {
        Some(ext) => format!("{stem} ({suffix}).{ext}"),
        None => format!("{stem} ({suffix})"),
    };
    path.with_file_name(name)
}

#[cfg(target_os = "macos")]
fn publish_copy(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    // Both C strings remain alive and NUL-terminated for the call.
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn publish_copy(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::hard_link(source, destination)?;
    let _ = std::fs::remove_file(source);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishing_never_replaces_an_existing_photo() {
        let dir = std::env::temp_dir().join(format!("visto-import-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let staged = dir.join("staged.tmp");
        let existing = dir.join("existing.jpg");
        let fresh = dir.join("fresh.jpg");
        std::fs::write(&staged, b"new").unwrap();
        std::fs::write(&existing, b"old").unwrap();

        let collision = publish_copy(&staged, &existing);
        let original = std::fs::read(&existing);
        let published = publish_copy(&staged, &fresh);
        let contents = std::fs::read(&fresh);
        std::fs::remove_dir_all(&dir).unwrap();

        assert_eq!(
            collision.unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(original.unwrap(), b"old");
        published.unwrap();
        assert_eq!(contents.unwrap(), b"new");
    }
}
