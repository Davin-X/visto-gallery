use super::*;
use crate::errors::CommandError;
use sqlx::SqlitePool;
use tauri::State;

#[tauri::command]
pub async fn get_settings(catalog: State<'_, crate::Catalog>) -> Result<AppSettings, CommandError> {
    let db = super::get_db(&catalog)?;
    load_persisted_settings(&db).await
}

/// Load the full set of persisted settings rows from the `settings` table into
/// an `AppSettings`, starting from `AppSettings::default()` for any keys not
/// yet stored. Shared by `get_settings` and `save_settings` so the read contract
/// lives in one place and a partial save can merge onto the *real* persisted
/// state instead of `AppSettings::default()`.
async fn load_persisted_settings(db: &SqlitePool) -> Result<AppSettings, CommandError> {
    let rows = sqlx::query("SELECT key, value FROM settings")
        .fetch_all(db)
        .await?;
    let mut settings = AppSettings::default();
    for row in rows {
        let key: String = row.get("key");
        let value: String = row.get("value");
        apply_setting(&mut settings, &key, &value);
    }
    normalize_settings(&mut settings);
    Ok(settings)
}

/// Keep persisted values inside the range the UI and the caches can handle.
/// Applied on read as well, so a database written by an older build (or by
/// hand) self-heals instead of surprising the caches with a zero budget.
fn normalize_settings(settings: &mut AppSettings) {
    // 0 GB would make every thumbnail miss and immediately prune the cache.
    settings.max_cache_size_gb = settings.max_cache_size_gb.clamp(1, 50);
    settings.thumbnail_quality = settings.thumbnail_quality.clamp(1, 100);
    settings.slideshow_interval = settings.slideshow_interval.clamp(1, 3600);
    // A watched folder must be absolute: a relative path resolves against an
    // unpredictable working directory (a Finder launch starts at `/`).
    settings.watch_folders.retain(|folder| {
        let trimmed = folder.trim();
        !trimmed.is_empty() && std::path::Path::new(trimmed).is_absolute()
    });
}

