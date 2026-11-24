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
//! index — while leaving the frames untouched. Every audio track is kept, and
//! the ones WebKit cannot decode (AC-3, DTS, FLAC, WMA, ...) are re-encoded to
//! AAC without touching a single video frame. Text subtitles come along as
//! `mov_text`, so a Matroska's captions still work in an MP4.
//!
//! Video codecs a remux cannot fix (WMV/VC-1, MPEG-2, MPEG-4 Part 2, H.263,
//! 10-bit H.264) are not silently re-encoded during `prepare_playback`, which
//! would block the viewer for minutes with no way out. The file is reported as
//! unsupported but convertible, and `convert_playback` runs the VideoToolbox
//! H.264 encode on request with progress and cancellation, writing a second
//! cache entry.
//!
//! Both tools come from [`crate::media_tools`]: the sidecars this app bundles
//! first, then a Homebrew install, then `PATH`. When neither exists the
//! extension allow-list keeps working as before, so a missing tool never turns
//! into a broken player.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use ts_rs::TS;

use crate::errors::{CommandError, ErrorCode};

/// Fallback budget for remuxed media when settings cannot be read. Normally
/// the "Maximum cache size" setting applies, as it does to thumbnails.
const PLAYBACK_CACHE_FALLBACK_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Containers `prepare_playback` may hand straight to `<video>` when no probe
/// is available. Mirrors `IN_APP_VIDEO_EXTENSIONS` on the frontend.
const NATIVE_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm", "ogv"];

/// Cache identity prefixes. A changed ffmpeg recipe gets a new version so old
/// copies are never mistaken for ones produced by the current flags.
const REMUX_VERSION: &str = "remux-v1";
const TRANSCODE_VERSION: &str = "transcode-v1";

/// Progress events for a running conversion, filtered by `path` on the client.
const CONVERSION_PROGRESS_EVENT: &str = "playback-conversion";

/// One audio stream, in source order.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackInfo {
    /// ffprobe's stream index, used to map exactly this track.
    pub index: i64,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub channels: Option<i64>,
}

/// One subtitle stream, in source order.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrackInfo {
    pub index: i64,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
}

/// What the file actually is, independent of its name.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub video_codec: String,
    pub pixel_format: Option<String>,
    /// FourCC of the video track (`hvc1`, `hev1`, `avc1`, ...). `hev1` is the
    /// reason a perfectly good HEVC MP4 plays black in WebKit.
    pub codec_tag: Option<String>,
    pub audio_codec: Option<String>,
    /// `ffprobe`'s audio profile (`LC`, `HE-AAC`, ...). Informational only:
    /// WebKit plays HE-AAC, so the profile never blocks in-app playback.
    pub audio_profile: Option<String>,
    /// Every audio stream, in source order.
    pub audio_tracks: Vec<AudioTrackInfo>,
    /// Every subtitle stream. Bitmap subtitles (PGS, VobSub) are listed too,
    /// but only text ones can be carried into an MP4.
    pub subtitle_tracks: Vec<SubtitleTrackInfo>,
    pub duration_ms: Option<i64>,
    pub width: u32,
    pub height: u32,
    pub bit_depth: u32,
}

impl MediaProbe {
    /// Subtitle stream indices that `mov_text` can represent.
    fn text_subtitle_indices(&self) -> Vec<i64> {
        self.subtitle_tracks
            .iter()
            .filter(|track| is_text_subtitle(&track.codec))
            .map(|track| track.index)
            .collect()
    }
}

/// How `<video>` should be fed for this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStrategy {
    /// Play the original path.
    Native,
    /// Play the remuxed copy; `path` points at the cached file.
    Remuxed,
    /// Play a re-encoded copy; `path` points at the cached file.
    Converted,
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
    /// True when "Convert to play here" can turn this file into an in-app
    /// playable copy: ffmpeg is present, the video codec is one a remux cannot
    /// fix, and this build has the VideoToolbox H.264 encoder.
    pub can_convert: bool,
}

/// A conversion's progress, 0 to 1. Emitted on [`CONVERSION_PROGRESS_EVENT`]
/// while ffmpeg runs; the client matches `path` against the video it converted.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackConversionProgress {
    pub path: String,
    /// `None` when ffprobe could not report a duration, so the client shows an
    /// indeterminate bar rather than a made-up percentage.
    pub progress: Option<f64>,
}

enum ProbeFailure {
    /// `ffprobe` is not installed, so only the extension list can decide.
    ToolMissing,
    Failed(String),
}

/// The remux gate for one cache key.
///
/// React StrictMode mounts the player effect twice, so two identical requests
/// arrive within milliseconds of each other. Without a gate both would run
/// ffmpeg over the same file, reading and writing the same gigabytes twice for
/// one result. The second caller waits and then finds the finished file.
type RemuxGate = Arc<tokio::sync::Mutex<()>>;

fn gates() -> &'static Mutex<HashMap<String, RemuxGate>> {
    static GATES: OnceLock<Mutex<HashMap<String, RemuxGate>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remux_gate(key: &str) -> RemuxGate {
    let mut gates = gates().lock().expect("remux gate map");
    gates.entry(key.to_string()).or_default().clone()
}

