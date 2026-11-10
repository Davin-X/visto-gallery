use crate::errors::CommandError;
#[tauri::command]
pub async fn get_version() -> Result<String, CommandError> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), CommandError> {
    let trimmed = url.trim();
    let allowed = trimmed.starts_with("https://") || trimmed.starts_with("mailto:");
    if !allowed {
        return Err(CommandError::invalid("Unsupported URL scheme".to_string()));
    }
    std::process::Command::new("open")
        .arg(trimmed)
        .status()
        .map_err(|e| CommandError::io(format!("Could not open {}: {}", trimmed, e)))?;
    Ok(())
}
