use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{Emitter, Manager, State};

// Modules
mod commands;
mod db;
mod menu;
mod models;

use commands::*;
use db::Database;
use menu::create_menu;

struct AppState {
    db: Mutex<Option<Database>>,
    watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            db: Mutex::new(None),
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // Initialize database (await so it's ready before any invoke)
            let app_handle = app.handle().clone();
            let db = tauri::async_runtime::block_on(async {
                let handle = app_handle.clone();
                let db = Database::new(&handle)
                    .await
                    .expect("Failed to initialize database");
                for folder in db.registered_folders().await {
                    let _ = handle.asset_protocol_scope().allow_directory(&folder, true);
                }
                db
            });
            let state: State<'_, AppState> = app_handle.state();
            *state.db.lock().unwrap() = Some(db);

            // Create and set menu
            let app_handle = app.handle();
            let menu = create_menu(&app_handle)?;
            app.set_menu(menu)?;

            // Handle menu events
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "file_open_folder" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("menu-open-folder", ());
                        }
                    });
                }
                "file_import_files" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("menu-import-files", ());
                        }
                    });
                }
                "file_export" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("menu-export", ());
                        }
                    });
                }
                "file_close_window" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.close();
                    }
                }
                "file_quit" => {
                    app.exit(0);
                }
                "view_toggle_sidebar" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("menu-toggle-sidebar", ());
                        }
                    });
                }
                "view_toggle_inspector" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("menu-toggle-inspector", ());
                        }
                    });
                }
                "view_zoom_in" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("menu-zoom-in", ());
                        }
                    });
                }
                "view_zoom_out" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("menu-zoom-out", ());
                        }
                    });
                }
                "view_fullscreen" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_fullscreen(true);
                    }
                }
                "help_about" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("menu-about", ());
                        }
                    });
                }
                "help_check_updates" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("menu-check-updates", ());
                        }
                    });
                }
                _ => {}
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Library
            scan_library,
            cancel_scan,
            cancel_move_to_trash,
            cancel_find_duplicates,
            import_files,
            get_library_items,
            get_albums,
            get_tags,
            get_item_thumbnail,
            watch_folder,
            unwatch_folder,
            get_library_folders,
            remove_library_folder,
            delete_library_database,
            // Items
            toggle_favorite,
            toggle_hidden,
            update_item_tags,
            move_to_trash,
            reveal_in_finder,
            open_folder,
            // Albums
            create_album,
            delete_album,
            rename_album,
            add_to_album,
            remove_from_album,
            // Metadata
            read_exif,
            write_exif,
            // Editing
            render_edited,
            move_exported_file,
            // Batch
            batch_export,
            cancel_batch_export,
            // Duplicates
            find_duplicates,
            // (removed compute_hash stub)
            // Finder
            write_finder_tags,
            read_finder_tags,
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
