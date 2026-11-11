//! Universal in-app video playback.
//!
//! WebKit decodes a narrow slice of what people actually keep on disk. Matroska
//! and AVI never reach it at all, and inside MP4 a `hev1`-tagged HEVC stream or
//! an exotic pixel format renders a black frame with a working transport bar.
//! The extension is a poor predictor of any of that, so playback starts by
//! asking `ffprobe` what the file really contains, and only falls back to a
//! lossless remux against the cache.
//!
//! A remux copies the coded streams (`-c copy`): no re-encode, no generation
//! loss, and roughly disk speed. It fixes the things WebKit actually refuses —
//! `hev1` instead of `hvc1`, a Matroska wrapper around H.264/AAC, a damaged
//! index — while leaving the frames untouched. Anything whose codecs cannot
//! live in an MP4 at all (AC-3, DTS, VP8, 10-bit H.264) is reported as
//! unsupported rather than silently re-encoded.
//!
//! Both `ffprobe` and `ffmpeg` are resolved from a bundled sidecar first, then
//! from the usual Homebrew paths, then from `PATH`. When neither is installed
//! the extension allow-list keeps working as before, so the command never turns
//! a missing tool into a broken player.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::errors::{CommandError, ErrorCode};

/// Remuxed media kept in the cache before the oldest entries are removed.
const PLAYBACK_CACHE_BUDGET_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Containers `prepare_playback` may hand straight to `<video>` when no probe
/// is available. Mirrors `IN_APP_VIDEO_EXTENSIONS` on the frontend.
const NATIVE_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm", "ogv"];

/// What the file actually is, independent of its name.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    /// `ffprobe`'s format name, e.g. `mov,mp4,m4a,3gp,3g2,mj2`.
    pub container: String,
    pub video_codec: String,
    pub video_profile: Option<String>,
    pub pixel_format: Option<String>,
    /// FourCC of the video track (`hvc1`, `hev1`, `avc1`, ...). `hev1` is the
    /// reason a perfectly good HEVC MP4 plays black in WebKit.
    pub codec_tag: Option<String>,
    pub audio_codec: Option<String>,
    /// `ffprobe`'s audio profile (`LC`, `HE-AAC`, ...). Informational only:
    /// WebKit plays HE-AAC, so the profile never blocks in-app playback.
    pub audio_profile: Option<String>,
    pub width: u32,
    pub height: u32,
    pub duration_seconds: f64,
    pub has_subtitles: bool,
    pub bit_depth: u32,
    pub rotation: i32,
}

/// How `<video>` should be fed for this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStrategy {
    /// Play the original path.
    Native,
    /// Play the remuxed copy; `path` points at the cached file.
    Remuxed,
    /// Nothing in-app can decode it; offer an external player.
    Unsupported,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPlayback {
    pub strategy: PlaybackStrategy,
    /// The path to hand to `convertFileSrc`.
    pub path: String,
    pub probe: Option<MediaProbe>,
    /// Why no strategy applied, for the fallback screen.
    pub detail: Option<String>,
}

enum ProbeFailure {
    /// `ffprobe` is not installed, so only the extension list can decide.
    ToolMissing,
    Failed(String),
}

