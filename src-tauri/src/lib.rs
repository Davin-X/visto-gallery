use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use sqlx::SqlitePool;
use tauri::{Manager, State};

// Modules
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
        }
    }
}

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();
    tauri::Builder::default()
        // A second launch (common after a crash/relaunch) focuses the existing
        // instance instead of spawning a duplicate process that plays the same
        // media at the same time.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(Catalog::default())
        // Native drops are user intent: grant the dropped paths before the
        // webview relays them to `import_files`.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let state: State<'_, AppState> = window.state();
                state.grants.grant(paths);
            }
        })
        .setup(|app| {
            // Initialize database (await so it's ready before any invoke). A
            // locked or damaged catalog must not crash launch: the error is
            // returned by every command so the UI can explain it.
            let app_handle = app.handle().clone();
            let catalog: State<'_, Catalog> = app_handle.state();
            let opened = tauri::async_runtime::block_on(async {
                let db = Database::open(&app_handle).await?;
                let folders = db.registered_folders().await;
                anyhow::Ok((db, folders))
            });
            match opened {
                Ok((db, folders)) => {
                    for folder in folders {
                        let _ = app_handle
                            .asset_protocol_scope()
                            .allow_directory(&folder, true);
                    }
                    let background = db.handle();
                    catalog.set(Ok(db.pool().clone()));
                    tauri::async_runtime::spawn(async move {
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Library
            scan_library,
            pick_source_folders,
            pick_media_files,
            cancel_scan,
            cancel_move_to_trash,
            cancel_find_duplicates,
            import_files,
            get_library_items,
            get_matching_ids,
            get_hidden_items,
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
            create_catalog_backup,
            validate_catalog_backup,
            restore_catalog_backup,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
