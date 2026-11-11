//! Where the bundled `ffmpeg` and `ffprobe` live.
//!
//! Both are Tauri sidecars: they are copied next to the app binary when the app
//! is bundled, and into `target/debug` by `tauri dev`. So the folder holding the
//! running executable is the first place worth looking, and a plain Homebrew
//! install is only a fallback for people who built the app themselves without
//! running `scripts/build-ffmpeg.sh`.
//!
//! One locator, used by playback and by poster generation, keeps that order in a
//! single place instead of two copies of a search path that drift apart.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const FFMPEG: &str = "ffmpeg";
pub const FFPROBE: &str = "ffprobe";

/// Point at a directory holding both tools. Used by development builds and by
/// the tests, which must not depend on what is installed on the machine.
const OVERRIDE_ENV: &str = "VISTO_FFMPEG_DIR";

/// Where a Homebrew or MacPorts install keeps them.
const SYSTEM_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/// Resolve a tool to an executable file, preferring the copy bundled with the app.
pub fn find(name: &str) -> Option<PathBuf> {
    let executable = std::env::current_exe().ok();
    locate(
        name,
        executable.as_deref(),
        std::env::var_os(OVERRIDE_ENV),
        std::env::var_os("PATH"),
        SYSTEM_DIRS,
    )
}

/// The search itself, with every ambient input passed in so it is testable.
///
/// Order: explicit override, bundled sidecar, macOS resources folder, a system
/// install, then `PATH` — the most specific answer first, so an app that ships a
/// working tool is never downgraded by whatever happens to be in `/usr/local`.
///
/// `system_dirs` is a parameter rather than [`SYSTEM_DIRS`] so the tests can
/// describe a machine without Homebrew, whatever the one running them has.
fn locate(
    name: &str,
    executable: Option<&Path>,
    override_dir: Option<OsString>,
    path_var: Option<OsString>,
    system_dirs: &[&str],
) -> Option<PathBuf> {
    if let Some(dir) = override_dir {
        let candidate = Path::new(&dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    if let Some(dir) = executable.and_then(Path::parent) {
        let mut bundled = vec![dir.join(name)];
        // The bundler strips the target triple, but a raw sidecar download keeps
        // it, and a developer may have installed one by hand.
        if let Some(triple) = option_env!("VISTO_TARGET") {
            bundled.push(dir.join(format!("{name}-{triple}")));
        }
        for candidate in bundled {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        // A macOS bundle keeps resources in the folder beside `Contents/MacOS`.
        // Resolved through the parent rather than `../Resources` so the returned
        // path is the real one, not a string with `..` in the middle of it.
        if let Some(contents) = dir.parent() {
            for candidate in [
                contents.join("Resources").join(name),
                contents.join("Resources").join("binaries").join(name),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    for dir in system_dirs {
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    path_var
        .as_deref()
        .and_then(|paths| std::env::split_paths(paths).map(|dir| dir.join(name)).find(|candidate| candidate.is_file()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory with a file of the given name inside it.
    fn dir_with(files: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "visto-tools-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create dir");
        for file in files {
            std::fs::write(dir.join(file), b"").expect("write file");
        }
        dir
    }

    #[test]
    fn bundled_sidecar_beats_a_system_install() {
        let app_dir = dir_with(&["visto-gallery", FFMPEG]);
        let found = locate(FFMPEG, Some(&app_dir.join("visto-gallery")), None, None, &[])
            .expect("bundled tool");
        assert_eq!(found, app_dir.join(FFMPEG));
        let _ = std::fs::remove_dir_all(app_dir);
    }

    #[test]
    fn resources_folder_is_checked_for_the_macos_bundle_layout() {
        let app = dir_with(&[]);
        let macos = app.join("Contents/MacOS");
        let resources = app.join("Contents/Resources");
        std::fs::create_dir_all(&macos).expect("create macos dir");
        std::fs::create_dir_all(&resources).expect("create resources dir");
        std::fs::write(resources.join(FFPROBE), b"").expect("write tool");

        let found = locate(FFPROBE, Some(&macos.join("VistoGallery")), None, None, &[])
            .expect("resource tool");
        assert_eq!(found, resources.join(FFPROBE));
        let _ = std::fs::remove_dir_all(app);
    }

    #[test]
    fn override_directory_wins_over_the_bundle() {
        let app_dir = dir_with(&["visto-gallery", FFMPEG]);
        let override_dir = dir_with(&[FFMPEG]);
        let found = locate(
            FFMPEG,
            Some(&app_dir.join("visto-gallery")),
            Some(override_dir.clone().into_os_string()),
            None,
            &[],
        )
        .expect("override tool");
        assert_eq!(found, override_dir.join(FFMPEG));
        let _ = std::fs::remove_dir_all(app_dir);
        let _ = std::fs::remove_dir_all(override_dir);
    }

    #[test]
    fn path_entries_are_the_last_resort() {
        let dir = dir_with(&[FFMPEG]);
        let found = locate(FFMPEG, None, None, Some(dir.clone().into_os_string()), &[]);
        assert_eq!(found, Some(dir.join(FFMPEG)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_tool_resolves_to_nothing() {
        assert_eq!(
            locate("definitely-not-a-tool", None, None, None, SYSTEM_DIRS),
            None
        );
    }
}
