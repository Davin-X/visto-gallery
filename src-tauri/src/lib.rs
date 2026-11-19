use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use sqlx::SqlitePool;
use tauri::{Emitter, Manager, RunEvent, State};

// Modules
mod clock;
mod commands;
mod db;
mod errors;
mod ipc_types_export;
mod media_animation;
mod media_dimensions;
mod media_kind;
mod media_signature;
mod media_tools;
mod menu;
mod models;

use commands::*;
use db::Database;
use errors::CommandError;
use menu::{create_menu, dispatch_menu_event};

/// Shared SQLite pool (or the launch-time open error). Managed as Tauri state
/// so commands take it without locking a mutex. Set exactly once during setup.
#[derive(Default)]
pub struct Catalog {
    inner: OnceLock<Result<SqlitePool, CommandError>>,
}

impl Catalog {
    pub fn pool(&self) -> Result<SqlitePool, CommandError> {
        match self.inner.get() {
            Some(Ok(pool)) => Ok(pool.clone()),
            Some(Err(reason)) => Err(CommandError::catalog_unavailable(format!(
                "The VistoGallery catalog could not be opened: {reason}. \
                 Quit other copies of VistoGallery, or restore a catalog backup."
            ))),
            None => Err(CommandError::catalog_unavailable(
                "The VistoGallery catalog could not be opened: it is still starting up. \
                 Quit other copies of VistoGallery, or restore a catalog backup.",
            )),
        }
    }

    fn set(&self, value: Result<SqlitePool, CommandError>) {
        let _ = self.inner.set(value);
    }
}

pub(crate) struct AppState {
    pub(crate) watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
    /// Paths the user chose in a native picker or dropped on the window.
    pub(crate) grants: commands::GrantedPaths,
    /// Per-operation cancel flags and per-root locks for scans and imports.
    pub(crate) scan_jobs: commands::ScanJobs,
    /// Per-invocation cancel flags for long operations that are not scans.
    pub(crate) trash_cancel: commands::CancelGroup,
    pub(crate) batch_cancel: commands::CancelGroup,
    pub(crate) duplicate_cancel: commands::CancelGroup,
    /// The last any-file duplicate scan (id -> path), kept in memory only.
    pub(crate) file_duplicates: Mutex<commands::FileDuplicateSession>,
    /// Files and folders Finder handed to the app ("Open With" or a
    /// double-click). The queue is the source of truth: it is filled before the
    /// webview can listen, drained once on mount, and drained again whenever
    /// `open-paths-pending` fires.
    pub(crate) pending_open_paths: Mutex<Vec<commands::OpenPath>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            grants: commands::GrantedPaths::default(),
            scan_jobs: commands::ScanJobs::default(),
            trash_cancel: commands::CancelGroup::default(),
            batch_cancel: commands::CancelGroup::default(),
            duplicate_cancel: commands::CancelGroup::default(),
            file_duplicates: Mutex::new(commands::FileDuplicateSession::default()),
            pending_open_paths: Mutex::new(Vec::new()),
        }
    }
}

/// Fires after an opened path reaches the queue. Deliberately payload free:
/// the queue holds the paths, so a wake-up that races the mount costs one
/// empty drain instead of losing the open.
const OPEN_PATHS_PENDING: &str = "open-paths-pending";

/// Canonical form of a Finder-opened path, or `None` when it no longer exists.
fn canonical_open_path(raw: &str) -> Option<PathBuf> {
    let path = PathBuf::from(raw);
    let canonical = path.canonicalize().unwrap_or(path);
    (canonical.is_file() || canonical.is_dir()).then_some(canonical)
}

/// Existing paths, canonicalised and deduplicated, in the order they arrived.
///
/// macOS delivers one launch through up to three routes — `RunEvent::Opened`,
/// a repeat launch's argv, and the first launch's argv — so the same file can
/// show up twice before the page drains the queue.
fn normalize_open_paths(raw_paths: Vec<String>) -> Vec<commands::OpenPath> {
    let mut entries: Vec<commands::OpenPath> = Vec::new();
    for raw in raw_paths {
        let Some(path) = canonical_open_path(&raw) else {
            tracing::warn!("opened path '{raw}' no longer exists; ignored");
            continue;
        };
        let path = path.to_string_lossy().into_owned();
        if entries.iter().any(|queued| queued.path == path) {
            continue;
        }
        let is_dir = PathBuf::from(&path).is_dir();
        entries.push(commands::OpenPath { path, is_dir });
    }
    entries
}