/// Locate a bundled sidecar, a Homebrew install, or a `PATH` entry.
pub(crate) fn find_tool(name: &str) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("VISTO_FFMPEG_DIR") {
        let candidate = Path::new(&dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // Tauri sidecars and bundled dylibs sit next to the executable.
    if let Ok(executable) = std::env::current_exe() {
        if let Some(dir) = executable.parent() {
            for folder in [dir.to_path_buf(), dir.join("../Resources")] {
                let candidate = folder.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Last `limit` characters of a tool's stderr, collapsed to one line.
fn tail(bytes: &[u8], limit: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = collapsed.chars().count();
    if count <= limit {
        return collapsed;
    }
    collapsed.chars().skip(count - limit).collect()
}

fn stream_i64(value: &serde_json::Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(|entry| entry.as_i64().or_else(|| entry.as_str()?.parse().ok()))
}

fn probe_sync(source: &Path) -> Result<MediaProbe, ProbeFailure> {
    let ffprobe = find_tool("ffprobe").ok_or(ProbeFailure::ToolMissing)?;
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(source)
        .output()
        .map_err(|error| ProbeFailure::Failed(format!("ffprobe could not run: {error}")))?;
    if !output.status.success() {
        return Err(ProbeFailure::Failed(format!(
            "ffprobe could not read this file: {}",
            tail(&output.stderr, 240)
        )));
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| ProbeFailure::Failed(format!("ffprobe output was not JSON: {error}")))?;

    let empty = Vec::new();
    let streams = value
        .get("streams")
        .and_then(|entry| entry.as_array())
        .unwrap_or(&empty);
    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(|kind| kind.as_str()) == Some("video"))
        .ok_or_else(|| ProbeFailure::Failed("the file has no video track".to_string()))?;
    let audio = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(|kind| kind.as_str()) == Some("audio"));
    let has_subtitles = streams
        .iter()
        .any(|stream| stream.get("codec_type").and_then(|kind| kind.as_str()) == Some("subtitle"));

    let text = |entry: &serde_json::Value, key: &str| -> Option<String> {
        entry
            .get(key)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty() && *value != "unknown")
            .map(str::to_string)
    };

    let pixel_format = text(video, "pix_fmt");
    let bit_depth = stream_i64(video, "bits_per_raw_sample")
        .map(|depth| depth as u32)
        .filter(|depth| *depth > 0)
        .unwrap_or_else(|| match pixel_format.as_deref() {
            Some(format) if format.contains("12") => 12,
            Some(format) if format.contains("10") => 10,
            _ => 8,
        });

    let rotation = video
        .get("side_data_list")
        .and_then(|entry| entry.as_array())
        .and_then(|list| {
            list.iter()
                .find_map(|side| stream_i64(side, "rotation").map(|value| value as i32))
        })
        .or_else(|| {
            video
                .get("tags")
                .and_then(|tags| stream_i64(tags, "rotate"))
                .map(|value| value as i32)
        })
        .unwrap_or(0);

    let duration_seconds = stream_i64(video, "duration")
        .map(|value| value as f64)
        .or_else(|| {
            value
                .get("format")
                .and_then(|format| format.get("duration"))
                .and_then(|entry| entry.as_str())
                .and_then(|entry| entry.parse::<f64>().ok())
        })
        .unwrap_or(0.0);

    Ok(MediaProbe {
        container: value
            .get("format")
            .and_then(|format| format.get("format_name"))
            .and_then(|entry| entry.as_str())
            .unwrap_or("unknown")
            .to_string(),
        video_codec: text(video, "codec_name").unwrap_or_else(|| "unknown".to_string()),
        video_profile: text(video, "profile"),
        pixel_format,
        codec_tag: text(video, "codec_tag_string").map(|tag| tag.to_lowercase()),
        audio_codec: audio.and_then(|stream| text(stream, "codec_name")),
        audio_profile: audio.and_then(|stream| text(stream, "profile")),
        width: stream_i64(video, "width").unwrap_or(0) as u32,
        height: stream_i64(video, "height").unwrap_or(0) as u32,
        duration_seconds,
        has_subtitles,
        bit_depth,
        rotation,
    })
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

/// Whether WebKit can decode this stream as it stands.
///
/// Deliberately conservative: a wrong "yes" costs the user a black screen,
/// while a wrong "no" costs them one remux that produces an identical file.
fn plays_natively(probe: &MediaProbe, extension: &str) -> bool {
    match extension {
        "mp4" | "m4v" | "mov" => match probe.video_codec.as_str() {
            // Hi10P and 4:2:2 H.264 have no hardware decoder in WebKit.
            "h264" => probe.bit_depth <= 8 && probe.pixel_format.as_deref() != Some("yuv422p"),
            // `hev1` carries in-band parameter sets; WebKit only accepts `hvc1`.
            "hevc" => probe.codec_tag.as_deref() != Some("hev1"),
            "vp9" | "av1" | "vp8" => true,
            _ => false,
        },
        "webm" => matches!(probe.video_codec.as_str(), "vp8" | "vp9" | "av1"),
        "ogv" => probe.video_codec == "theora",
        _ => false,
    }
}

/// What happens to the audio track during a remux.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioPlan {
    /// The track already plays; copy it untouched.
    Copy,
    /// Re-encode to AAC-LC (AC-3, DTS, FLAC, Opus, PCM, ...).
    Encode,
    /// The file has no audio track.
    None,
}

fn audio_plan(probe: &MediaProbe) -> AudioPlan {
    match probe.audio_codec.as_deref() {
        None => AudioPlan::None,
        // HE-AAC included: WebKit plays it, so it is copied like any other AAC.
        Some("aac" | "mp3" | "alac") => AudioPlan::Copy,
        Some(_) => AudioPlan::Encode,
    }
}

/// Whether a remux can produce something WebKit decodes. Only the video codec
/// can rule it out: audio is either copied or re-encoded to AAC-LC, which is
/// cheap because it leaves every video frame untouched.
fn remuxable(probe: &MediaProbe) -> bool {
    match probe.video_codec.as_str() {
        "h264" => probe.bit_depth <= 8 && probe.pixel_format.as_deref() != Some("yuv422p"),
        "hevc" => true,
        // WebKit decodes VP9 when it sits in an MP4 with the `vp09` tag, which
        // a copy produces (verified by rendering a remuxed VP9 Matroska in
        // WKWebView). This is what makes VP9/Opus MKV files play without a
        // slow video transcode.
        "vp9" => true,
        // AV1 is deliberately absent: not verified here, and guessing wrong
        // costs the user a black frame.
        _ => false,
    }
}

fn describe_codecs(probe: &MediaProbe) -> String {
    let mut parts = vec![probe.video_codec.clone()];
    if probe.bit_depth > 8 {
        parts.push(format!("{}-bit", probe.bit_depth));
    }
    if let Some(audio) = &probe.audio_codec {
        parts.push(audio.clone());
    }
    let detail = parts.join(" / ");
    format!("This file uses {detail}, which the in-app player cannot decode.")
}

fn remux_sync(source: &Path, target: &Path, hevc: bool, audio: AudioPlan) -> Result<(), String> {
    let ffmpeg = find_tool("ffmpeg").ok_or_else(|| "ffmpeg was not found".to_string())?;
    // The video stream is never decoded: `-c:v copy` moves the coded frames into
    // a new MP4 with its index at the front, so the asset protocol can
    // range-request it. Audio is copied when WebKit can take it as-is and
    // re-encoded to AAC-LC only when it cannot (HE-AAC, AC-3, DTS, ...), which
    // costs a fraction of a full transcode and loses no picture.
    let mut command = Command::new(ffmpeg);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"]);
    command.arg(source).args(["-map", "0:v:0", "-sn", "-dn"]);
    if audio != AudioPlan::None {
        command.args(["-map", "0:a:0?"]);
    }
    command.args(["-c:v", "copy"]);
    match audio {
        AudioPlan::Copy => command.args(["-c:a", "copy"]),
        AudioPlan::Encode => command.args(["-c:a", "aac", "-b:a", "192k"]),
        AudioPlan::None => &mut command,
    };
    command.args(["-movflags", "+faststart"]);
    if hevc {
        command.args(["-tag:v", "hvc1"]);
    }
    let output = command
        .arg(target)
        .output()
        .map_err(|error| format!("ffmpeg could not run: {error}"))?;
    if output.status.success() && target.is_file() {
        return Ok(());
    }
    let _ = std::fs::remove_file(target);
    let reason = tail(&output.stderr, 300);
    Err(if reason.is_empty() {
        "ffmpeg could not remux this file".to_string()
    } else {
        format!("ffmpeg could not remux this file: {reason}")
    })
}

/// Drop the oldest remuxed files until the cache fits its budget.
fn prune_cache(root: &Path, max_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total = 0_u64;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("mp4") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        total += metadata.len();
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        files.push((modified, metadata.len(), path));
    }
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    for (_, size, path) in files {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

/// Cache identity: the source plus everything that changes its bytes.
fn cache_key(source: &Path, length: u64, modified_ms: u128) -> String {
    let identity = format!(
        "remux-v1:{}:{length}:{modified_ms}",
        source.to_string_lossy()
    );
    let digest = ring::digest::digest(&ring::digest::SHA256, identity.as_bytes());
    hex::encode(digest.as_ref())
}

/// Relay a playback diagnostic from the webview into the app log.
///
/// A Tauri window has no visible console, so a media element that reports
/// nothing useful (black picture, no `error` event) is otherwise impossible to
/// diagnose. The viewer sends a short state snapshot once a source is loaded;
/// release builds log at the same volume, which is one line per opened video.
#[tauri::command]
pub fn log_playback_diagnostic(label: String, payload: String) {
    eprintln!("[playback] {label}: {payload}");
}

/// Inspect a video's real codecs. The viewer uses this for the failure copy.
#[tauri::command]
pub async fn probe_media(path: String) -> Result<MediaProbe, CommandError> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(CommandError::not_found(format!(
            "Could not find {path}. The file may have moved or be on a disconnected drive."
        )));
    }
    tokio::task::spawn_blocking(move || probe_sync(&source))
        .await
        .map_err(|error| CommandError::internal(format!("probe task failed: {error}")))?
        .map_err(|failure| match failure {
            ProbeFailure::ToolMissing => CommandError::new(
                ErrorCode::UnsupportedFormat,
                "ffprobe is not installed.".to_string(),
            ),
            ProbeFailure::Failed(message) => {
                CommandError::new(ErrorCode::UnsupportedFormat, message)
            }
        })
}

/// Decide how `<video>` should be fed for this file, remuxing when needed.
///
/// `force_remux` skips the native decision. The viewer sets it after a file
/// that looked playable produced no decoded frames, which is the only reliable
/// way to catch a broken index or an edit list WebKit chokes on.
#[tauri::command]
pub async fn prepare_playback(
    app: AppHandle,
    path: String,
    force_remux: Option<bool>,
) -> Result<PreparedPlayback, CommandError> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Ok(PreparedPlayback {
            strategy: PlaybackStrategy::Unsupported,
            path,
            probe: None,
            detail: Some(
                "VistoGallery could not find this file. It may have been moved, deleted, or be \
                 on a disconnected drive."
                    .to_string(),
            ),
        });
    }

    let extension = extension_of(&source);
    let force = force_remux.unwrap_or(false);

    let probe = match tokio::task::spawn_blocking({
        let source = source.clone();
        move || probe_sync(&source)
    })
    .await
    {
        Ok(Ok(probe)) => Some(probe),
        Ok(Err(ProbeFailure::Failed(message))) => {
            return Ok(PreparedPlayback {
                strategy: PlaybackStrategy::Unsupported,
                path,
                probe: None,
                detail: Some(message),
            })
        }
        // No ffprobe: keep the old extension behaviour instead of failing.
        Ok(Err(ProbeFailure::ToolMissing)) | Err(_) => None,
    };

    match &probe {
        Some(probe) => {
            if !force && plays_natively(probe, &extension) {
                return Ok(PreparedPlayback {
                    strategy: PlaybackStrategy::Native,
                    path,
                    probe: Some(probe.clone()),
                    detail: None,
                });
            }
            if !remuxable(probe) {
                return Ok(PreparedPlayback {
                    strategy: PlaybackStrategy::Unsupported,
                    path,
                    probe: Some(probe.clone()),
                    detail: Some(describe_codecs(probe)),
                });
            }
        }
        None => {
            if !force && NATIVE_EXTENSIONS.contains(&extension.as_str()) {
                return Ok(PreparedPlayback {
                    strategy: PlaybackStrategy::Native,
                    path,
                    probe: None,
                    detail: None,
                });
            }
            // Remuxing needs ffmpeg, which is missing in exactly this branch.
            return Ok(PreparedPlayback {
                strategy: PlaybackStrategy::Unsupported,
                path,
                probe: None,
                detail: Some(
                    "This format needs the bundled ffmpeg, which is not available in this \
                     build. Open the file in a desktop player to watch it."
                        .to_string(),
                ),
            });
        }
    }

    let cache_root = app.path().app_cache_dir()?.join("playback");
    tokio::fs::create_dir_all(&cache_root).await?;

    let metadata = tokio::fs::metadata(&source).await?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let key = cache_key(&source, metadata.len(), modified_ms);
    let target = cache_root.join(format!("{key}.mp4"));

    if !target.is_file() {
        let hevc = probe
            .as_ref()
            .map(|probe| probe.video_codec == "hevc")
            .unwrap_or(false);
        let audio = probe.as_ref().map(audio_plan).unwrap_or(AudioPlan::Copy);
        // A per-attempt temp name: two mounts of the same item (React StrictMode
        // double-invokes the effect) must not write one file at the same time.
        // Both copies are identical, so whichever rename lands last is fine.
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let partial = cache_root.join(format!("{key}.{unique}.partial.mp4"));
        let remux_source = source.clone();
        let remux_target = partial.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            remux_sync(&remux_source, &remux_target, hevc, audio)
        })
        .await;
        let failure = match outcome {
            Ok(Ok(())) => None,
            Ok(Err(message)) => Some(message),
            Err(error) => Some(format!("remux task failed: {error}")),
        };
        if let Some(message) = failure {
            let _ = tokio::fs::remove_file(&partial).await;
            return Ok(PreparedPlayback {
                strategy: PlaybackStrategy::Unsupported,
                path,
                probe,
                detail: Some(message),
            });
        }
        tokio::fs::rename(&partial, &target).await?;
        let prune_root = cache_root.clone();
        tokio::task::spawn_blocking(move || prune_cache(&prune_root, PLAYBACK_CACHE_BUDGET_BYTES));
    }

    Ok(PreparedPlayback {
        strategy: PlaybackStrategy::Remuxed,
        path: target.to_string_lossy().into_owned(),
        probe,
        detail: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe_for(codec: &str, tag: Option<&str>, bit_depth: u32) -> MediaProbe {
        MediaProbe {
            container: "matroska,webm".into(),
            video_codec: codec.into(),
            video_profile: None,
            pixel_format: Some("yuv420p".into()),
            codec_tag: tag.map(str::to_string),
            audio_codec: Some("aac".into()),
            audio_profile: Some("LC".into()),
            width: 1920,
            height: 1080,
            duration_seconds: 12.0,
            has_subtitles: false,
            bit_depth,
            rotation: 0,
        }
    }

    #[test]
    fn hev1_tag_is_not_native_but_is_remuxable() {
        // The classic Instagram/phone export: valid HEVC that WebKit refuses.
        let probe = probe_for("hevc", Some("hev1"), 8);
        assert!(!plays_natively(&probe, "mp4"));
        assert!(remuxable(&probe));
    }

    #[test]
    fn hvc1_tag_plays_natively() {
        assert!(plays_natively(&probe_for("hevc", Some("hvc1"), 8), "mov"));
    }

    #[test]
    fn matroska_with_h264_and_aac_remuxes() {
        let probe = probe_for("h264", Some("avc1"), 8);
        assert!(!plays_natively(&probe, "mkv"));
        assert!(remuxable(&probe));
    }

    #[test]
    fn vp9_matroska_copies_the_video_and_encodes_opus_audio() {
        // The MKV in the demo library: VP9 video with Opus audio. Only the
        // container and the audio track change; every video frame is copied.
        let mut probe = probe_for("vp9", Some("vp09"), 8);
        probe.audio_codec = Some("opus".into());
        probe.audio_profile = None;
        assert!(!plays_natively(&probe, "mkv"));
        assert!(remuxable(&probe));
        assert_eq!(audio_plan(&probe), AudioPlan::Encode);
    }

    #[test]
    fn ac3_audio_is_re_encoded_not_dropped() {
        // The video is copied untouched; only the audio track is re-encoded,
        // which is what makes AC-3/DTS Matroska files playable in-app at all.
        let mut probe = probe_for("h264", Some("avc1"), 8);
        probe.audio_codec = Some("ac3".into());
        probe.audio_profile = None;
        assert!(remuxable(&probe));
        assert_eq!(audio_plan(&probe), AudioPlan::Encode);
    }

    #[test]
    fn he_aac_audio_plays_natively() {
        // The Instagram downloads are H.264 Main + HE-AAC, and WebKit decodes
        // them: their black frames came from a compositing bug in the player
        // layout, not from the audio. Remuxing them would be wasted work.
        let mut probe = probe_for("h264", Some("avc1"), 8);
        probe.audio_profile = Some("HE-AAC".into());
        assert!(plays_natively(&probe, "mp4"));
        assert_eq!(audio_plan(&probe), AudioPlan::Copy);
    }

    #[test]
    fn aac_lc_audio_is_copied_untouched() {
        let probe = probe_for("h264", Some("avc1"), 8);
        assert_eq!(audio_plan(&probe), AudioPlan::Copy);
        assert!(plays_natively(&probe, "mp4"));
    }

    #[test]
    fn silent_video_carries_no_audio_track() {
        let mut probe = probe_for("h264", Some("avc1"), 8);
        probe.audio_codec = None;
        assert_eq!(audio_plan(&probe), AudioPlan::None);
        assert!(plays_natively(&probe, "mp4"));
    }

    #[test]
    fn ten_bit_h264_is_not_native_and_not_remuxable() {
        let probe = probe_for("h264", Some("avc1"), 10);
        assert!(!plays_natively(&probe, "mp4"));
        assert!(!remuxable(&probe));
    }

    #[test]
    fn unknown_extension_never_claims_native() {
        assert!(!plays_natively(&probe_for("prores", None, 10), "mov"));
        assert!(!plays_natively(&probe_for("h264", None, 8), "avi"));
    }

    /// End-to-end check of the real remux: a Matroska file must come back as an
    /// MP4 whose video still probes as natively playable. Skipped when ffmpeg
    /// is not installed, so CI without the tool stays green.
    #[test]
    fn matroska_remuxes_into_a_natively_playable_mp4() {
        let Some(ffmpeg) = find_tool("ffmpeg") else {
            return;
        };
        if find_tool("ffprobe").is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("visto-remux-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let source = dir.join("source.mkv");
        let status = Command::new(ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x120:rate=10",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&source)
            .status()
            .expect("run ffmpeg");
        if !status.success() {
            // No libx264 in this build of ffmpeg; nothing to assert.
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let before = probe_sync(&source).ok().expect("probe source");
        assert!(!plays_natively(&before, "mkv"));
        assert!(remuxable(&before));

        let target = dir.join("target.mp4");
        remux_sync(&source, &target, false, audio_plan(&before)).expect("remux");
        let after = probe_sync(&target).ok().expect("probe target");
        assert_eq!(after.video_codec, "h264");
        assert_eq!(after.audio_codec.as_deref(), Some("aac"));
        assert!(plays_natively(&after, "mp4"), "remux must be playable");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The audio path that fixes HE-AAC and AC-3 files: a Matroska with AC-3
    /// audio must come back with an AAC-LC track and playable video.
    #[test]
    fn ac3_matroska_is_remuxed_with_aac_audio() {
        let Some(ffmpeg) = find_tool("ffmpeg") else {
            return;
        };
        if find_tool("ffprobe").is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("visto-remux-ac3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let source = dir.join("source.mkv");
        let status = Command::new(ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x120:rate=10",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "ac3",
                "-shortest",
            ])
            .arg(&source)
            .status()
            .expect("run ffmpeg");
        if !status.success() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let before = probe_sync(&source).ok().expect("probe source");
        assert_eq!(before.audio_codec.as_deref(), Some("ac3"));
        assert_eq!(audio_plan(&before), AudioPlan::Encode);

        let target = dir.join("target.mp4");
        remux_sync(&source, &target, false, audio_plan(&before)).expect("remux");
        let after = probe_sync(&target).ok().expect("probe target");
        assert_eq!(after.audio_codec.as_deref(), Some("aac"));
        assert_eq!(after.audio_profile.as_deref(), Some("LC"));
        assert!(plays_natively(&after, "mp4"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_keys_separate_versions_of_one_path() {
        let path = Path::new("/tmp/movie.mkv");
        assert_eq!(cache_key(path, 10, 1), cache_key(path, 10, 1));
        assert_ne!(cache_key(path, 10, 1), cache_key(path, 10, 2));
    }
}
