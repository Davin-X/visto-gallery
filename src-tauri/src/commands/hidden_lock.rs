//! Touch ID / Mac password lock for the Hidden collection.
//!
//! Hidden items are veiled, not encrypted: their files stay where they are on
//! disk. The lock keeps the app itself from listing them (or their count and
//! size) until the person at the Mac proves they are its owner through the
//! system prompt, which offers Touch ID and falls back to the login password.
//!
//! An unlock lasts while Hidden is in use and for [`UNLOCK_GRACE`] after the
//! last activity there. It ends early when the screen locks or the window
//! closes. Expiry uses wall-clock time, so time asleep counts.

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::State;
use ts_rs::TS;

use crate::errors::{CommandError, ErrorCode};

/// How long an unlock survives without activity in Hidden, by default.
pub(crate) const UNLOCK_GRACE: Duration = Duration::from_secs(5 * 60);

/// The unlock lifetime for the "Lock Hidden again" setting. "As soon as you
/// leave" (0) keeps a short lifetime that the screen's keep-alive renews; the
/// app locks explicitly when Hidden is left. "Only when the screen locks"
/// (-1) lasts until the screen locks or the window closes.
pub(crate) fn grace_for(minutes: i32) -> Duration {
    match minutes {
        -1 => Duration::from_secs(30 * 24 * 60 * 60),
        0 => Duration::from_secs(2 * 60),
        n if n > 0 => Duration::from_secs(n as u64 * 60),
        _ => UNLOCK_GRACE,
    }
}

#[derive(Default)]
pub struct HiddenLock {
    unlocked_until: Mutex<Option<SystemTime>>,
}

impl HiddenLock {
    pub(crate) fn is_unlocked_at(&self, now: SystemTime) -> bool {
        self.unlocked_until
            .lock()
            .map(|until| until.is_some_and(|until| now < until))
            .unwrap_or(false)
    }

    pub(crate) fn is_unlocked(&self) -> bool {
        self.is_unlocked_at(SystemTime::now())
    }

    /// Start or extend an unlock from `now`, lasting `grace`.
    pub(crate) fn grant_at(&self, now: SystemTime, grace: Duration) {
        if let Ok(mut until) = self.unlocked_until.lock() {
            *until = Some(now + grace);
        }
    }

    /// Extend a live unlock; an expired one stays locked.
    pub(crate) fn extend_at(&self, now: SystemTime, grace: Duration) -> bool {
        if !self.is_unlocked_at(now) {
            return false;
        }
        self.grant_at(now, grace);
        true
    }

    pub(crate) fn lock(&self) {
        if let Ok(mut until) = self.unlocked_until.lock() {
            *until = None;
        }
    }
}

/// Whether the "Require Touch ID or password for Hidden" setting is on.
pub(crate) async fn unlock_required(db: &sqlx::SqlitePool) -> bool {
    lock_settings(db).await.0
}

/// (unlock required, how long an unlock lasts).
async fn lock_settings(db: &sqlx::SqlitePool) -> (bool, Duration) {
    super::settings::load_persisted_settings(db)
        .await
        .map(|settings| {
            (
                settings.require_hidden_unlock,
                grace_for(settings.hidden_auto_lock_minutes),
            )
        })
        .unwrap_or((true, UNLOCK_GRACE))
}

/// May hidden items, or their count, be shown right now?
pub(crate) async fn hidden_visible(db: &sqlx::SqlitePool, lock: &HiddenLock) -> bool {
    !unlock_required(db).await || lock.is_unlocked()
}

/// Refuse with `Locked` unless Hidden may be shown. A successful check counts
/// as activity and extends the unlock.
pub(crate) async fn require_hidden_access(
    db: &sqlx::SqlitePool,
    lock: &HiddenLock,
) -> Result<(), CommandError> {
    let (required, grace) = lock_settings(db).await;
    if !required {
        return Ok(());
    }
    if lock.extend_at(SystemTime::now(), grace) {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorCode::Locked,
            "Hidden is locked. Unlock it with Touch ID or your Mac password.",
        ))
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HiddenLockStatus {
    /// The setting is on.
    pub required: bool,
    /// Hidden may be shown now (always true when not required).
    pub unlocked: bool,
    /// The Mac can authenticate its owner (it has a login password).
    pub available: bool,
    /// `"touchId"` when Touch ID can be offered, otherwise `"password"`.
    #[ts(type = "\"touchId\" | \"password\"")]
    pub method: String,
}

