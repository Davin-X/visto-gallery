//! Cancellation for long operations that are neither scans nor imports
//! (trash, batch export, duplicate hashing).
//!
//! Each invocation registers its own flag inside a [`CancelGroup`]. The old
//! design used one process-global `AtomicBool` per kind, which every new run
//! reset: starting a second trash operation silently un-cancelled the first,
//! and a Cancel arriving for one run cancelled every other run of the same
//! kind. Tokens are unregistered when their operation finishes, so a Cancel
//! only ever affects the runs that were active when it arrived.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::State;

use crate::errors::CommandError;
use crate::AppState;

/// The cancel flags of every running operation of one kind.
#[derive(Default)]
pub(crate) struct CancelGroup {
    active: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    next_id: AtomicU64,
}

/// A running operation's own cancel flag. Dropping it unregisters the flag, so
/// a later Cancel for the same kind cannot affect it.
pub(crate) struct CancelToken<'a> {
    group: &'a CancelGroup,
    id: u64,
    flag: Arc<AtomicBool>,
}

impl CancelToken<'_> {
    /// The flag to poll between units of work (clone it into blocking tasks).
    pub(crate) fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

impl Drop for CancelToken<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.group.active.lock() {
            active.remove(&self.id);
        }
    }
}

impl CancelGroup {
    /// Register a new operation with its own, not-yet-cancelled flag.
    pub(crate) fn start(&self) -> CancelToken<'_> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut active) = self.active.lock() {
            active.insert(id, Arc::clone(&flag));
        }
        CancelToken {
            group: self,
            id,
            flag,
        }
    }

    /// Cancel every operation of this kind running now. Runs started later are
    /// unaffected.
    pub(crate) fn cancel_all(&self) {
        if let Ok(active) = self.active.lock() {
            for flag in active.values() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    /// How many operations of this kind are registered (tests and diagnostics).
    #[cfg(test)]
    pub(crate) fn active_count(&self) -> usize {
        self.active.lock().map(|a| a.len()).unwrap_or(0)
    }
}

/// Cancel every folder scan and file import that is running now.
#[tauri::command]
pub async fn cancel_scan(state: State<'_, AppState>) -> Result<(), CommandError> {
    state.scan_jobs.cancel_all();
    Ok(())
}

#[tauri::command]
pub async fn cancel_move_to_trash(state: State<'_, AppState>) -> Result<(), CommandError> {
    state.trash_cancel.cancel_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::CancelGroup;

    #[test]
    fn cancelling_affects_running_operations_only() {
        let group = CancelGroup::default();
        let first = group.start();
        assert!(!first.is_cancelled());

        group.cancel_all();
        assert!(first.is_cancelled(), "the active run is cancelled");
        assert_eq!(group.active_count(), 1);

        // A new run starts fresh even though the previous one was cancelled.
        let second = group.start();
        assert!(!second.is_cancelled());
        drop(first);
        assert_eq!(group.active_count(), 1, "finished runs unregister");

        // Cancelling again reaches the second run only.
        group.cancel_all();
        assert!(second.is_cancelled());
    }

    #[test]
    fn starting_one_operation_does_not_reset_another() {
        let group = CancelGroup::default();
        let first = group.start();
        group.cancel_all();
        let _second = group.start();
        assert!(
            first.is_cancelled(),
            "a second run must not un-cancel the first"
        );
    }

    #[test]
    fn dropping_the_token_unregisters_the_flag() {
        let group = CancelGroup::default();
        assert_eq!(group.active_count(), 0);
        {
            let _token = group.start();
            assert_eq!(group.active_count(), 1);
        }
        assert_eq!(group.active_count(), 0);
    }
}