/// Grant and queue the paths Finder opened, then wake the frontend.
fn push_open_paths(app: &tauri::AppHandle, raw_paths: Vec<String>) {
    let entries = normalize_open_paths(raw_paths);
    if entries.is_empty() {
        return;
    }
    let state: State<'_, AppState> = app.state();
    for entry in &entries {
        let path = PathBuf::from(&entry.path);
        // Finder is the user choosing a path, exactly like a picker or a drop:
        // grant it, or `import_files` rejects it as never having been chosen.
        state.grants.grant([&path]);
        // A video that plays natively is served from the original file, so the
        // asset protocol must be able to read it for this session.
        let scope = app.asset_protocol_scope();
        let allowed = if entry.is_dir {
            scope.allow_directory(&path, true)
        } else {
            scope.allow_file(&path)
        };
        if let Err(error) = allowed {
            tracing::warn!(
                "opened path '{}' was not granted to the asset scope: {error}",
                entry.path
            );
        }
    }

    let added = {
        let mut pending = state
            .pending_open_paths
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut added = 0;
        for entry in entries {
            if pending.iter().any(|queued| queued.path == entry.path) {
                continue;
            }
            pending.push(entry);
            added += 1;
        }
        added
    };

    if added > 0 {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit(OPEN_PATHS_PENDING, ());
        }
    }
}

