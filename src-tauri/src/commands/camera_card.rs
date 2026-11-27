//! Import a camera card: copy its media into date-based folders, skipping duplicates.

use std::path::Path;

use serde::Serialize;
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
}

#[tauri::command]
pub async fn import_camera_card(
    source: String,
    destination: String,
) -> Result<CameraCardImportResult, CommandError> {
    tokio::task::spawn_blocking(move || import_blocking(&source, &destination))
        .await
        .map_err(|e| CommandError::internal(format!("Camera card import task failed: {e}")))?
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

    for entry in WalkDir::new(src).into_iter().filter_map(Result::ok) {
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
        if target.exists() {
            skipped += 1;
            continue;
        }
        match std::fs::copy(path, &target) {
            Ok(_) => imported += 1,
            Err(_) => failed += 1,
        }
    }

    Ok(CameraCardImportResult {
        imported,
        skipped,
        failed,
    })
}
