//! Make VistoGallery the app Finder uses to open photos and videos.
//!
//! macOS asks the user to confirm each content type separately, whichever API
//! is used, and there is no batch call. So the groups the Settings panel
//! offers are kept short (three photo types, two video types), types that
//! already open with VistoGallery are never asked again, and the frontend
//! changes one type at a time so the system dialogs arrive one after another.
//! Every other declared type is changed only when the user picks it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::errors::CommandError;

/// The bundle identifier in `tauri.conf.json`.
const BUNDLE_ID: &str = "com.vistogallery.desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DefaultAppGroup {
    Photos,
    Videos,
    /// Offered one type at a time, never as part of a group.
    Other,
}

impl DefaultAppGroup {
    /// The app that opens this group on a fresh Mac, for "Use Preview".
    fn system_app(self) -> Option<&'static str> {
        match self {
            Self::Photos => Some("com.apple.Preview"),
            Self::Videos => Some("com.apple.QuickTimePlayerX"),
            Self::Other => None,
        }
    }
}

struct KnownType {
    uti: &'static str,
    label: &'static str,
    /// An extension the bundle declares for this type (pinned by a test).
    #[cfg_attr(not(test), allow(dead_code))]
    ext: &'static str,
    group: DefaultAppGroup,
}

const fn known(
    uti: &'static str,
    label: &'static str,
    ext: &'static str,
    group: DefaultAppGroup,
) -> KnownType {
    KnownType {
        uti,
        label,
        ext,
        group,
    }
}

use DefaultAppGroup::{Other, Photos, Videos};

/// What the panel offers, in display order. Each group button asks once per
/// type it changes, so adding to Photos or Videos adds a system dialog.
const TYPES: &[KnownType] = &[
    known("public.jpeg", "JPEG", "jpg", Photos),
    known("public.png", "PNG", "png", Photos),
    known("public.heic", "HEIC", "heic", Photos),
    known("public.mpeg-4", "MP4", "mp4", Videos),
    known("com.apple.quicktime-movie", "MOV", "mov", Videos),
    known("com.compuserve.gif", "GIF", "gif", Other),
    known("org.webmproject.webp", "WebP", "webp", Other),
    known("public.tiff", "TIFF", "tiff", Other),
    known("com.microsoft.bmp", "BMP", "bmp", Other),
    known("public.avif", "AVIF", "avif", Other),
    known("public.heif", "HEIF", "heif", Other),
    known("public.jpeg-xl", "JPEG XL", "jxl", Other),
    known("public.avi", "AVI", "avi", Other),
    known("public.3gpp", "3GP", "3gp", Other),
    known("public.mpeg", "MPEG", "mpg", Other),
    known("org.webmproject.webm", "WebM", "webm", Other),
    known("org.matroska.mkv", "MKV", "mkv", Other),
];