#[tauri::command]
pub async fn hidden_lock_status(
    catalog: State<'_, crate::Catalog>,
    lock: State<'_, HiddenLock>,
) -> Result<HiddenLockStatus, CommandError> {
    let db = super::get_db(&catalog)?;
    let required = unlock_required(&db).await;
    let (available, touch_id) = native::capabilities();
    Ok(HiddenLockStatus {
        required,
        unlocked: !required || lock.is_unlocked(),
        available,
        method: if touch_id { "touchId" } else { "password" }.to_string(),
    })
}

/// Ask the system to authenticate the Mac's owner. Returns whether Hidden is
/// unlocked afterwards; cancelling is `Ok(false)`, not an error.
#[tauri::command]
pub async fn unlock_hidden(
    catalog: State<'_, crate::Catalog>,
    lock: State<'_, HiddenLock>,
) -> Result<bool, CommandError> {
    let db = super::get_db(&catalog)?;
    let (required, grace) = lock_settings(&db).await;
    if !required || lock.is_unlocked() {
        return Ok(true);
    }
    let passed = native::authenticate("show your hidden photos and videos").await?;
    if passed {
        lock.grant_at(SystemTime::now(), grace);
    }
    Ok(passed)
}

/// Activity in Hidden keeps an unlock alive.
#[tauri::command]
pub async fn keep_hidden_unlocked(
    catalog: State<'_, crate::Catalog>,
    lock: State<'_, HiddenLock>,
) -> Result<bool, CommandError> {
    let db = super::get_db(&catalog)?;
    let (_, grace) = lock_settings(&db).await;
    Ok(lock.extend_at(SystemTime::now(), grace))
}

#[tauri::command]
pub async fn lock_hidden(lock: State<'_, HiddenLock>) -> Result<(), CommandError> {
    lock.lock();
    Ok(())
}

