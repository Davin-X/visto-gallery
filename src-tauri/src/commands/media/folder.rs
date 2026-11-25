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
    // Bundles are directories too, and `open` launches or installs them
    // instead of showing a folder. Resolve symlinks first so a link named
    // like a folder cannot hide one.
    // shortcut: a fixed list of bundle extensions, ask LaunchServices if one slips through.
    const BUNDLE_EXTENSIONS: &[&str] = &[
        "app",
        "appex",
        "action",
        "bundle",
        "component",
        "framework",
        "kext",
        "mdimporter",
        "mpkg",
        "pkg",
        "plugin",
        "prefpane",
        "qlgenerator",
        "saver",
        "wdgt",
        "workflow",
        "xpc",
    ];
    let resolved = std::fs::canonicalize(&path)?;
    let is_bundle = resolved.extension().is_some_and(|ext| {
        BUNDLE_EXTENSIONS
            .iter()
            .any(|bundle| ext.eq_ignore_ascii_case(bundle))
    });
    if is_bundle {
        return Err(CommandError::invalid(
            "Path is an app or bundle, not a folder.".to_string(),
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
