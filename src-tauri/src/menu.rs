use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

/// Menu items that forward to the webview as window events. Everything else
/// (close window, quit, fullscreen) is handled natively below.
const MENU_EVENTS: &[(&str, &str)] = &[
    ("file_open_folder", "menu-open-folder"),
    ("file_import_files", "menu-import-files"),
    ("file_export", "menu-export"),
    ("view_toggle_sidebar", "menu-toggle-sidebar"),
    ("view_toggle_inspector", "menu-toggle-inspector"),
    ("view_zoom_in", "menu-zoom-in"),
    ("view_zoom_out", "menu-zoom-out"),
    ("help_about", "menu-about"),
    ("help_check_updates", "menu-check-updates"),
    ("help_shortcuts", "menu-shortcuts"),
    ("file_settings", "menu-settings"),
];

/// The window event a menu item id maps to, when there is one.
pub fn menu_event_for_id(id: &str) -> Option<&'static str> {
    MENU_EVENTS
        .iter()
        .find(|(item_id, _)| *item_id == id)
        .map(|(_, window_event)| *window_event)
}

/// Emit the window event for `id` on the main window. Returns true when the
/// id was a forwarding menu item.
pub fn dispatch_menu_event(app: &AppHandle, id: &str) -> bool {
    let Some(window_event) = menu_event_for_id(id) else {
        return false;
    };
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.emit(window_event, ());
        }
    });
    true
}

pub fn create_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    // File menu
    let open_folder = MenuItemBuilder::new("Open Folder…")
        .id("file_open_folder")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;

    let import_files = MenuItemBuilder::new("Import Files…")
        .id("file_import_files")
        .accelerator("CmdOrCtrl+I")
        .build(app)?;

    let export = MenuItemBuilder::new("Export…")
        .id("file_export")
        .accelerator("CmdOrCtrl+E")
        .build(app)?;

    let settings = MenuItemBuilder::new("Settings…")
        .id("file_settings")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let close_window = MenuItemBuilder::new("Close Window")
        .id("file_close_window")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    let quit = MenuItemBuilder::new("Quit VistoGallery")
        .id("file_quit")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .items(&[
            &open_folder,
            &import_files,
            &PredefinedMenuItem::separator(app)?,
            &export,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &close_window,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ])
        .build()?;

    // Edit menu
    let undo = PredefinedMenuItem::undo(app, Some("Undo"))?;
    let redo = PredefinedMenuItem::redo(app, Some("Redo"))?;
    let cut = PredefinedMenuItem::cut(app, Some("Cut"))?;
    let copy = PredefinedMenuItem::copy(app, Some("Copy"))?;
    let paste = PredefinedMenuItem::paste(app, Some("Paste"))?;
    let select_all = PredefinedMenuItem::select_all(app, Some("Select All"))?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .items(&[
            &undo,
            &redo,
            &PredefinedMenuItem::separator(app)?,
            &cut,
            &copy,
            &paste,
            &PredefinedMenuItem::separator(app)?,
            &select_all,
        ])
        .build()?;

    // View menu. Full Screen uses muda's predefined item so the entry toggles
    // both ways instead of only entering fullscreen.
    let toggle_sidebar = MenuItemBuilder::new("Toggle Sidebar")
        .id("view_toggle_sidebar")
        .accelerator("CmdOrCtrl+\\")
        .build(app)?;

    let toggle_inspector = MenuItemBuilder::new("Toggle Inspector")
        .id("view_toggle_inspector")
        .accelerator("CmdOrCtrl+Alt+I")
        .build(app)?;

    let zoom_in = MenuItemBuilder::new("Zoom In")
        .id("view_zoom_in")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;

    let zoom_out = MenuItemBuilder::new("Zoom Out")
        .id("view_zoom_out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;

    let fullscreen = PredefinedMenuItem::fullscreen(app, Some("Toggle Full Screen"))?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .items(&[
            &toggle_sidebar,
            &toggle_inspector,
            &PredefinedMenuItem::separator(app)?,
            &zoom_in,
            &zoom_out,
            &PredefinedMenuItem::separator(app)?,
            &fullscreen,
        ])
        .build()?;

    // Window menu. Zoom uses muda's predefined maximize toggle so the item
    // does something (the custom "Zoom" had no handler and did nothing).
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let zoom = PredefinedMenuItem::maximize(app, Some("Zoom"))?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .items(&[&minimize, &zoom, &PredefinedMenuItem::separator(app)?])
        .build()?;

    // Help menu
    let shortcuts = MenuItemBuilder::new("Keyboard Shortcuts…")
        .id("help_shortcuts")
        .build(app)?;

    let about = MenuItemBuilder::new("About VistoGallery")
        .id("help_about")
        .build(app)?;

    let check_updates = MenuItemBuilder::new("Check for Updates")
        .id("help_check_updates")
        .build(app)?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .items(&[
            &shortcuts,
            &PredefinedMenuItem::separator(app)?,
            &about,
            &PredefinedMenuItem::separator(app)?,
            &check_updates,
        ])
        .build()?;

    MenuBuilder::new(app)
        .items(&[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()
}

#[cfg(test)]
mod tests {
    use super::menu_event_for_id;

    #[test]
    fn forwarding_items_map_to_their_window_event() {
        assert_eq!(menu_event_for_id("file_export"), Some("menu-export"));
        assert_eq!(
            menu_event_for_id("help_check_updates"),
            Some("menu-check-updates")
        );
        assert_eq!(menu_event_for_id("help_shortcuts"), Some("menu-shortcuts"));
        assert_eq!(menu_event_for_id("file_settings"), Some("menu-settings"));
    }

    #[test]
    fn native_items_and_unknown_ids_are_not_forwarded() {
        assert_eq!(menu_event_for_id("file_quit"), None);
        assert_eq!(menu_event_for_id("view_fullscreen"), None);
        assert_eq!(menu_event_for_id("no_such_item"), None);
    }

    #[test]
    fn forwarding_ids_are_unique() {
        let mut ids: Vec<&'static str> = super::MENU_EVENTS.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), super::MENU_EVENTS.len());
    }
}
