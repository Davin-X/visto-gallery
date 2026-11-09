//! Which filesystem locations the webview may ask the backend to import.
//!
//! `scan_library` and `import_files` register what they read as library
//! roots, and a registered root widens the asset-protocol scope and every
//! root-based path check. So the paths they accept must come from the user,
//! not from whatever the webview sends. A path is accepted when it is:
//!
//! - granted: returned by a native picker opened in Rust
//!   ([`pick_source_folders`], [`pick_media_files`]) or dropped onto the
//!   window (recorded by the drag-drop handler in `lib.rs`);
//! - already a registered root, or inside one (rescans, re-imports); or
//! - an inferred sidebar folder that holds cataloged items (legacy rescans).

use super::*;
use tauri_plugin_dialog::DialogExt;

/// Canonical paths the user handed to the app during this session.
#[derive(Default)]
pub struct GrantedPaths(std::sync::Mutex<HashSet<PathBuf>>);

impl GrantedPaths {
    pub fn grant<I, P>(&self, paths: I)
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let Ok(mut set) = self.0.lock() else {
            return;
        };
        for path in paths {
            if let Ok(canonical) = path.as_ref().canonicalize() {
                set.insert(canonical);
            }
        }
    }

    /// True when `path` is a granted path or sits inside a granted folder.
    pub fn covers(&self, path: &Path) -> bool {
        let Ok(canonical) = path.canonicalize() else {
            return false;
        };
        let Ok(set) = self.0.lock() else {
            return false;
        };
        set.iter().any(|granted| canonical.starts_with(granted))
    }
}

/// Reject a scan or import path the user never chose.
pub(crate) async fn authorize_import_path(
    path: &str,
    db: &SqlitePool,
    grants: &GrantedPaths,
) -> Result<(), String> {
    if grants.covers(Path::new(path)) {
        return Ok(());
    }
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    if !registered.is_empty() && validate_path_under_registered_roots(path, &registered).is_ok() {
        return Ok(());
    }
    if is_inferred_catalog_folder(path, db).await? {
        return Ok(());
    }
    Err(format!(
        "'{}' was not chosen in a file picker or dropped onto the window.",
        path
    ))
}

/// True when `path` is exactly the sidebar bucket that already-cataloged
/// items are grouped under.
async fn is_inferred_catalog_folder(path: &str, db: &SqlitePool) -> Result<bool, String> {
    let root = normalize_root(path);
    if root == "/" || root.is_empty() {
        return Ok(false);
    }
    let prefix = format!("{}/", root);
    let sample: Option<String> = sqlx::query_scalar(
        "SELECT path FROM media_items WHERE substr(path, 1, length(?)) = ? LIMIT 1",
    )
    .bind(&prefix)
    .bind(&prefix)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(sample.is_some_and(|item| super::library::inferred_folder_root(&item) == Some(root)))
}

fn paths_to_strings(paths: Vec<tauri_plugin_dialog::FilePath>) -> Vec<String> {
    paths
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Native folder picker for adding library sources. Picked folders are
/// granted for this session. Returns an empty list when cancelled.
#[tauri::command]
pub async fn pick_source_folders(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose source folders")
        .blocking_pick_folders()
        .map(paths_to_strings)
        .unwrap_or_default();
    state.grants.grant(&picked);
    Ok(picked)
}

/// Native file picker for importing individual media files. Picked files are
/// granted for this session. Returns an empty list when cancelled.
#[tauri::command]
pub async fn pick_media_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let extensions = supported_extensions();
    let ext_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let picked = app
        .dialog()
        .file()
        .add_filter("Media", &ext_refs)
        .blocking_pick_files()
        .map(paths_to_strings)
        .unwrap_or_default();
    state.grants.grant(&picked);
    Ok(picked)
}

#[cfg(test)]
mod tests {
    use super::GrantedPaths;
    use std::fs;

    fn temp_tree() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("visto-grants-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("granted/sub")).unwrap();
        fs::create_dir_all(root.join("other")).unwrap();
        root
    }

    #[test]
    fn granted_folder_covers_itself_and_children_only() {
        let root = temp_tree();
        let grants = GrantedPaths::default();
        grants.grant([root.join("granted")]);

        assert!(grants.covers(&root.join("granted")));
        assert!(grants.covers(&root.join("granted/sub")));
        assert!(!grants.covers(&root.join("other")));
        assert!(!grants.covers(&root));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dotdot_cannot_escape_a_grant() {
        let root = temp_tree();
        let grants = GrantedPaths::default();
        grants.grant([root.join("granted")]);

        assert!(!grants.covers(&root.join("granted/../other")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_is_covered_by_default() {
        let root = temp_tree();
        assert!(!GrantedPaths::default().covers(&root));
        let _ = fs::remove_dir_all(&root);
    }
}
