use crate::errors::CommandError;

/// Open a folder in Finder. Used by Batch export results.
#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), CommandError> {
    // Unlike `open -R` (which selects a file in its parent), this opens the
    // folder itself in Finder. Used by Batch export results.
    if !std::path::Path::new(&path).is_dir() {
        return Err(CommandError::invalid(
            "Path is not a directory.".to_string(),
        ));
    }
    // An app bundle is a directory too, and `open Foo.app` launches it.
    // Resolve symlinks first so a link named like a folder cannot hide one.
    let resolved = std::fs::canonicalize(&path)?;
    let is_app = resolved
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("app"));
    if is_app {
        return Err(CommandError::invalid(
            "Path is an app, not a folder.".to_string(),
        ));
    }
    let status = std::process::Command::new("open")
        .arg(&resolved)
        .status()
        .map_err(|e| CommandError::io(format!("Could not open {}: {}", path, e)))?;
    if !status.success() {
        return Err(CommandError::io(format!("Could not open {}.", path)));
    }
    Ok(())
}