/// Forget a gate once nobody holds it, so a long session over a big library does
/// not keep one entry per file ever played. A caller that arrived meanwhile has
/// its own handle, which keeps the count above two and the gate in the map.
fn release_gate(key: &str, gate: &RemuxGate) {
    let mut gates = gates().lock().expect("remux gate map");
    if Arc::strong_count(gate) <= 2 {
        gates.remove(key);
    }
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
    let ffprobe =
        crate::media_tools::find(crate::media_tools::FFPROBE).ok_or(ProbeFailure::ToolMissing)?;
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
    let text = |entry: &serde_json::Value, key: &str| -> Option<String> {
        entry
            .get(key)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty() && *value != "unknown")
            .map(str::to_string)
    };
    let tag = |entry: &serde_json::Value, key: &str| -> Option<String> {
        entry
            .get("tags")
            .and_then(|tags| tags.get(key))
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let stream_index = |entry: &serde_json::Value| stream_i64(entry, "index").unwrap_or(-1);

    let audio_tracks = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(|kind| kind.as_str()) == Some("audio"))
        .map(|stream| AudioTrackInfo {
            index: stream_index(stream),
            codec: text(stream, "codec_name").unwrap_or_else(|| "unknown".to_string()),
            language: tag(stream, "language"),
            title: tag(stream, "title"),
            channels: stream_i64(stream, "channels"),
        })
        .collect();
    let subtitle_tracks = streams
        .iter()
        .filter(|stream| {
            stream.get("codec_type").and_then(|kind| kind.as_str()) == Some("subtitle")
        })
        .map(|stream| SubtitleTrackInfo {
            index: stream_index(stream),
            codec: text(stream, "codec_name").unwrap_or_else(|| "unknown".to_string()),
            language: tag(stream, "language"),
            title: tag(stream, "title"),
        })
        .collect();

    let duration_ms = value
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|duration| duration.as_str())
        .and_then(|duration| duration.parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .map(|seconds| (seconds * 1000.0).round() as i64)
        .or_else(|| {
            stream_i64(video, "duration")
                .filter(|ms| *ms > 0)
                .map(|value| {
                    // Stream duration is in microseconds when ffprobe reports it
                    // as an integer.
                    if value > 1_000_000 {
                        value / 1000
                    } else {
                        value
                    }
                })
        });

    let pixel_format = text(video, "pix_fmt");
    let bit_depth = stream_i64(video, "bits_per_raw_sample")
        .map(|depth| depth as u32)
        .filter(|depth| *depth > 0)
        .unwrap_or_else(|| match pixel_format.as_deref() {
            Some(format) if format.contains("12") => 12,
            Some(format) if format.contains("10") => 10,
            _ => 8,
        });

    Ok(MediaProbe {
        video_codec: text(video, "codec_name").unwrap_or_else(|| "unknown".to_string()),
        pixel_format,
        codec_tag: text(video, "codec_tag_string").map(|tag| tag.to_lowercase()),
        audio_codec: audio.and_then(|stream| text(stream, "codec_name")),
        audio_profile: audio.and_then(|stream| text(stream, "profile")),
        audio_tracks,
        subtitle_tracks,
        duration_ms,
        width: stream_i64(video, "width").unwrap_or(0) as u32,
        height: stream_i64(video, "height").unwrap_or(0) as u32,
        bit_depth,
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

/// What happens to one audio track during a remux or conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioPlan {
    /// The track already plays; copy it untouched.
    Copy,
    /// Re-encode to AAC-LC (AC-3, DTS, FLAC, Opus, PCM, WMA, ...).
    Encode,
}

/// Audio codecs WebKit decodes inside an MP4 as they stand.
fn audio_copyable(codec: &str) -> bool {
    matches!(codec, "aac" | "mp3" | "alac")
}

fn track_audio_plan(track: &AudioTrackInfo) -> AudioPlan {
    if audio_copyable(&track.codec) {
        AudioPlan::Copy
    } else {
        AudioPlan::Encode
    }
}

/// Subtitle codecs that can be carried into an MP4 as `mov_text`. Bitmap
/// subtitles (PGS, VobSub, DVD) cannot: they would have to be burned in.
fn is_text_subtitle(codec: &str) -> bool {
    matches!(
        codec,
        "subrip"
            | "srt"
            | "ass"
            | "ssa"
            | "webvtt"
            | "mov_text"
            | "text"
            | "microdvd"
            | "subviewer"
            | "subviewer1"
            | "sami"
            | "realtext"
            | "jacosub"
            | "mpl2"
            | "pjs"
            | "vplayer"
            | "stl"
            | "eia_608"
    )
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

/// Whether this build can re-encode the video to H.264. Checked once: the
/// answer depends on the bundled ffmpeg, which cannot change while running.
fn h264_encoder_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let Some(ffmpeg) = crate::media_tools::find(crate::media_tools::FFMPEG) else {
            return false;
        };
        let Ok(output) = Command::new(ffmpeg)
            .args(["-hide_banner", "-encoders"])
            .output()
        else {
            return false;
        };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.split_whitespace().nth(1) == Some("h264_videotoolbox"))
    })
}

