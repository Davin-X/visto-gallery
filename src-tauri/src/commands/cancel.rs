use std::sync::atomic::{AtomicBool, Ordering};

use tauri::State;

use crate::errors::CommandError;
use crate::AppState;

/// Cooperative cancellation flags for long operations that are not folder
/// scans or imports (those use per-job flags in [`super::ScanJobs`]).
pub(crate) static TRASH_CANCEL: AtomicBool = AtomicBool::new(false);
pub(crate) static DUPLICATE_CANCEL: AtomicBool = AtomicBool::new(false);
pub(crate) static BATCH_CANCEL: AtomicBool = AtomicBool::new(false);

/// Cancel every folder scan and file import that is running now.
#[tauri::command]
pub async fn cancel_scan(state: State<'_, AppState>) -> Result<(), CommandError> {
    state.scan_jobs.cancel_all();
    Ok(())
}

#[tauri::command]
pub async fn cancel_move_to_trash() -> Result<(), CommandError> {
    TRASH_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}