fn find(uti: &str) -> Option<&'static KnownType> {
    TYPES.iter().find(|known| known.uti == uti)
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAppType {
    pub uti: String,
    pub label: String,
    pub group: DefaultAppGroup,
    /// The app Finder opens this type with now, by display name.
    pub handler_name: Option<String>,
    pub is_visto: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAppsStatus {
    /// False in `tauri dev` and on other platforms: only the installed app
    /// bundle can become a default.
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub types: Vec<DefaultAppType>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DefaultAppTarget {
    /// VistoGallery itself.
    Visto,
    /// Preview for photos, QuickTime Player for videos.
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SetDefaultOutcome {
    Changed,
    /// The user declined the system dialog (or macOS refused the change).
    Declined,
}

#[tauri::command]
pub async fn default_apps_status() -> Result<DefaultAppsStatus, CommandError> {
    tauri::async_runtime::spawn_blocking(status)
        .await
        .map_err(|e| CommandError::internal(format!("Could not read default apps: {e}")))
}

fn status() -> DefaultAppsStatus {
    let unsupported_reason = native::own_bundle_url().err();
    let types = TYPES
        .iter()
        .map(|known| {
            let handler = native::handler(known.uti);
            DefaultAppType {
                uti: known.uti.to_string(),
                label: known.label.to_string(),
                group: known.group,
                is_visto: handler.as_ref().is_some_and(|(id, _)| id == BUNDLE_ID),
                handler_name: handler.map(|(_, name)| name),
            }
        })
        .collect();
    DefaultAppsStatus {
        supported: unsupported_reason.is_none(),
        unsupported_reason,
        types,
    }
}

/// Change the default app for one type. macOS may show its own confirmation
/// first; this resolves once the user has answered it.
#[tauri::command]
pub async fn set_default_app(
    uti: String,
    target: DefaultAppTarget,
) -> Result<SetDefaultOutcome, CommandError> {
    let known = find(&uti)
        .ok_or_else(|| CommandError::invalid(format!("Not a type VistoGallery opens: {uti}")))?;
    let app_id = match target {
        DefaultAppTarget::Visto => BUNDLE_ID,
        DefaultAppTarget::System => known.group.system_app().ok_or_else(|| {
            CommandError::invalid(format!("{} has no standard app to restore", known.label))
        })?,
    };
    if native::handler(known.uti).is_some_and(|(id, _)| id == app_id) {
        return Ok(SetDefaultOutcome::Changed);
    }
    let app_url = match target {
        DefaultAppTarget::Visto => native::own_bundle_url(),
        DefaultAppTarget::System => native::app_url(app_id),
    }
    .map_err(CommandError::invalid)?;

    let uti = known.uti;
    let (done, result) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = done.send(native::set_default(app_url, uti));
    });
    let reply = result
        .await
        .unwrap_or_else(|_| Err("The default-app request stopped.".to_string()));
    if let Err(message) = &reply {
        eprintln!("visto: default app for {uti} not changed: {message}");
    }
    // Trust what Launch Services reports, not the error: a decline and a
    // refusal both leave the old handler in place.
    let changed = native::handler(uti).is_some_and(|(id, _)| id == app_id);
    Ok(if changed {
        SetDefaultOutcome::Changed
    } else {
        SetDefaultOutcome::Declined
    })
}

#[cfg(target_os = "macos")]
mod native {
    use std::sync::Mutex;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSError, NSString, NSURL};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}
    #[link(name = "UniformTypeIdentifiers", kind = "framework")]
    extern "C" {}

    /// A system dialog left open this long counts as declined.
    const ANSWER_TIMEOUT: Duration = Duration::from_secs(10 * 60);

    /// Wrapper so the bundle URL can move to the worker thread. `NSURL` is
    /// immutable and documented as thread-safe.
    pub(super) struct AppUrl(Retained<NSURL>);
    unsafe impl Send for AppUrl {}

    fn workspace() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"NSWorkspace")?;
        unsafe { msg_send![class, sharedWorkspace] }
    }

    fn ut_type(uti: &str) -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"UTType")?;
        unsafe { msg_send![class, typeWithIdentifier: &*NSString::from_str(uti)] }
    }

    fn path_of(url: &NSURL) -> Option<String> {
        url.path().map(|path| path.to_string())
    }

    /// The running app's bundle, when it is the installed VistoGallery.app.
    pub(super) fn own_bundle_url() -> Result<AppUrl, String> {
        let unbundled =
            || "Default apps can be set from the installed VistoGallery app.".to_string();
        let class = AnyClass::get(c"NSBundle").ok_or_else(unbundled)?;
        unsafe {
            let bundle: Option<Retained<AnyObject>> = msg_send![class, mainBundle];
            let bundle = bundle.ok_or_else(unbundled)?;
            let id: Option<Retained<NSString>> = msg_send![&*bundle, bundleIdentifier];
            let url: Option<Retained<NSURL>> = msg_send![&*bundle, bundleURL];
            let url = url.ok_or_else(unbundled)?;
            let is_app = path_of(&url).is_some_and(|path| path.ends_with(".app"));
            if !is_app || id.map(|id| id.to_string()).as_deref() != Some(super::BUNDLE_ID) {
                return Err(unbundled());
            }
            Ok(AppUrl(url))
        }
    }

    pub(super) fn app_url(bundle_id: &str) -> Result<AppUrl, String> {
        let workspace = workspace().ok_or("Launch Services is unavailable.")?;
        let url: Option<Retained<NSURL>> = unsafe {
            msg_send![&*workspace, URLForApplicationWithBundleIdentifier: &*NSString::from_str(bundle_id)]
        };
        url.map(AppUrl)
            .ok_or_else(|| format!("{bundle_id} is not installed on this Mac."))
    }

    /// (bundle identifier, display name) of the app that opens `uti` now.
    pub(super) fn handler(uti: &str) -> Option<(String, String)> {
        let workspace = workspace()?;
        let content_type = ut_type(uti)?;
        unsafe {
            let url: Option<Retained<NSURL>> =
                msg_send![&*workspace, URLForApplicationToOpenContentType: &*content_type];
            let url = url?;
            let bundle_class = AnyClass::get(c"NSBundle")?;
            let bundle: Option<Retained<AnyObject>> = msg_send![bundle_class, bundleWithURL: &*url];
            let id: Option<Retained<NSString>> = match &bundle {
                Some(bundle) => msg_send![&**bundle, bundleIdentifier],
                None => None,
            };
            let path = url.path()?;
            let manager_class = AnyClass::get(c"NSFileManager")?;
            let manager: Retained<AnyObject> = msg_send![manager_class, defaultManager];
            let name: Retained<NSString> = msg_send![&*manager, displayNameAtPath: &*path];
            let name = name.to_string();
            let name = name.strip_suffix(".app").unwrap_or(&name).to_string();
            Some((id.map(|id| id.to_string()).unwrap_or_default(), name))
        }
    }

    /// Ask Launch Services to change the handler and wait for its answer,
    /// which comes after any system dialog. Blocks: run on its own thread.
    pub(super) fn set_default(app: AppUrl, uti: &'static str) -> Result<(), String> {
        let workspace = workspace().ok_or("Launch Services is unavailable.")?;
        let content_type = ut_type(uti).ok_or_else(|| format!("macOS does not know {uti}."))?;
        let (reply_tx, reply_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let reply_tx = Mutex::new(Some(reply_tx));
        let completion = RcBlock::new(move |error: *mut NSError| {
            let outcome = match unsafe { error.as_ref() } {
                None => Ok(()),
                Some(error) => Err(error.localizedDescription().to_string()),
            };
            if let Some(tx) = reply_tx.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(outcome);
            }
        });
        unsafe {
            let _: () = msg_send![
                &*workspace,
                setDefaultApplicationAtURL: &*app.0,
                toOpenContentType: &*content_type,
                completionHandler: &*completion
            ];
        }
        reply_rx
            .recv_timeout(ANSWER_TIMEOUT)
            .unwrap_or_else(|_| Err("No answer to the system dialog.".to_string()))
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    pub(super) struct AppUrl;

    const UNSUPPORTED: &str = "Default apps can only be set on macOS.";

    pub(super) fn own_bundle_url() -> Result<AppUrl, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub(super) fn app_url(_bundle_id: &str) -> Result<AppUrl, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub(super) fn handler(_uti: &str) -> Option<(String, String)> {
        None
    }

    pub(super) fn set_default(_app: AppUrl, _uti: &'static str) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_stay_small_because_each_type_is_one_system_dialog() {
        let count = |group| TYPES.iter().filter(|known| known.group == group).count();
        assert_eq!(count(Photos), 3);
        assert_eq!(count(Videos), 2);
    }

    #[test]
    fn every_offered_type_is_one_the_bundle_declares() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json");
        let groups = config["bundle"]["fileAssociations"]
            .as_array()
            .expect("fileAssociations");
        let declared: Vec<&str> = groups
            .iter()
            .flat_map(|group| group["ext"].as_array().into_iter().flatten())
            .filter_map(|ext| ext.as_str())
            .collect();
        for known in TYPES {
            assert!(
                declared.contains(&known.ext),
                "{} ({}) is offered but .{} is not in fileAssociations",
                known.label,
                known.uti,
                known.ext
            );
        }
    }

    #[test]
    fn types_are_unique_and_only_groups_can_be_restored() {
        for (index, known) in TYPES.iter().enumerate() {
            assert!(
                TYPES[index + 1..]
                    .iter()
                    .all(|other| other.uti != known.uti),
                "{} listed twice",
                known.uti
            );
        }
        assert!(Photos.system_app().is_some());
        assert!(Videos.system_app().is_some());
        assert!(Other.system_app().is_none());
    }

    #[tokio::test]
    async fn refuses_types_it_does_not_offer() {
        let error = set_default_app("public.plain-text".into(), DefaultAppTarget::Visto)
            .await
            .expect_err("text is not offered");
        assert!(error.to_string().contains("public.plain-text"));
        let error = set_default_app("com.compuserve.gif".into(), DefaultAppTarget::System)
            .await
            .expect_err("GIF has no system app to restore");
        assert!(error.to_string().contains("GIF"));
    }
}