/// True when the file cannot be remuxed but can be re-encoded. Conversion is
/// the expensive last resort, so it is offered only for what a remux cannot fix.
fn convertible(probe: &MediaProbe) -> bool {
    !remuxable(probe) && h264_encoder_available()
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

/// `-map` arguments for the first video track, every audio track and every text
/// subtitle track, plus how many subtitle tracks were mapped. Unmapped streams
/// (bitmap subtitles, cover art, data tracks) are dropped by the output.
///
/// Nothing relies on ffmpeg's default stream selection, which would keep only
/// one track of each kind.
fn playable_stream_maps(probe: &MediaProbe) -> (Vec<String>, usize) {
    let mut maps = vec!["-map".to_string(), "0:v:0".to_string(), "-dn".to_string()];
    for track in &probe.audio_tracks {
        maps.push("-map".to_string());
        maps.push(format!("0:{}", track.index));
    }
    let subtitles = probe.text_subtitle_indices();
    for index in &subtitles {
        maps.push("-map".to_string());
        maps.push(format!("0:{index}"));
    }
    (maps, subtitles.len())
}

fn audio_encode_args(args: &mut Vec<String>, position: usize, plan: AudioPlan) {
    args.push(format!("-c:a:{position}"));
    match plan {
        AudioPlan::Copy => args.push("copy".to_string()),
        AudioPlan::Encode => {
            args.push("aac".to_string());
            args.push(format!("-b:a:{position}"));
            args.push("192k".to_string());
        }
    }
}

fn remux_sync(source: &Path, target: &Path, probe: &MediaProbe) -> Result<(), String> {
    let ffmpeg = crate::media_tools::find(crate::media_tools::FFMPEG)
        .ok_or_else(|| "the bundled ffmpeg is missing".to_string())?;
    // The video stream is never decoded: `-c:v copy` moves the coded frames into
    // a new MP4 with its index at the front, so the asset protocol can
    // range-request it. Audio is copied when WebKit can take it as-is and
    // re-encoded to AAC-LC only when it cannot; every track is kept. Text
    // subtitles become `mov_text`, which WebKit exposes as captions.
    let mut command = Command::new(ffmpeg);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"]);
    command.arg(source);
    let (maps, subtitles) = playable_stream_maps(probe);
    command.args(maps);
    command.args(["-c:v", "copy"]);
    for (position, track) in probe.audio_tracks.iter().enumerate() {
        let mut args = Vec::new();
        audio_encode_args(&mut args, position, track_audio_plan(track));
        command.args(args);
    }
    if subtitles > 0 {
        command.args(["-c:s", "mov_text"]);
    }
    command.args(["-movflags", "+faststart"]);
    if probe.video_codec == "hevc" {
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

/// ffmpeg arguments for a conversion, from the input path onward.
fn transcode_args(probe: &MediaProbe) -> Vec<String> {
    let (mut args, subtitles) = playable_stream_maps(probe);

    // Roughly two bits per pixel per second: a 1080p file lands around
    // 4 Mbit/s, good enough to play back what was a phone or camcorder clip,
    // and the bounds keep a tiny clip from looking mushy and a 4K file from
    // eating the whole cache.
    let pixels = u64::from(probe.width) * u64::from(probe.height);
    let bitrate = (pixels.saturating_mul(2)).clamp(1_500_000, 12_000_000);
    args.extend([
        "-c:v".to_string(),
        "h264_videotoolbox".to_string(),
        "-b:v".to_string(),
        format!("{}k", bitrate / 1000),
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        // VideoToolbox's encoder requires even dimensions in 4:2:0.
        "-vf".to_string(),
        "scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string(),
    ]);
    for (position, track) in probe.audio_tracks.iter().enumerate() {
        audio_encode_args(&mut args, position, track_audio_plan(track));
    }
    if subtitles > 0 {
        args.push("-c:s".to_string());
        args.push("mov_text".to_string());
    }
    args.push("-movflags".to_string());
    args.push("+faststart".to_string());
    args
}

/// A `.partial.mp4` older than this is a crashed remux, not one in flight.
const CACHE_TEMP_GRACE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Drop the oldest remuxed files until the cache fits its budget. Leftover
/// `.partial.mp4` files from a crashed remux are swept even when the cache is
/// under budget, so they cannot accumulate forever.
fn prune_cache(root: &Path, max_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let cutoff = std::time::SystemTime::now().checked_sub(CACHE_TEMP_GRACE);
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total = 0_u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if name.ends_with(".partial.mp4") {
            let stale = cutoff.is_some_and(|cutoff| {
                metadata
                    .modified()
                    .map(|modified| modified <= cutoff)
                    .unwrap_or(false)
            });
            if stale {
                let _ = std::fs::remove_file(&path);
            }
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("mp4") {
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
    for (modified, size, path) in files {
        if total <= max_bytes {
            break;
        }
        // The player re-opens the file for every range request, so a copy
        // that may still be streaming is never deleted, even over budget.
        if super::storage::recently_used(modified, super::storage::PLAYBACK_IN_USE_GRACE) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

/// Delete the converted copies of `source`, if any are cached. Used when an
/// item is hidden, so its video does not stay readable in the cache folder.
pub(crate) fn remove_cached_remux(cache_root: &Path, source: &Path) -> bool {
    let Some((length, modified_ms)) = source_identity(source) else {
        return false;
    };
    let mut removed = false;
    for version in [REMUX_VERSION, TRANSCODE_VERSION] {
        let key = cache_key(version, source, length, modified_ms);
        removed |= std::fs::remove_file(cache_root.join(format!("{key}.mp4"))).is_ok();
    }
    removed
}

/// Size and modification time, the parts of a file's identity that a cache key
/// needs. `None` when the file cannot be read.
fn source_identity(source: &Path) -> Option<(u64, u128)> {
    let metadata = std::fs::metadata(source).ok()?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    Some((metadata.len(), modified_ms))
}

/// Cache identity: the recipe version, the source, and everything that changes
/// its bytes.
fn cache_key(version: &str, source: &Path, length: u64, modified_ms: u128) -> String {
    let identity = format!(
        "{version}:{}:{length}:{modified_ms}",
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
/// this is one line per opened video.
///
/// `tracing` rather than `eprintln!`: when the bundled `.app` is launched from
/// Finder its stderr goes nowhere anyone will look, which is exactly the case
/// this diagnostic exists for.
#[tauri::command]
pub fn log_playback_diagnostic(label: String, payload: String) {
    tracing::info!(target: "playback", %label, %payload, "playback state");
}

/// Every conversion currently running, by cache key. A cancel command flips
/// the matching flag and the ffmpeg loop kills the process within a tick.
fn conversions() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static CONVERSIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    CONVERSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Removes the conversion's cancel flag however the command exits.
struct ConversionGuard {
    key: String,
}

impl Drop for ConversionGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = conversions().lock() {
            map.remove(&self.key);
        }
    }
}

async fn ensure_cataloged(db: &sqlx::SqlitePool, path: &str) -> Result<(), CommandError> {
    let exists: Option<String> = sqlx::query_scalar("SELECT path FROM media_items WHERE path = ?")
        .bind(path)
        .fetch_optional(db)
        .await?;
    if exists.is_none() {
        // Same check as `open_file`: the renderer cannot ask the backend to
        // copy an arbitrary file into a webview-readable folder.
        return Err(CommandError::path(
            "Path is not part of the catalog.".to_string(),
        ));
    }
    Ok(())
}

/// Keep the playback cache inside the "Maximum cache size" budget.
async fn prune_playback_cache(db: &sqlx::SqlitePool, cache_root: &Path) {
    let budget = super::settings::load_persisted_settings(db)
        .await
        .map(|settings| settings.max_cache_size_gb.max(1) as u64 * 1024 * 1024 * 1024)
        .unwrap_or(PLAYBACK_CACHE_FALLBACK_BYTES);
    let root = cache_root.to_path_buf();
    tokio::task::spawn_blocking(move || prune_cache(&root, budget));
}

/// Run one conversion, reporting progress and honouring cancellation.
async fn run_transcode<F>(
    source: &Path,
    target: &Path,
    probe: &MediaProbe,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<(), CommandError>
where
    F: Fn(Option<f64>),
{
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};

    let ffmpeg = crate::media_tools::find(crate::media_tools::FFMPEG)
        .ok_or_else(|| CommandError::internal("the bundled ffmpeg is missing"))?;
    let mut command = tokio::process::Command::new(ffmpeg);
    command
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(source);
    command.args(transcode_args(probe));
    command.args(["-progress", "pipe:1", "-nostats"]);
    command.arg(target);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| CommandError::internal(format!("ffmpeg could not start: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CommandError::internal("ffmpeg reported no progress stream"))?;
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text).await;
        }
        text
    });

    let duration_us = probe
        .duration_ms
        .filter(|ms| *ms > 0)
        .map(|ms| ms as f64 * 1000.0);
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(200));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last = -1.0_f64;
    let mut cancelled = false;
    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        if let Some(value) = line.strip_prefix("out_time_us=") {
                            if let (Ok(micros), Some(total)) =
                                (value.trim().parse::<f64>(), duration_us)
                            {
                                let fraction = (micros / total).clamp(0.0, 1.0);
                                if fraction - last >= 0.01 {
                                    last = fraction;
                                    on_progress(Some(fraction));
                                }
                            }
                        }
                    }
                    _ => break,
                }
            }
            _ = ticker.tick() => {
                if cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    let _ = child.start_kill();
                    break;
                }
            }
        }
    }
    let status = child.wait().await.map_err(|error| {
        CommandError::internal(format!("ffmpeg could not be waited on: {error}"))
    })?;
    let stderr = stderr_task.await.unwrap_or_default();
    if cancelled {
        let _ = tokio::fs::remove_file(target).await;
        return Err(CommandError::new(
            ErrorCode::Cancelled,
            "Conversion cancelled.",
        ));
    }
    if !status.success() || !target.is_file() {
        let _ = tokio::fs::remove_file(target).await;
        let reason = tail(stderr.as_bytes(), 300);
        return Err(CommandError::internal(if reason.is_empty() {
            "ffmpeg could not convert this file".to_string()
        } else {
            format!("ffmpeg could not convert this file: {reason}")
        }));
    }
    on_progress(Some(1.0));
    Ok(())
}

