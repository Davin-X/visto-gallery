use crate::AppState;
use super::*;
use sqlx::SqlitePool;
use tauri::State;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let db = super::get_db(&state)?;
    Ok(load_persisted_settings(&db).await?)
}

/// Load the full set of persisted settings rows from the `settings` table into
/// an `AppSettings`, starting from `AppSettings::default()` for any keys not
/// yet stored. Shared by `get_settings` and `save_settings` so the read contract
/// lives in one place and a partial save can merge onto the *real* persisted
/// state instead of `AppSettings::default()`.
async fn load_persisted_settings(db: &SqlitePool) -> Result<AppSettings, String> {
    let rows = sqlx::query("SELECT key, value FROM settings")
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    let mut settings = AppSettings::default();
    for row in rows {
        let key: String = row.get("key");
        let value: String = row.get("value");
        apply_setting(&mut settings, &key, &value);
    }
    Ok(settings)
}

#[tauri::command]
pub async fn save_settings(patch: PartialSettings, state: State<'_, AppState>) -> Result<AppSettings, String> {
    let db = super::get_db(&state)?;
    // Start from the SETTINGS CURRENTLY PERSISTED, then apply the incoming
    // patch on top. Previously this began from `AppSettings::default()`, which
    // silently reset every key NOT present in a partial patch to its default and
    // wrote those defaults back to disk — the root cause of settings "resetting"
    // on each save.
    let mut settings = load_persisted_settings(&db).await?;
    if let Some(v) = patch.appearance { settings.appearance = v; }
    if let Some(v) = patch.accent_color { settings.accent_color = v; }
    if let Some(v) = patch.sidebar_width { settings.sidebar_width = v; }
    if let Some(v) = patch.show_extensions { settings.show_extensions = v; }
    if let Some(v) = patch.animate_transitions { settings.animate_transitions = v; }
    if let Some(v) = patch.startup_view { settings.startup_view = v; }
    if let Some(v) = patch.open_last_folder { settings.open_last_folder = v; }
    if let Some(v) = patch.restore_window_state { settings.restore_window_state = v; }
    if let Some(v) = patch.default_layout { settings.default_layout = v; }
    if let Some(v) = patch.thumbnail_size { settings.thumbnail_size = v; }
    if let Some(v) = patch.viewer_zoom_behavior { settings.viewer_zoom_behavior = v; }
    if let Some(v) = patch.slideshow_interval { settings.slideshow_interval = v; }
    if let Some(v) = patch.slideshow_shuffle { settings.slideshow_shuffle = v; }
    if let Some(v) = patch.slideshow_loop { settings.slideshow_loop = v; }
    if let Some(v) = patch.video_auto_play { settings.video_auto_play = v; }
    if let Some(v) = patch.video_loop { settings.video_loop = v; }
    if let Some(v) = patch.watch_folders { settings.watch_folders = v; }
    if let Some(v) = patch.auto_import { settings.auto_import = v; }
    if let Some(v) = patch.pair_raw_jpeg { settings.pair_raw_jpeg = v; }
    if let Some(v) = patch.stack_bursts { settings.stack_bursts = v; }
    if let Some(v) = patch.stack_live_photos { settings.stack_live_photos = v; }
    if let Some(v) = patch.max_cache_size_gb { settings.max_cache_size_gb = v; }
    if let Some(v) = patch.thumbnail_quality { settings.thumbnail_quality = v; }
    if let Some(v) = patch.enable_debug_logging { settings.enable_debug_logging = v; }
    if let Some(v) = patch.show_native_limit_warnings { settings.show_native_limit_warnings = v; }

    let settings_map = vec![
        ("appearance", settings.appearance.clone()),
        ("accent_color", settings.accent_color.clone()),
        ("sidebar_width", settings.sidebar_width.to_string()),
        ("show_extensions", settings.show_extensions.to_string()),
        ("animate_transitions", settings.animate_transitions.to_string()),
        ("startup_view", settings.startup_view.clone()),
        ("open_last_folder", settings.open_last_folder.to_string()),
        ("restore_window_state", settings.restore_window_state.to_string()),
        ("default_layout", settings.default_layout.clone()),
        ("thumbnail_size", settings.thumbnail_size.clone()),
        ("viewer_zoom_behavior", settings.viewer_zoom_behavior.clone()),
        ("slideshow_interval", settings.slideshow_interval.to_string()),
        ("slideshow_shuffle", settings.slideshow_shuffle.to_string()),
        ("slideshow_loop", settings.slideshow_loop.to_string()),
        ("video_auto_play", settings.video_auto_play.to_string()),
        ("video_loop", settings.video_loop.to_string()),
        ("watch_folders", serde_json::to_string(&settings.watch_folders).unwrap_or_else(|_| "[]".to_string())),
        ("auto_import", settings.auto_import.to_string()),
        ("pair_raw_jpeg", settings.pair_raw_jpeg.to_string()),
        ("stack_bursts", settings.stack_bursts.to_string()),
        ("stack_live_photos", settings.stack_live_photos.to_string()),
        ("max_cache_size_gb", settings.max_cache_size_gb.to_string()),
        ("thumbnail_quality", settings.thumbnail_quality.to_string()),
        ("enable_debug_logging", settings.enable_debug_logging.to_string()),
        ("show_native_limit_warnings", settings.show_native_limit_warnings.to_string()),
    ];

    for (key, value) in settings_map {
        sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
            .bind(key)
            .bind(value)
            .execute(&db)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(settings)
}
