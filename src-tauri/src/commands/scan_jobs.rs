//! Cancellation and per-root serialization for folder scans and imports.
//!
//! Each scan or import gets its own cancel flag, so starting one operation
//! can never un-cancel another (the old single global flag was reset by every
//! new scan). Scans of the same root also take a per-root lock, so a manual
//! rescan and a watcher-triggered scan never interleave catalog writes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct ScanJobs {
    active: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    root_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    next_id: AtomicU64,
}

/// A running scan or import. Dropping it unregisters its cancel flag.
pub struct ScanJob<'a> {
    jobs: &'a ScanJobs,
    id: u64,
    cancel: Arc<AtomicBool>,
}

impl ScanJob<'_> {
    /// The flag to poll between units of work (clone it into blocking tasks).
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

impl Drop for ScanJob<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.jobs.active.lock() {
            active.remove(&self.id);
        }
    }
}

impl ScanJobs {
    /// Register a new operation with its own, not-yet-cancelled flag.
    pub fn start(&self) -> ScanJob<'_> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut active) = self.active.lock() {
            active.insert(id, Arc::clone(&cancel));
        }
        ScanJob {
            jobs: self,
            id,
            cancel,
        }
    }

    /// Cancel every scan and import running now. Operations started later
    /// are unaffected.
    pub fn cancel_all(&self) {
        if let Ok(active) = self.active.lock() {
            for flag in active.values() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    /// The lock that serializes scans of `root` (a normalized root path).
    pub fn root_lock(&self, root: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.root_locks.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(locks.entry(root.to_string()).or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::ScanJobs;

    #[test]
    fn starting_a_job_does_not_uncancel_another() {
        let jobs = ScanJobs::default();
        let first = jobs.start();
        jobs.cancel_all();
        let second = jobs.start();
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
    }

    #[test]
    fn cancel_all_reaches_every_running_job() {
        let jobs = ScanJobs::default();
        let a = jobs.start();
        let b = jobs.start();
        jobs.cancel_all();
        assert!(a.is_cancelled() && b.is_cancelled());
    }

    #[test]
    fn finished_jobs_are_unregistered() {
        let jobs = ScanJobs::default();
        drop(jobs.start());
        assert!(jobs.active.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn same_root_scans_are_serialized() {
        let jobs = ScanJobs::default();
        let lock = jobs.root_lock("/Photos");
        let _held = lock.lock().await;
        assert!(jobs.root_lock("/Photos").try_lock().is_err());
        assert!(jobs.root_lock("/Other").try_lock().is_ok());
    }
}