/// Re-encode an unsupported file into the playback cache as H.264/AAC, keeping
/// every audio track and text subtitle. Long enough to need progress + cancel,
/// which is why it is a separate command from `prepare_playback`.
#[tauri::command]
pub async fn convert_playback(
    app: AppHandle,
    path: String,
    catalog: State<'_, crate::Catalog>,
) -> Result<PreparedPlayback, CommandError> {
    let db = super::get_db(&catalog)?;
    ensure_cataloged(&db, &path).await?;

    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(CommandError::not_found(
            "VistoGallery could not find this file. It may have been moved, deleted, or be on a \
             disconnected drive.",
        ));
    }
    let probe = tokio::task::spawn_blocking({
        let source = source.clone();
        move || probe_sync(&source)
    })
    .await
    .map_err(|error| CommandError::internal(format!("probe task failed: {error}")))?
    .map_err(|failure| match failure {
        ProbeFailure::ToolMissing => CommandError::internal(
            "the bundled ffprobe is missing, so this file cannot be examined",
        ),
        ProbeFailure::Failed(message) => CommandError::internal(message),
    })?;
    if !convertible(&probe) {
        return Err(CommandError::new(
            ErrorCode::UnsupportedFormat,
            if remuxable(&probe) {
                "This file can play without re-encoding; reopen it to use the remux.".to_string()
            } else if !h264_encoder_available() {
                "This build of VistoGallery cannot convert video: its ffmpeg has no H.264 \
                 encoder."
                    .to_string()
            } else {
                describe_codecs(&probe)
            },
        ));
    }

    let cache_root = app
        .path()
        .app_cache_dir()?
        .join(super::storage::PLAYBACK_DIR);
    tokio::fs::create_dir_all(&cache_root).await?;
    let (length, modified_ms) = source_identity(&source).ok_or_else(|| {
        CommandError::not_found("VistoGallery could not read this file's details.")
    })?;
    let key = cache_key(TRANSCODE_VERSION, &source, length, modified_ms);
    let target = cache_root.join(format!("{key}.mp4"));

    let gate = remux_gate(&key);
    let _flight = gate.lock().await;
    if target.is_file() {
        // A previous run finished while this one was queued.
        let touched = target.clone();
        tokio::task::spawn_blocking(move || super::storage::touch_if_stale(&touched));
        release_gate(&key, &gate);
        return Ok(PreparedPlayback {
            strategy: PlaybackStrategy::Converted,
            path: target.to_string_lossy().into_owned(),
            probe: Some(probe),
            detail: None,
            can_convert: false,
        });
    }

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = conversions().lock() {
        map.insert(key.clone(), cancel.clone());
    }
    let _guard = ConversionGuard { key: key.clone() };

    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let partial = cache_root.join(format!("{key}.{unique}.partial.mp4"));
    let event_app = app.clone();
    let event_path = path.clone();
    let outcome = run_transcode(&source, &partial, &probe, cancel, move |progress| {
        let _ = event_app.emit(
            CONVERSION_PROGRESS_EVENT,
            PlaybackConversionProgress {
                path: event_path.clone(),
                progress,
            },
        );
    })
    .await;
    if let Err(error) = outcome {
        let _ = tokio::fs::remove_file(&partial).await;
        release_gate(&key, &gate);
        return Err(error);
    }
    tokio::fs::rename(&partial, &target).await?;
    prune_playback_cache(&db, &cache_root).await;
    release_gate(&key, &gate);

    Ok(PreparedPlayback {
        strategy: PlaybackStrategy::Converted,
        path: target.to_string_lossy().into_owned(),
        probe: Some(probe),
        detail: None,
        can_convert: false,
    })
}

