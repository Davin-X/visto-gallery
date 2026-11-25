use crate::errors::CommandError;
use tauri::State;

#[tauri::command]
pub async fn reveal_in_finder(
    path: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    let exists: Option<String> = sqlx::query_scalar("SELECT path FROM media_items WHERE path = ?")
        .bind(&path)
        .fetch_optional(&db)
        .await?;
    if exists.is_none() {
        return Err(CommandError::path(
            "Path is not part of the catalog.".to_string(),
        ));
    }
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| CommandError::io(format!("Could not reveal {}: {}", path, e)))?;
    // `open` exits non-zero when the file is gone, e.g. on an unplugged drive.
    if !status.success() {
        return Err(CommandError::io(format!("Could not reveal {}.", path)));
    }
    Ok(())
}

#[tauri::command]
pub async fn open_file(
    path: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<(), CommandError> {
    let db = super::get_db(&catalog)?;
    let exists: Option<String> = sqlx::query_scalar("SELECT path FROM media_items WHERE path = ?")
        .bind(&path)
        .fetch_optional(&db)
        .await?;
    if exists.is_none() {
        return Err(CommandError::path(
            "Path is not part of the catalog.".to_string(),
        ));
    }
    let status = std::process::Command::new("open")
        .arg(&path)
        .status()
        .map_err(|e| CommandError::io(format!("Could not open {}: {}", path, e)))?;
    // `open` exits non-zero when the file is gone or no app can open it.
    if !status.success() {
        return Err(CommandError::io(format!("Could not open {}.", path)));
    }
    Ok(())
}
