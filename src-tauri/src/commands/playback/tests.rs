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
