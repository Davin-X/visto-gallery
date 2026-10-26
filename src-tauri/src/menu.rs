use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::AppHandle;

pub fn create_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    // File menu
    let new_window = MenuItemBuilder::new("New Window")
        .id("file_new_window")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;

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
            &new_window,
            &open_folder,
            &import_files,
            &PredefinedMenuItem::separator(app)?,
            &export,
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

    // View menu
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

    let fullscreen = MenuItemBuilder::new("Enter Full Screen")
        .id("view_fullscreen")
        .accelerator("Ctrl+Cmd+F")
        .build(app)?;

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

    // Window menu
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let zoom = MenuItemBuilder::new("Zoom").id("window_zoom").build(app)?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .items(&[&minimize, &zoom, &PredefinedMenuItem::separator(app)?])
        .build()?;

    // Help menu
    let about = MenuItemBuilder::new("About VistoGallery")
        .id("help_about")
        .build(app)?;

    let check_updates = MenuItemBuilder::new("Check for Updates")
        .id("help_check_updates")
        .build(app)?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .items(&[&about, &PredefinedMenuItem::separator(app)?, &check_updates])
        .build()?;

    MenuBuilder::new(app)
        .items(&[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()
}