/// Stop a running conversion of `path`. Returns false when nothing was running,
/// so a client that raced the last frame does not report a failure.
#[tauri::command]
pub fn cancel_playback_conversion(path: String) -> bool {
    let source = Path::new(&path);
    let Some((length, modified_ms)) = source_identity(source) else {
        return false;
    };
    let key = cache_key(TRANSCODE_VERSION, source, length, modified_ms);
    let Ok(map) = conversions().lock() else {
        return false;
    };
    match map.get(&key) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
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
    catalog: State<'_, crate::Catalog>,
) -> Result<PreparedPlayback, CommandError> {
    // Remuxes are written into the asset-protocol cache, so only a cataloged
    // item may be prepared. Same check as `open_file`: the renderer cannot ask
    // the backend to copy an arbitrary file into a webview-readable folder.
    let db = super::get_db(&catalog)?;
    ensure_cataloged(&db, &path).await?;

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
            can_convert: false,
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
                can_convert: false,
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
                    can_convert: false,
                });
            }
            if !remuxable(probe) {
                return Ok(PreparedPlayback {
                    strategy: PlaybackStrategy::Unsupported,
                    path,
                    probe: Some(probe.clone()),
                    detail: Some(describe_codecs(probe)),
                    can_convert: convertible(probe),
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
                    can_convert: false,
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
                can_convert: false,
            });
        }
    }

    let cache_root = app
        .path()
        .app_cache_dir()?
        .join(super::storage::PLAYBACK_DIR);
    tokio::fs::create_dir_all(&cache_root).await?;

    let (length, modified_ms) = source_identity(&source)
        .ok_or_else(|| CommandError::io("could not read this file's details"))?;
    let key = cache_key(REMUX_VERSION, &source, length, modified_ms);
    let target = cache_root.join(format!("{key}.mp4"));

    let gate = remux_gate(&key);
    let _flight = gate.lock().await;
    // A caller that waited on the gate may find the work already done.
    if !target.is_file() {
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
        let remux_probe = probe.clone().expect("remuxing always has a probe");
        let outcome = tokio::task::spawn_blocking(move || {
            remux_sync(&remux_source, &remux_target, &remux_probe)
        })
        .await;
        let failure = match outcome {
            Ok(Ok(())) => None,
            Ok(Err(message)) => Some(message),
            Err(error) => Some(format!("remux task failed: {error}")),
        };
        if let Some(message) = failure {
            let _ = tokio::fs::remove_file(&partial).await;
            release_gate(&key, &gate);
            return Ok(PreparedPlayback {
                strategy: PlaybackStrategy::Unsupported,
                path,
                probe,
                detail: Some(message),
                can_convert: false,
            });
        }
        tokio::fs::rename(&partial, &target).await?;
        prune_playback_cache(&db, &cache_root).await;
    } else {
        // A hit: mark it used so it is evicted last and, while it streams,
        // not at all (see `PLAYBACK_IN_USE_GRACE`).
        let touched = target.clone();
        tokio::task::spawn_blocking(move || super::storage::touch_if_stale(&touched));
    }

    release_gate(&key, &gate);

    Ok(PreparedPlayback {
        strategy: PlaybackStrategy::Remuxed,
        path: target.to_string_lossy().into_owned(),
        probe,
        detail: None,
        can_convert: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audio_track(index: i64, codec: &str) -> AudioTrackInfo {
        AudioTrackInfo {
            index,
            codec: codec.into(),
            language: None,
            title: None,
            channels: Some(2),
        }
    }

    fn subtitle_track(index: i64, codec: &str) -> SubtitleTrackInfo {
        SubtitleTrackInfo {
            index,
            codec: codec.into(),
            language: Some("eng".into()),
            title: None,
        }
    }

    fn probe_for(codec: &str, tag: Option<&str>, bit_depth: u32) -> MediaProbe {
        MediaProbe {
            video_codec: codec.into(),
            pixel_format: Some("yuv420p".into()),
            codec_tag: tag.map(str::to_string),
            audio_codec: Some("aac".into()),
            audio_profile: Some("LC".into()),
            audio_tracks: vec![audio_track(1, "aac")],
            subtitle_tracks: Vec::new(),
            duration_ms: Some(1000),
            width: 1920,
            height: 1080,
            bit_depth,
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
        probe.audio_tracks = vec![audio_track(1, "opus")];
        probe.audio_profile = None;
        assert!(!plays_natively(&probe, "mkv"));
        assert!(remuxable(&probe));
        assert_eq!(track_audio_plan(&probe.audio_tracks[0]), AudioPlan::Encode);
    }

    #[test]
    fn ac3_audio_is_re_encoded_not_dropped() {
        // The video is copied untouched; only the audio track is re-encoded,
        // which is what makes AC-3/DTS Matroska files playable in-app at all.
        let mut probe = probe_for("h264", Some("avc1"), 8);
        probe.audio_codec = Some("ac3".into());
        probe.audio_tracks = vec![audio_track(1, "ac3")];
        probe.audio_profile = None;
        assert!(remuxable(&probe));
        assert_eq!(track_audio_plan(&probe.audio_tracks[0]), AudioPlan::Encode);
    }

    #[test]
    fn he_aac_audio_plays_natively() {
        // The Instagram downloads are H.264 Main + HE-AAC, and WebKit decodes
        // them: their black frames came from a compositing bug in the player
        // layout, not from the audio. Remuxing them would be wasted work.
        let mut probe = probe_for("h264", Some("avc1"), 8);
        probe.audio_profile = Some("HE-AAC".into());
        assert!(plays_natively(&probe, "mp4"));
        assert_eq!(track_audio_plan(&probe.audio_tracks[0]), AudioPlan::Copy);
    }

    #[test]
    fn aac_lc_audio_is_copied_untouched() {
        let probe = probe_for("h264", Some("avc1"), 8);
        assert_eq!(track_audio_plan(&probe.audio_tracks[0]), AudioPlan::Copy);
        assert!(plays_natively(&probe, "mp4"));
    }

    #[test]
    fn silent_video_carries_no_audio_track() {
        let mut probe = probe_for("h264", Some("avc1"), 8);
        probe.audio_codec = None;
        probe.audio_tracks.clear();
        assert!(probe.audio_tracks.is_empty());
        assert!(plays_natively(&probe, "mp4"));
    }

    #[test]
    fn only_text_subtitles_are_carried_into_an_mp4() {
        let mut probe = probe_for("h264", Some("avc1"), 8);
        probe.subtitle_tracks = vec![
            subtitle_track(2, "subrip"),
            subtitle_track(3, "hdmv_pgs_subtitle"),
            subtitle_track(4, "ass"),
        ];
        // Bitmap PGS cannot become mov_text; the two text tracks can.
        assert_eq!(probe.text_subtitle_indices(), vec![2, 4]);
        assert!(is_text_subtitle("webvtt"));
        assert!(!is_text_subtitle("dvd_subtitle"));
    }

    #[test]
    fn every_audio_track_is_kept_and_only_the_unsupported_ones_are_encoded() {
        let mut probe = probe_for("h264", Some("avc1"), 8);
        probe.audio_tracks = vec![
            audio_track(1, "aac"),
            audio_track(3, "ac3"),
            audio_track(5, "aac"),
        ];
        let args = transcode_args(&probe);
        // Each source stream is mapped explicitly; nothing relies on default
        // stream selection, which would keep only the first track.
        for index in [1, 3, 5] {
            let position = args
                .iter()
                .position(|arg| arg == &format!("0:{index}"))
                .unwrap_or_else(|| panic!("audio stream {index} is mapped"));
            assert_eq!(args[position - 1], "-map");
        }
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c:a:0" && pair[1] == "copy"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c:a:1" && pair[1] == "aac"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c:a:2" && pair[1] == "copy"));
    }

    #[test]
    fn wmv_and_xvid_cannot_remux_and_can_convert() {
        // The two files from the review's 167-video library that fell through:
        // a WMV2 and an MPEG-4 Part 2 file. A remux cannot help; a transcode can.
        for codec in ["wmv2", "vc1", "mpeg4", "mpeg2video", "h263"] {
            let probe = probe_for(codec, None, 8);
            assert!(!remuxable(&probe), "{codec} must need conversion");
        }
        assert!(convertible(&probe_for("wmv2", None, 8)) == h264_encoder_available());
        assert!(!convertible(&probe_for("h264", Some("avc1"), 8)));
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
    /// MP4 whose video still probes as natively playable. The fixture is VP9,
    /// which the bundled sidecar can encode and which is what the VP9 Matroska
    /// files in a real library look like. Skipped when ffmpeg is not installed,
    /// so a checkout without the sidecars stays green.
    #[test]
    fn matroska_remuxes_into_a_natively_playable_mp4() {
        let Some(ffmpeg) = crate::media_tools::find(crate::media_tools::FFMPEG) else {
            return;
        };
        if crate::media_tools::find(crate::media_tools::FFPROBE).is_none() {
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
                "vp9",
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
            // This build of ffmpeg cannot encode the fixture; nothing to assert.
            // The bundled sidecar can, so the coverage is real in a release build.
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let before = probe_sync(&source).ok().expect("probe source");
        assert!(!plays_natively(&before, "mkv"));
        assert!(remuxable(&before));

        let target = dir.join("target.mp4");
        remux_sync(&source, &target, &before).expect("remux");
        let after = probe_sync(&target).ok().expect("probe target");
        assert_eq!(after.video_codec, "vp9");
        assert_eq!(after.audio_codec.as_deref(), Some("aac"));
        assert!(plays_natively(&after, "mp4"), "remux must be playable");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The audio path that fixes HE-AAC and AC-3 files: a Matroska with AC-3
    /// audio must come back with an AAC-LC track and playable video.
    #[test]
    fn ac3_matroska_is_remuxed_with_aac_audio() {
        let Some(ffmpeg) = crate::media_tools::find(crate::media_tools::FFMPEG) else {
            return;
        };
        if crate::media_tools::find(crate::media_tools::FFPROBE).is_none() {
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
                "vp9",
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
        assert_eq!(track_audio_plan(&before.audio_tracks[0]), AudioPlan::Encode);

        let target = dir.join("target.mp4");
        remux_sync(&source, &target, &before).expect("remux");
        let after = probe_sync(&target).ok().expect("probe target");
        assert_eq!(after.audio_codec.as_deref(), Some("aac"));
        assert_eq!(after.audio_profile.as_deref(), Some("LC"));
        assert!(plays_natively(&after, "mp4"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The #246 acceptance case for tracks: a Matroska with two audio tracks
    /// and a text subtitle must keep both tracks and carry the subtitle into
    /// the MP4 as `mov_text`, which WebKit exposes as captions.
    #[test]
    fn remux_keeps_every_audio_track_and_text_subtitles() {
        let Some(ffmpeg) = crate::media_tools::find(crate::media_tools::FFMPEG) else {
            return;
        };
        if crate::media_tools::find(crate::media_tools::FFPROBE).is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("visto-tracks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let subtitles = dir.join("subtitles.srt");
        std::fs::write(
            &subtitles,
            "1\n00:00:00,000 --> 00:00:00,800\nHello from the test\n",
        )
        .expect("write subtitle fixture");
        let source = dir.join("source.mkv");
        let status = Command::new(&ffmpeg)
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
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880",
                "-f",
                "srt",
                "-i",
            ])
            .arg(&subtitles)
            .args([
                "-t",
                "1",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-map",
                "2:a:0",
                "-map",
                "3:s:0",
                "-c:v",
                "mpeg4",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-c:s",
                "copy",
                "-metadata:s:a:0",
                "language=eng",
                "-metadata:s:a:1",
                "language=fra",
                "-metadata:s:s:0",
                "language=eng",
            ])
            .arg(&source)
            .status()
            .expect("run ffmpeg");
        if !status.success() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let before = probe_sync(&source).ok().expect("probe source");
        assert_eq!(before.audio_tracks.len(), 2, "fixture has two audio tracks");
        assert_eq!(before.subtitle_tracks.len(), 1, "fixture has a subtitle");

        let target = dir.join("target.mp4");
        remux_sync(&source, &target, &before).expect("remux");
        let after = probe_sync(&target).ok().expect("probe target");
        assert_eq!(after.audio_tracks.len(), 2, "both audio tracks survive");
        assert_eq!(after.audio_tracks[1].language.as_deref(), Some("fra"));
        assert_eq!(after.subtitle_tracks.len(), 1, "the subtitle survives");
        assert_eq!(after.subtitle_tracks[0].codec, "mov_text");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The #246 acceptance case for conversion: a WMV2 file that cannot be
    /// remuxed becomes H.264 that WebKit plays, with progress up to 100%.
    /// Skipped when this ffmpeg has no VideoToolbox encoder (non-macOS CI).
    #[tokio::test]
    async fn wmv_converts_to_a_natively_playable_h264_mp4() {
        if !h264_encoder_available() {
            return;
        }
        let Some(ffmpeg) = crate::media_tools::find(crate::media_tools::FFMPEG) else {
            return;
        };
        if crate::media_tools::find(crate::media_tools::FFPROBE).is_none() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("visto-convert-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let source = dir.join("source.wmv");
        let status = Command::new(&ffmpeg)
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
                "-t",
                "1",
                "-c:v",
                "wmv2",
                "-an",
            ])
            .arg(&source)
            .status()
            .expect("run ffmpeg");
        if !status.success() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let before = probe_sync(&source).ok().expect("probe source");
        assert_eq!(before.video_codec, "wmv2");
        assert!(convertible(&before), "a WMV is convertible");

        let target = dir.join("target.mp4");
        let progress = Arc::new(Mutex::new(Vec::<f64>::new()));
        let seen = progress.clone();
        let outcome = run_transcode(
            &source,
            &target,
            &before,
            Arc::new(AtomicBool::new(false)),
            move |value| {
                if let Some(value) = value {
                    seen.lock().expect("progress log").push(value);
                }
            },
        )
        .await;
        if let Err(error) = outcome {
            // A headless CI VM lists the encoder but cannot open a compression
            // session. That is the machine, not the recipe, so skip there; any
            // other failure is a real regression and must not pass silently.
            if error.message.contains("compression session") {
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
            panic!("conversion failed: {}", error.message);
        }
        let after = probe_sync(&target).ok().expect("probe target");
        assert_eq!(after.video_codec, "h264");
        assert!(plays_natively(&after, "mp4"), "converted file is playable");
        assert_eq!(
            progress.lock().expect("progress log").last().copied(),
            Some(1.0)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancelling_an_unknown_conversion_is_not_an_error() {
        assert!(!cancel_playback_conversion("/nope/missing.mp4".to_string()));
    }

    #[test]
    fn cache_keys_separate_versions_of_one_path() {
        let path = Path::new("/tmp/movie.mkv");
        assert_eq!(
            cache_key(REMUX_VERSION, path, 10, 1),
            cache_key(REMUX_VERSION, path, 10, 1)
        );
        assert_ne!(
            cache_key(REMUX_VERSION, path, 10, 1),
            cache_key(REMUX_VERSION, path, 10, 2)
        );
        // A conversion and a remux of one file are different cache entries.
        assert_ne!(
            cache_key(REMUX_VERSION, path, 10, 1),
            cache_key(TRANSCODE_VERSION, path, 10, 1)
        );
    }

    #[test]
    fn prune_sweeps_stale_partial_remuxes_even_under_budget() {
        let dir = std::env::temp_dir().join(format!(
            "visto-gallery-remux-temp-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create cache dir");
        let cached = dir.join("cached.mp4");
        let stale = dir.join("cached.1111.partial.mp4");
        let fresh = dir.join("next.2222.partial.mp4");
        std::fs::write(&cached, [0_u8; 4]).expect("write cached remux");
        std::fs::write(&stale, [0_u8; 4]).expect("write stale partial");
        std::fs::write(&fresh, [0_u8; 4]).expect("write fresh partial");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 60 * 60);
        std::fs::set_times(&stale, std::fs::FileTimes::new().set_modified(old))
            .expect("age the partial file");

        prune_cache(&dir, 1024);

        assert!(!stale.exists(), "a crashed remux is swept");
        assert!(
            fresh.exists(),
            "a partial that may still be in flight stays"
        );
        assert!(cached.exists(), "finished remuxes are untouched");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prune_over_budget_never_deletes_a_video_that_may_be_playing() {
        let dir = std::env::temp_dir().join(format!(
            "visto-gallery-remux-inuse-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create cache dir");
        let idle = dir.join("idle.mp4");
        let playing = dir.join("playing.mp4");
        std::fs::write(&idle, [0_u8; 8]).expect("write idle remux");
        std::fs::write(&playing, [0_u8; 8]).expect("write playing remux");
        let old = std::time::SystemTime::now()
            - super::super::storage::PLAYBACK_IN_USE_GRACE
            - std::time::Duration::from_secs(60);
        std::fs::set_times(&idle, std::fs::FileTimes::new().set_modified(old))
            .expect("age the idle remux");

        // A 1-byte budget would delete both if recency were ignored.
        prune_cache(&dir, 1);

        assert!(!idle.exists(), "the least recently used copy goes first");
        assert!(
            playing.exists(),
            "a copy used within the grace period stays"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