/// Hand every queued Finder path to the page. Taking the queue empties it, so
/// a drain that runs twice can never import the same open twice.
#[tauri::command]
fn take_pending_open_paths(state: State<'_, AppState>) -> Vec<commands::OpenPath> {
    let mut pending = state
        .pending_open_paths
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::take(&mut *pending)
}

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();
    tauri::Builder::default()
        // A second launch (common after a crash/relaunch) focuses the existing
        // instance instead of spawning a duplicate process that plays the same
        // media at the same time.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // A second launch carrying files ("Open With" while the app is
            // already running) hands them over as arguments.
            let paths: Vec<String> = args
                .into_iter()
                .skip(1)
                .filter(|argument| !argument.starts_with('-'))
                .collect();
            if !paths.is_empty() {
                push_open_paths(app, paths);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(Catalog::default())
        .manage(commands::HiddenLock::default())
        // Native drops are user intent: grant the dropped paths before the
        // webview relays them to `import_files`.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let state: State<'_, AppState> = window.state();
                state.grants.grant(paths);
            }
            // Closing the window locks Hidden again.
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                window.state::<commands::HiddenLock>().lock();
            }
        })
        .setup(|app| {
            commands::hidden_lock::observe_screen_lock(app.handle().clone());
            // Initialize database (await so it's ready before any invoke). A
            // locked or damaged catalog must not crash launch: the error is
            // returned by every command so the UI can explain it.
            let app_handle = app.handle().clone();
            let catalog: State<'_, Catalog> = app_handle.state();
            let opened = tauri::async_runtime::block_on(async {
                let db = Database::open(&app_handle).await?;
                let folders = db.registered_folders().await;
                let media_dirs = db.media_item_parent_dirs().await;
                anyhow::Ok((db, folders, media_dirs))
            });
            match opened {
                Ok((db, folders, media_dirs)) => {
                    // A restored or hand-edited catalog can list any folder.
                    // Only grant roots that are real folders under the user's
                    // home or a mounted volume; never `/`.
                    let home = app_handle
                        .path()
                        .home_dir()
                        .unwrap_or_else(|_| std::path::PathBuf::from("/Users"));
                    for folder in folders {
                        match commands::security::paths::grantable_root(&folder, &home) {
                            Ok(path) => {
                                let _ = app_handle
                                    .asset_protocol_scope()
                                    .allow_directory(&path, true);
                            }
                            Err(reason) => tracing::warn!(
                                "registered root '{folder}' was not granted to the asset scope: {reason}"
                            ),
                        }
                    }
                    // Files imported on their own (not via a registered folder)
                    // lost their per-session asset grant on restart. Re-grant
                    // the directories that hold cataloged items so originals
                    // load without re-importing. These are held to the same
                    // rule as registered roots — an existing folder under the
                    // user's home or a mounted volume, never `/` — so a
                    // hand-edited catalog cannot widen read access to the
                    // whole filesystem.
                    for dir in media_dirs {
                        match commands::security::paths::grantable_root(&dir, &home) {
                            Ok(path) => {
                                let _ = app_handle
                                    .asset_protocol_scope()
                                    .allow_directory(&path, true);
                            }
                            Err(reason) => tracing::warn!(
                                "media directory '{dir}' was not granted to the asset scope: {reason}"
                            ),
                        }
                    }
                    // A track picked in Settings is authorized for the session
                    // only; re-grant it at launch so the show can play it after
                    // a restart. A drive that is not mounted is skipped here and
                    // fails at play time with a message, not silently.
                    match tauri::async_runtime::block_on(
                        commands::load_persisted_settings(db.pool()),
                    ) {
                        Ok(settings) => {
                            if let Some(path) =
                                settings.slideshow_background_audio_path.as_deref()
                            {
                                let file = std::path::PathBuf::from(path);
                                if let Ok(canonical) = file.canonicalize() {
                                    if canonical.is_file() {
                                        let _ = app_handle
                                            .asset_protocol_scope()
                                            .allow_file(&canonical);
                                    }
                                }
                            }
                        }
                        Err(error) => tracing::warn!(
                            "could not read settings to re-grant ambient audio: {error:#}"
                        ),
                    }
                    let background = db.handle();
                    catalog.set(Ok(db.pool().clone()));
                    let sweep_app = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        // Nothing hidden may sit readable in the cache folder.
                        commands::storage::purge_hidden_from_caches(&sweep_app, background.pool())
                            .await;
                        if let Err(error) = background.run_backfills().await {
                            tracing::warn!("catalog backfill failed: {error:#}");
                        }
                    });
                }
                Err(error) => {
                    tracing::error!("could not open the catalog: {error:#}");
                    catalog.set(Err(CommandError::internal(format!("{error:#}"))));
                }
            }

            // Clear stale "save a copy" staging files from previous sessions.
            // Cheap, best effort; a missing folder is not an error.
            let _ = commands::sweep_export_staging(std::time::Duration::from_secs(3600));

            // Create and set menu
            let app_handle = app.handle();
            let menu = create_menu(app_handle)?;
            app.set_menu(menu)?;

            // Handle menu events
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                // Lock natively first, so it holds even if the page is busy.
                if id == "view_lock_hidden" {
                    app.state::<commands::HiddenLock>().lock();
                }
                if dispatch_menu_event(app, id) {
                    return;
                }
                match id {
                    "file_close_window" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.close();
                        }
                    }
                    "file_quit" => {
                        app.exit(0);
                    }
                    _ => {}
                }
            });

            // A first launch can already carry paths as arguments (`open -a`,
            // or "Open With" before the process exists). macOS also delivers
            // the same open through `RunEvent::Opened`; the queue dedupes the
            // overlap. Read argv last so the state and menu exist first.
            let launch_paths: Vec<String> = std::env::args_os()
                .skip(1)
                .filter_map(|argument| argument.into_string().ok())
                .filter(|argument| !argument.starts_with('-'))
                .collect();
            if !launch_paths.is_empty() {
                push_open_paths(app.handle(), launch_paths);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Storage
            get_storage_usage,
            clear_cache,
            scan_junk,
            clean_junk,
            reveal_junk,
            open_trash,
            set_junk_ignored,
            list_junk_ignored,
            get_cleanup_overview,
            set_cleanup_personal_folders,
            // Library
            scan_library,
            pick_source_folders,
            pick_media_files,
            pick_ambient_audio,
            cancel_scan,
            cancel_move_to_trash,
            cancel_find_duplicates,
            find_file_duplicates,
            trash_file_duplicates,
            import_files,
            get_library_items,
            get_matching_ids,
            get_display_preview,
            default_apps_status,
            set_default_app,
            hidden_lock_status,
            unlock_hidden,
            keep_hidden_unlocked,
            lock_hidden,
            get_timeline_months,
            get_hidden_items,
            get_hidden_stats,
            get_items_by_ids,
            get_albums,
            get_album_overviews,
            get_album_items,
            get_tags,
            get_item_thumbnail,
            watch_folder,
            unwatch_folder,
            get_library_roots,
            get_library_folders,
            get_library_stats,
            remove_library_folder,
            delete_library_database,
            // Items
            toggle_favorite,
            toggle_hidden,
            set_rating,
            set_color_label,
            update_item_tags,
            move_to_trash,
            restore_trashed_items,
            reveal_in_finder,
            open_file,
            open_with_player,
            external_video_players,
            prepare_playback,
            convert_playback,
            cancel_playback_conversion,
            log_playback_diagnostic,
            open_folder,
            // Albums
            create_album,
            delete_album,
            rename_album,
            reorder_albums,
            add_to_album,
            remove_from_album,
            // Smart Albums
            get_smart_albums,
            create_smart_album,
            update_smart_album,
            rename_smart_album,
            delete_smart_album,
            get_smart_album_items,
            // Catalog backup / restore
            preview_root_path_mapping,
            apply_root_path_mapping,
            choose_root_mapping_folder,
            create_catalog_backup,
            validate_catalog_backup,
            restore_catalog_backup,
            choose_backup_destination,
            choose_backup_file,
            // Metadata
            read_exif,
            backfill_metadata,
            supported_extensions,
            // Editing
            render_edited,
            save_exported_file,
            save_edit_recipe,
            get_edit_recipe,
            list_edit_recipes,
            delete_edit_recipe,
            revert_edit_recipe,
            copy_edit_recipe,
            batch_apply_edit,
            save_edit_preset,
            list_edit_presets,
            delete_edit_preset,
            apply_edit_preset,
            vacuum_catalog,
            // Batch
            batch_export,
            choose_export_folder,
            cancel_batch_export,
            // Duplicates
            find_duplicates,
            // Finder
            write_finder_tags,
            read_finder_tags,
            merge_finder_tags,
            // Settings
            get_settings,
            save_settings,
            // App
            get_version,
            check_updates,
            open_external,
            export_bytes,
            take_pending_open_paths,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS delivers Finder opens here while the app is running; a cold
            // launch arrives through argv as well, and the queue dedupes it.
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let RunEvent::Opened { urls } = event {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                push_open_paths(app, paths);
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("visto-open-paths-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp workspace");
        root
    }

    #[test]
    fn open_paths_keep_one_entry_per_existing_path() {
        let root = temp_workspace("dedupe");
        let file = root.join("photo.jpg");
        std::fs::write(&file, b"not really a jpeg").expect("write temp file");
        let missing = root.join("gone.jpg");

        let entries = normalize_open_paths(vec![
            file.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            // The same file again, through a redundant path spelling.
            format!("{}/./photo.jpg", root.to_string_lossy()),
            missing.to_string_lossy().into_owned(),
        ]);

        assert_eq!(entries.len(), 2, "one file, one folder, no duplicates");
        assert_eq!(
            entries[0].path,
            file.canonicalize().unwrap().to_string_lossy()
        );
        assert!(!entries[0].is_dir);
        assert!(entries[1].is_dir);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn file_associations_match_the_supported_extensions() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("valid tauri.conf.json");
        let mut claimed: Vec<&str> = config["bundle"]["fileAssociations"]
            .as_array()
            .expect("bundle.fileAssociations")
            .iter()
            .flat_map(|association| {
                association["ext"]
                    .as_array()
                    .expect("association ext list")
                    .iter()
                    .map(|ext| ext.as_str().expect("extension is a string"))
            })
            .collect();
        claimed.sort_unstable();

        let mut supported: Vec<&str> = crate::media_kind::EXTENSION_TABLE
            .iter()
            .map(|(ext, _)| *ext)
            .collect();
        supported.sort_unstable();

        assert_eq!(
            claimed, supported,
            "\"Open With\" must claim exactly the extensions the catalog accepts"
        );
    }
}