/// Reject a watch-folder list the app could never use, before anything is
/// written. Silently dropping entries would hide a broken caller.
fn validate_watch_folders(folders: &[String]) -> Result<(), CommandError> {
    for folder in folders {
        let trimmed = folder.trim();
        if trimmed.is_empty() {
            return Err(CommandError::invalid(
                "A watched folder path cannot be empty.".to_string(),
            ));
        }
        if !std::path::Path::new(trimmed).is_absolute() {
            return Err(CommandError::invalid(format!(
                "A watched folder must be an absolute path: {folder}"
            )));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn save_settings(
    patch: PartialSettings,
    catalog: State<'_, crate::Catalog>,
) -> Result<AppSettings, CommandError> {
    let db = super::get_db(&catalog)?;
    save_settings_into(&db, patch).await
}

/// The body of `save_settings`, split out so it can be tested against an
/// in-memory database without a Tauri `State`.
async fn save_settings_into(
    db: &SqlitePool,
    patch: PartialSettings,
) -> Result<AppSettings, CommandError> {
    // Start from the SETTINGS CURRENTLY PERSISTED, then apply the incoming
    // patch on top. Previously this began from `AppSettings::default()`, which
    // silently reset every key NOT present in a partial patch to its default and
    // wrote those defaults back to disk — the root cause of settings "resetting"
    // on each save.
    let mut settings = load_persisted_settings(db).await?;
    if let Some(v) = patch.appearance {
        settings.appearance = v;
    }
    if let Some(v) = patch.accent_color {
        settings.accent_color = v;
    }
    if let Some(v) = patch.sidebar_width {
        settings.sidebar_width = v;
    }
    if let Some(v) = patch.inspector_width {
        settings.inspector_width = v;
    }
    if let Some(v) = patch.show_extensions {
        settings.show_extensions = v;
    }
    if let Some(v) = patch.animate_transitions {
        settings.animate_transitions = v;
    }
    if let Some(v) = patch.startup_view {
        settings.startup_view = v;
    }
    if let Some(v) = patch.open_last_folder {
        settings.open_last_folder = v;
    }
    if let Some(v) = patch.restore_window_state {
        settings.restore_window_state = v;
    }
    if let Some(v) = patch.default_layout {
        settings.default_layout = v;
    }
    if let Some(v) = patch.thumbnail_size {
        settings.thumbnail_size = v;
    }
    if let Some(v) = patch.albums_view {
        settings.albums_view = v;
    }
    if let Some(v) = patch.viewer_zoom_behavior {
        settings.viewer_zoom_behavior = v;
    }
    if let Some(v) = patch.slideshow_interval {
        settings.slideshow_interval = v;
    }
    if let Some(v) = patch.slideshow_shuffle {
        settings.slideshow_shuffle = v;
    }
    if let Some(v) = patch.slideshow_loop {
        settings.slideshow_loop = v;
    }
    if let Some(v) = patch.video_auto_play {
        settings.video_auto_play = v;
    }
    if let Some(v) = patch.video_loop {
        settings.video_loop = v;
    }
    if let Some(v) = patch.watch_folders {
        validate_watch_folders(&v)?;
        settings.watch_folders = v;
    }
    if let Some(v) = patch.auto_import {
        settings.auto_import = v;
    }
    if let Some(v) = patch.pair_raw_jpeg {
        settings.pair_raw_jpeg = v;
    }
    if let Some(v) = patch.stack_bursts {
        settings.stack_bursts = v;
    }
    if let Some(v) = patch.stack_live_photos {
        settings.stack_live_photos = v;
    }
    if let Some(v) = patch.check_for_updates_on_launch {
        settings.check_for_updates_on_launch = v;
    }
    if let Some(v) = patch.max_cache_size_gb {
        settings.max_cache_size_gb = v;
    }
    if let Some(v) = patch.thumbnail_quality {
        settings.thumbnail_quality = v;
    }
    if let Some(v) = patch.enable_debug_logging {
        settings.enable_debug_logging = v;
    }
    if let Some(v) = patch.show_native_limit_warnings {
        settings.show_native_limit_warnings = v;
    }

    normalize_settings(&mut settings);

    let settings_map = vec![
        ("appearance", settings.appearance.to_string()),
        ("accent_color", settings.accent_color.to_string()),
        ("sidebar_width", settings.sidebar_width.to_string()),
        ("inspector_width", settings.inspector_width.to_string()),
        ("show_extensions", settings.show_extensions.to_string()),
        (
            "animate_transitions",
            settings.animate_transitions.to_string(),
        ),
        ("startup_view", settings.startup_view.to_string()),
        ("open_last_folder", settings.open_last_folder.to_string()),
        (
            "restore_window_state",
            settings.restore_window_state.to_string(),
        ),
        ("default_layout", settings.default_layout.to_string()),
        ("thumbnail_size", settings.thumbnail_size.to_string()),
        ("albums_view", settings.albums_view.to_string()),
        (
            "viewer_zoom_behavior",
            settings.viewer_zoom_behavior.to_string(),
        ),
        (
            "slideshow_interval",
            settings.slideshow_interval.to_string(),
        ),
        ("slideshow_shuffle", settings.slideshow_shuffle.to_string()),
        ("slideshow_loop", settings.slideshow_loop.to_string()),
        ("video_auto_play", settings.video_auto_play.to_string()),
        ("video_loop", settings.video_loop.to_string()),
        (
            "watch_folders",
            serde_json::to_string(&settings.watch_folders).unwrap_or_else(|_| "[]".to_string()),
        ),
        ("auto_import", settings.auto_import.to_string()),
        ("pair_raw_jpeg", settings.pair_raw_jpeg.to_string()),
        ("stack_bursts", settings.stack_bursts.to_string()),
        ("stack_live_photos", settings.stack_live_photos.to_string()),
        (
            "check_for_updates_on_launch",
            settings.check_for_updates_on_launch.to_string(),
        ),
        ("max_cache_size_gb", settings.max_cache_size_gb.to_string()),
        ("thumbnail_quality", settings.thumbnail_quality.to_string()),
        (
            "enable_debug_logging",
            settings.enable_debug_logging.to_string(),
        ),
        (
            "show_native_limit_warnings",
            settings.show_native_limit_warnings.to_string(),
        ),
    ];

    // One transaction: a failure part-way must not leave half the settings
    // saved and the rest from the previous write.
    let mut transaction = db.begin().await.map_err(|error| {
        CommandError::database(format!("could not start saving settings: {error}"))
    })?;
    for (key, value) in settings_map {
        sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
            .bind(key)
            .bind(value)
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await.map_err(|error| {
        CommandError::database(format!("could not finish saving settings: {error}"))
    })?;

    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_db() -> SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create settings table");
        db
    }

    #[tokio::test]
    async fn save_clamps_values_the_caches_cannot_handle() {
        let db = test_db().await;
        let saved = save_settings_into(
            &db,
            PartialSettings {
                max_cache_size_gb: Some(0),
                thumbnail_quality: Some(1000),
                slideshow_interval: Some(-4),
                ..Default::default()
            },
        )
        .await
        .expect("save settings");

        assert_eq!(saved.max_cache_size_gb, 1, "0 GB would wipe the cache");
        assert_eq!(saved.thumbnail_quality, 100);
        assert_eq!(saved.slideshow_interval, 1);

        // The clamped values are what later reads see, not just the response.
        let reloaded = load_persisted_settings(&db).await.expect("reload");
        assert_eq!(reloaded.max_cache_size_gb, 1);
        assert_eq!(reloaded.thumbnail_quality, 100);
        assert_eq!(reloaded.slideshow_interval, 1);
    }

    #[tokio::test]
    async fn save_rejects_a_relative_watch_folder_without_writing_anything() {
        let db = test_db().await;
        let error = match save_settings_into(
            &db,
            PartialSettings {
                watch_folders: Some(vec!["Pictures/Watch".to_string()]),
                thumbnail_quality: Some(90),
                ..Default::default()
            },
        )
        .await
        {
            Ok(_) => panic!("a relative path cannot be a watch folder"),
            Err(error) => error,
        };

        assert!(error.message.contains("absolute"), "{}", error.message);
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM settings")
            .fetch_one(&db)
            .await
            .expect("count settings");
        assert_eq!(rows, 0, "a rejected save must not write a partial patch");
    }

    #[tokio::test]
    async fn save_keeps_keys_the_patch_does_not_mention() {
        let db = test_db().await;
        save_settings_into(
            &db,
            PartialSettings {
                appearance: Some(Appearance::Light),
                ..Default::default()
            },
        )
        .await
        .expect("first save");

        save_settings_into(
            &db,
            PartialSettings {
                sidebar_width: Some(260),
                ..Default::default()
            },
        )
        .await
        .expect("second save");

        let reloaded = load_persisted_settings(&db).await.expect("reload");
        assert!(matches!(reloaded.appearance, Appearance::Light));
        assert_eq!(reloaded.sidebar_width, 260);
    }

    #[tokio::test]
    async fn absolute_watch_folders_are_persisted() {
        let db = test_db().await;
        save_settings_into(
            &db,
            PartialSettings {
                watch_folders: Some(vec!["/Users/example/Pictures".to_string()]),
                ..Default::default()
            },
        )
        .await
        .expect("save settings");

        let reloaded = load_persisted_settings(&db).await.expect("reload");
        assert_eq!(
            reloaded.watch_folders,
            vec!["/Users/example/Pictures".to_string()]
        );
    }
}