#[cfg(target_os = "macos")]
mod native {
    use std::ptr::NonNull;
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSDistributedNotificationCenter, NSError, NSNotification, NSString};
    use objc2_local_authentication::{LABiometryType, LAContext, LAPolicy};
    use tauri::{AppHandle, Manager};

    use crate::errors::CommandError;

    /// (owner authentication possible, Touch ID offered).
    pub(super) fn capabilities() -> (bool, bool) {
        unsafe {
            let context = LAContext::new();
            let available = context
                .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication)
                .is_ok();
            let touch_id = context
                .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
                .is_ok()
                && context.biometryType() == LABiometryType::TouchID;
            (available, touch_id)
        }
    }

    /// Run the system prompt on its own thread: `LAContext` is not `Send`,
    /// and it must stay alive until the reply arrives.
    pub(super) async fn authenticate(reason: &str) -> Result<bool, CommandError> {
        let reason = reason.to_string();
        let (done, result) = tokio::sync::oneshot::channel::<Result<bool, CommandError>>();
        std::thread::spawn(move || {
            let outcome = unsafe {
                let context = LAContext::new();
                if context
                    .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication)
                    .is_err()
                {
                    Err(CommandError::internal(
                        "This Mac cannot confirm its owner. Set a login password in System Settings.",
                    ))
                } else {
                    let (reply_tx, reply_rx) = std::sync::mpsc::channel::<bool>();
                    let reply_tx = Mutex::new(Some(reply_tx));
                    let reply = RcBlock::new(move |success: Bool, _error: *mut NSError| {
                        if let Some(tx) = reply_tx.lock().ok().and_then(|mut slot| slot.take()) {
                            let _ = tx.send(success.as_bool());
                        }
                    });
                    context.evaluatePolicy_localizedReason_reply(
                        LAPolicy::DeviceOwnerAuthentication,
                        &NSString::from_str(&reason),
                        &reply,
                    );
                    let passed = reply_rx.recv().unwrap_or(false);
                    drop(context);
                    Ok(passed)
                }
            };
            let _ = done.send(outcome);
        });
        result
            .await
            .unwrap_or_else(|_| Err(CommandError::internal("The unlock prompt stopped.")))
    }

    /// Lock Hidden as soon as the screen locks (which also covers sleep when
    /// the Mac asks for a password on wake). Call once, on the main thread.
    pub(super) fn observe_screen_lock(app: AppHandle) {
        unsafe {
            let center = NSDistributedNotificationCenter::defaultCenter();
            let block = RcBlock::new(move |_note: NonNull<NSNotification>| {
                app.state::<super::HiddenLock>().lock();
            });
            let token = center.addObserverForName_object_queue_usingBlock(
                Some(&NSString::from_str("com.apple.screenIsLocked")),
                None,
                None,
                &block,
            );
            // Observe for the life of the app.
            std::mem::forget(token);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use crate::errors::CommandError;
    use tauri::AppHandle;

    pub(super) fn capabilities() -> (bool, bool) {
        (false, false)
    }

    pub(super) async fn authenticate(_reason: &str) -> Result<bool, CommandError> {
        Err(CommandError::internal(
            "Unlocking Hidden needs macOS authentication.",
        ))
    }

    pub(super) fn observe_screen_lock(_app: AppHandle) {}
}

/// Start watching for screen locks. Call once from setup.
pub(crate) fn observe_screen_lock(app: tauri::AppHandle) {
    native::observe_screen_lock(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlock_lasts_the_grace_period_and_activity_extends_it() {
        let lock = HiddenLock::default();
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(!lock.is_unlocked_at(start), "starts locked");
        assert!(
            !lock.extend_at(start, UNLOCK_GRACE),
            "activity cannot unlock"
        );

        lock.grant_at(start, UNLOCK_GRACE);
        assert!(lock.is_unlocked_at(start + UNLOCK_GRACE - Duration::from_secs(1)));
        assert!(
            !lock.is_unlocked_at(start + UNLOCK_GRACE),
            "expires after the grace"
        );

        // Activity four minutes in pushes expiry to nine minutes.
        let active = start + Duration::from_secs(4 * 60);
        assert!(lock.extend_at(active, UNLOCK_GRACE));
        assert!(lock.is_unlocked_at(start + Duration::from_secs(8 * 60)));
        assert!(!lock.is_unlocked_at(active + UNLOCK_GRACE));
    }

    #[test]
    fn the_auto_lock_setting_sets_how_long_an_unlock_lasts() {
        assert_eq!(grace_for(1), Duration::from_secs(60));
        assert_eq!(grace_for(15), Duration::from_secs(15 * 60));
        assert_eq!(grace_for(5), UNLOCK_GRACE);
        // "As soon as you leave": short, renewed while Hidden is on screen.
        assert_eq!(grace_for(0), Duration::from_secs(2 * 60));
        // "Only when the screen locks": effectively until then.
        assert!(grace_for(-1) >= Duration::from_secs(7 * 24 * 60 * 60));
        assert_eq!(grace_for(-7), UNLOCK_GRACE);

        let lock = HiddenLock::default();
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        lock.grant_at(start, grace_for(1));
        assert!(lock.is_unlocked_at(start + Duration::from_secs(59)));
        assert!(!lock.is_unlocked_at(start + Duration::from_secs(60)));
    }

    #[test]
    fn locking_ends_an_unlock_at_once() {
        let lock = HiddenLock::default();
        let now = SystemTime::now();
        lock.grant_at(now, UNLOCK_GRACE);
        assert!(lock.is_unlocked_at(now));
        lock.lock();
        assert!(!lock.is_unlocked_at(now));
        assert!(
            !lock.extend_at(now, UNLOCK_GRACE),
            "an ended unlock cannot be extended"
        );
    }
}
