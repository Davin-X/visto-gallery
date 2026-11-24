//! Thumbnail requests, generation (sips, Quick Look, ffmpeg) and the on-disk cache.

use super::*;

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ThumbnailRequest {
    item_id: String,
    #[ts(type = "64 | 128 | 256 | 512 | 1024")]
    size: u32,
    /// JPEG quality 1-100; defaults to 78.
    quality: Option<u8>,
    /// Cache budget in bytes; defaults to 512 MiB.
    max_cache_bytes: Option<u64>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailResponse {
    item_id: String,
    data_url: String,
    width: u32,
    height: u32,
}

/// Large originals should be downsampled by macOS ImageIO (via `sips`) instead
/// of being decoded into a full-resolution buffer just to shrink them.
pub(crate) const LARGE_THUMBNAIL_SOURCE_BYTES: i64 = 8 * 1024 * 1024;
/// Thumbnails are small, but they should still have a predictable disk budget.
const THUMBNAIL_PRUNE_INTERVAL_SECS: u64 = 60 * 60;
static LAST_THUMBNAIL_PRUNE_EPOCH: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn get_item_thumbnail(
    request: ThumbnailRequest,
    app: AppHandle,
    catalog: State<'_, crate::Catalog>,
) -> Result<ThumbnailResponse, CommandError> {
    if !matches!(request.size, 64 | 128 | 256 | 512 | 1024) {
        return Err(CommandError::invalid(
            "Unsupported thumbnail size".to_string(),
        ));
    }

    let db = super::get_db(&catalog)?;
    let (path, kind, modified_at, size, hidden) =
        sqlx::query_as::<_, (String, String, i64, i64, i64)>(
            "SELECT path, kind, modified_at, size, hidden FROM media_items WHERE id = ?",
        )
        .bind(&request.item_id)
        .fetch_optional(&db)
        .await?
        .ok_or_else(|| "Item not found in library".to_string())?;
    let item = (path, kind, modified_at, size);

    let quality = request.quality.unwrap_or(78).clamp(1, 100);
    let max_cache_bytes = request.max_cache_bytes.unwrap_or(512 * 1024 * 1024);

    let cache_root = app
        .path()
        .app_cache_dir()?
        .join(super::storage::THUMBNAILS_DIR);
    tokio::fs::create_dir_all(&cache_root).await?;
    let cache_key = thumbnail_cache_key(
        &request.item_id,
        item.2,
        item.3,
        request.size,
        &item.1,
        quality,
    );
    let digest = ring::digest::digest(&ring::digest::SHA256, cache_key.as_bytes());
    let cache_path = cache_root.join(super::storage::thumbnail_file_name(
        &request.item_id,
        &hex::encode(digest.as_ref()),
    ));

    // A hidden item's thumbnail is rendered for this response only and never
    // kept in the cache folder, where anyone could browse it.
    if hidden != 0 {
        let item_id = request.item_id.clone();
        let size = request.size;
        let rendered = tokio::task::spawn_blocking(move || {
            super::storage::remove_item_thumbnails(&cache_root, &item_id);
            render_uncached_thumbnail(&item.0, size, item.3, quality, &item.1)
        })
        .await
        .map_err(|error| CommandError::internal(format!("Thumbnail worker failed: {error}")))??;
        let (bytes, width, height) = rendered;
        return Ok(ThumbnailResponse {
            item_id: request.item_id,
            data_url: format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)),
            width,
            height,
        });
    }

    // A cache hit reads the file once and takes its dimensions from the bytes
    // already in memory; a miss reuses the bytes the generator just wrote.
    let cached = match tokio::fs::read(&cache_path).await {
        Ok(bytes) => jpeg_dimensions(&bytes).map(|(width, height)| (bytes, width, height)),
        Err(_) => None,
    };
    let (bytes, width, height) = if let Some(cached) = cached {
        // Mark the hit so budget pruning evicts the least recently used file.
        let touched = cache_path.clone();
        tokio::task::spawn_blocking(move || super::storage::touch_if_stale(&touched));
        cached
    } else {
        let _ = tokio::fs::remove_file(&cache_path).await;
        let source_path = item.0;
        let source_size = item.3;
        let item_kind = item.1;
        let target_path = cache_path.clone();
        let size = request.size;
        let generated = tokio::task::spawn_blocking(move || {
            generate_cached_thumbnail(
                &source_path,
                &target_path,
                size,
                source_size,
                quality,
                &item_kind,
            )
        })
        .await
        .map_err(|error| CommandError::internal(format!("Thumbnail worker failed: {error}")))??;
        maybe_prune_thumbnail_cache(cache_root.clone(), max_cache_bytes);
        generated
    };

    Ok(ThumbnailResponse {
        item_id: request.item_id,
        data_url: format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)),
        width,
        height,
    })
}

/// Render a thumbnail without keeping it: the generators write a file, so it
/// goes to a private per-user temp folder and is deleted as soon as it is read.
fn render_uncached_thumbnail(
    source: &str,
    size: u32,
    source_size: i64,
    quality: u8,
    kind: &str,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    let scratch = std::env::temp_dir().join("visto-uncached-thumbnails");
    std::fs::create_dir_all(&scratch)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&scratch, std::fs::Permissions::from_mode(0o700));
    }
    let target = scratch.join(format!("{}.jpg", Uuid::new_v4()));
    let result = generate_cached_thumbnail(source, &target, size, source_size, quality, kind);
    let _ = std::fs::remove_file(&target);
    result
}

/// Cache identity must include every input that changes the rendered image.
/// Thumbnails for the same photo at different sizes or JPEG qualities are
/// distinct files.
pub(crate) fn thumbnail_cache_key(
    item_id: &str,
    modified_at: i64,
    source_size: i64,
    thumbnail_size: u32,
    kind: &str,
    quality: u8,
) -> String {
    // Bumping the video version invalidates the cached "No preview" placeholder
    // written for containers QuickLook could not open.
    let version = if kind == "video" { "v3" } else { "v1" };
    format!("{item_id}:{modified_at}:{source_size}:{thumbnail_size}:{version}:q{quality}")
}

/// Keep the cache bounded without making every thumbnail request pay for a
/// directory scan. The first cache miss after an interval triggers a detached
/// cleanup, and concurrent requests are deduplicated by the epoch compare-exchange.
fn maybe_prune_thumbnail_cache(root: PathBuf, max_bytes: u64) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let last = LAST_THUMBNAIL_PRUNE_EPOCH.load(Ordering::Relaxed);
    if now.saturating_sub(last) < THUMBNAIL_PRUNE_INTERVAL_SECS {
        return;
    }
    if LAST_THUMBNAIL_PRUNE_EPOCH
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    tokio::task::spawn_blocking(move || {
        prune_thumbnail_cache(&root, max_bytes);
    });
}

/// A cache temp file (`.tmp.` in the name) older than this is a crashed
/// writer's leftover, not something still in flight.
const CACHE_TEMP_GRACE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Cache renders are written to `<digest>.<uuid>.tmp.jpg` and renamed into
/// place, so a crash can leave the temp behind.
fn is_cache_temp(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains(".tmp."))
}

/// Remove the oldest thumbnails until the directory fits the budget.
/// Returns (deleted_count, bytes_freed, failed_count).
///
/// Temp files are swept regardless of the budget: a fresh one may still be
/// mid-write, so it is skipped (and never counted), but a stale one is
/// removed so it cannot sit in the cache forever.
pub(crate) fn prune_thumbnail_cache(root: &Path, max_bytes: u64) -> (usize, u64, usize) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return (0, 0, 0);
    };

    let cutoff = SystemTime::now().checked_sub(CACHE_TEMP_GRACE);
    let mut files = Vec::new();
    let mut total = 0_u64;
    let mut deleted = 0;
    let mut bytes_freed = 0_u64;
    let mut failed = 0;

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if is_cache_temp(&path) {
            let stale = cutoff.is_some_and(|cutoff| {
                metadata
                    .modified()
                    .map(|modified| modified <= cutoff)
                    .unwrap_or(false)
            });
            if stale {
                match std::fs::remove_file(&path) {
                    Ok(_) => {
                        deleted += 1;
                        bytes_freed += metadata.len();
                    }
                    Err(_) => failed += 1,
                }
            }
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("jpg") {
            continue;
        }
        let size = metadata.len();
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        total += size;
        files.push((path, size, modified));
    }

    if total <= max_bytes {
        return (deleted, bytes_freed, failed);
    }

    // Hits refresh the modified time (`touch_if_stale`), so oldest-first is
    // least-recently-used first.
    files.sort_by_key(|(_, _, modified)| *modified);

    for (path, size, _) in files {
        if total <= max_bytes {
            break;
        }
        match std::fs::remove_file(&path) {
            Ok(_) => {
                total = total.saturating_sub(size);
                deleted += 1;
                bytes_freed += size;
            }
            Err(_) => {
                failed += 1;
                // Don't subtract size since deletion failed
            }
        }
    }

    (deleted, bytes_freed, failed)
}

/// Dimensions of an encoded image held in memory (cached thumbnails are JPEG),
/// or `None` when the bytes are not a readable image.
fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

pub(crate) fn generate_cached_thumbnail(
    source: &str,
    destination: &Path,
    size: u32,
    source_size: i64,
    quality: u8,
    kind: &str,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    #[cfg(target_os = "macos")]
    {
        // RAW files: try macOS ImageIO (sips) which supports some RAW via Camera Raw.
        if kind == "raw" {
            if let Ok(result) = generate_with_macos_sips(
                source,
                destination,
                size,
                quality,
                "macOS sips (RAW via ImageIO)",
            ) {
                return Ok(result);
            }
        }
        // Video files: QuickLook covers what macOS can decode, and ffmpeg covers
        // the rest. QuickLook has no VP9/AV1 decoder: it returns nothing — or
        // hangs until the timeout — and the grid was left with "No preview" for
        // a video the player itself could play.
        if kind == "video" {
            if quicklook_handles_container(source) {
                if let Ok(result) = generate_thumbnail_with_qlmanage(source, destination, size) {
                    return Ok(result);
                }
                if let Ok(result) =
                    generate_thumbnail_with_ffmpeg(source, destination, size, quality)
                {
                    return Ok(result);
                }
            } else {
                // Skip the guaranteed timeout for containers QuickLook never opens.
                if let Ok(result) =
                    generate_thumbnail_with_ffmpeg(source, destination, size, quality)
                {
                    return Ok(result);
                }
                if let Ok(result) = generate_thumbnail_with_qlmanage(source, destination, size) {
                    return Ok(result);
                }
            }
        }

        // Large images: use sips for macOS ImageIO downsampling (HEIC/HEIF/large photos).
        if source_size > LARGE_THUMBNAIL_SOURCE_BYTES {
            return generate_with_macos_sips(
                source,
                destination,
                size,
                quality,
                "macOS sips (large image)",
            );
        }
    }
    // Fallback: use image crate (used on non-macOS, and for small images on macOS).
    // Only photo kinds are supported here; RAW/video will fall through to placeholder.
    if kind != "photo" {
        return generate_placeholder_thumbnail(destination, size, kind);
    }
    let reader = image::ImageReader::open(source)
        .map_err(|error| CommandError::io(format!("Could not read photo: {error}")))?
        .with_guessed_format()
        .map_err(|error| {
            CommandError::new(
                ErrorCode::UnsupportedFormat,
                format!("Could not identify photo format: {error}"),
            )
        })?;
    let mut decoder = match reader.into_decoder() {
        Ok(decoder) => decoder,
        Err(error) => {
            let reason = format!("decode failed: {error}");
            return generate_with_macos_sips(source, destination, size, quality, &reason);
        }
    };
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = match DynamicImage::from_decoder(decoder) {
        Ok(image) => image,
        Err(error) => {
            let reason = format!("decode failed: {error}");
            return generate_with_macos_sips(source, destination, size, quality, &reason);
        }
    };
    image.apply_orientation(orientation);
    let thumbnail = image.thumbnail(size, size).to_rgb8();
    let (width, height) = (thumbnail.width(), thumbnail.height());
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode(&thumbnail, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|error| CommandError::io(format!("Could not encode thumbnail: {error}")))?;

    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, &bytes)?;
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, width, height))
}

/// Generate a placeholder thumbnail for RAW/video files that cannot be decoded
/// by the available image libraries. Draws a solid color with a kind label.
fn generate_placeholder_thumbnail(
    destination: &Path,
    size: u32,
    kind: &str,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    use image::{Rgb, RgbImage};
    let color = match kind {
        "raw" => Rgb([120, 110, 90]),   // warm gray for RAW
        "video" => Rgb([70, 110, 160]), // blue-gray for video
        _ => Rgb([150, 150, 150]),      // neutral gray fallback
    };
    let img = RgbImage::from_pixel(size, size, color);
    let (width, height) = (img.width(), img.height());
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 78)
        .encode(&img, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|error| {
            CommandError::io(format!("Could not encode placeholder thumbnail: {error}"))
        })?;

    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, &bytes)?;
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, width, height))
}

/// Containers macOS QuickLook can open. Anything else would only burn the
/// ten-second `qlmanage` timeout before producing nothing.
#[cfg(target_os = "macos")]
fn quicklook_handles_container(source: &str) -> bool {
    let extension = Path::new(source)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase();
    !matches!(
        extension.as_str(),
        "mkv"
            | "avi"
            | "wmv"
            | "flv"
            | "webm"
            | "ts"
            | "m2ts"
            | "mts"
            | "mpg"
            | "mpeg"
            | "vob"
            | "ogv"
            | "3gp"
    )
}

/// Extract a poster frame with ffmpeg.
///
/// QuickLook relies on the system decoders, so containers and codecs macOS does
/// not ship (VP9 and AV1 in MP4 are the common ones from social downloads) get no
/// thumbnail at all. ffmpeg decodes them, which keeps the grid and filmstrip
/// consistent with what the player can actually play.
#[cfg(target_os = "macos")]
fn generate_thumbnail_with_ffmpeg(
    source: &str,
    destination: &Path,
    size: u32,
    quality: u8,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    let ffmpeg = crate::media_tools::find(crate::media_tools::FFMPEG).ok_or_else(|| {
        CommandError::new(
            ErrorCode::UnsupportedFormat,
            "ffmpeg is not installed, so this video has no preview".to_string(),
        )
    })?;

    let tmp_dir = std::env::temp_dir().join(format!("visto-ffmpeg-poster-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir)?;

    let result = (|| {
        let frame = tmp_dir.join("poster.jpg");
        let filter = format!("scale={size}:-2:force_original_aspect_ratio=decrease");
        let mut extracted = false;
        // Opening frames are often black, so start slightly in — but a very
        // short clip has no frame at 0.5s, hence the fallback to the first one.
        for seek in ["0.5", "0"] {
            let _ = std::fs::remove_file(&frame);
            let output = std::process::Command::new(&ffmpeg)
                .args(["-nostdin", "-v", "error", "-y", "-ss", seek, "-i", source])
                .args(["-frames:v", "1", "-vf", &filter])
                .arg(&frame)
                .output()
                .map_err(|error| {
                    CommandError::internal(format!("ffmpeg could not run: {error}"))
                })?;
            if output.status.success() && frame.is_file() {
                extracted = true;
                break;
            }
        }
        if !extracted {
            return Err(CommandError::new(
                ErrorCode::UnsupportedFormat,
                "ffmpeg could not extract a frame from this video".to_string(),
            ));
        }

        let image = image::ImageReader::open(&frame)
            .map_err(|error| {
                CommandError::io(format!("Could not read the extracted frame: {error}"))
            })?
            .with_guessed_format()
            .map_err(|error| {
                CommandError::new(
                    ErrorCode::UnsupportedFormat,
                    format!("Could not identify the extracted frame: {error}"),
                )
            })?
            .decode()
            .map_err(|error| {
                CommandError::new(
                    ErrorCode::UnsupportedFormat,
                    format!("Could not decode the extracted frame: {error}"),
                )
            })?
            .thumbnail(size, size)
            .to_rgb8();
        let (width, height) = (image.width(), image.height());
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, quality)
            .encode(&image, width, height, image::ExtendedColorType::Rgb8)
            .map_err(|error| {
                CommandError::io(format!("Could not encode the video thumbnail: {error}"))
            })?;

        let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
        std::fs::write(&temporary, &bytes)?;
        commit_thumbnail_file(&temporary, destination)?;
        Ok((bytes, width, height))
    })();

    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Generate a video thumbnail using macOS QuickLook (qlmanage).
/// Extracts a representative frame from the video file.
#[cfg(target_os = "macos")]
fn generate_thumbnail_with_qlmanage(
    source: &str,
    destination: &Path,
    size: u32,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    use std::process::Command;

    let tmp_dir = std::env::temp_dir().join(format!("visto-qlmanage-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|error| CommandError::io(format!("Could not create temp dir: {error}")))?;

    let mut child = Command::new("/usr/bin/qlmanage")
        .args([
            "-t",
            "-s",
            &size.to_string(),
            "-o",
            tmp_dir.to_str().unwrap(),
            source,
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| CommandError::internal(format!("qlmanage not available: {error}")))?;

    // QuickLook can hang on large or exotic video containers (a multi-GB MKV
    // is a real example), so cap the wait instead of occupying a thumbnail
    // worker indefinitely.
    let timeout = std::time::Duration::from_secs(10);
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(CommandError::internal(
                    "qlmanage thumbnail timed out".to_string(),
                ));
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(&tmp_dir);
                return Err(CommandError::internal(format!(
                    "qlmanage thumbnail failed: {error}"
                )));
            }
        }
    };

    if !status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(CommandError::internal(
            "qlmanage thumbnail failed".to_string(),
        ));
    }

    let result = (|| {
        let thumbnail_path = find_qlmanage_output(&tmp_dir)?;
        normalize_qlmanage_thumbnail(&thumbnail_path, destination, size)
    })();
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

fn normalize_qlmanage_thumbnail(
    source: &Path,
    destination: &Path,
    size: u32,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    let image = image::ImageReader::open(source)
        .map_err(|error| CommandError::io(format!("Could not read QuickLook thumbnail: {error}")))?
        .with_guessed_format()
        .map_err(|error| {
            CommandError::new(
                ErrorCode::UnsupportedFormat,
                format!("Could not identify QuickLook thumbnail: {error}"),
            )
        })?
        .decode()
        .map_err(|error| {
            CommandError::new(
                ErrorCode::UnsupportedFormat,
                format!("Could not decode QuickLook thumbnail: {error}"),
            )
        })?
        .thumbnail(size, size)
        .to_rgb8();
    let (width, height) = (image.width(), image.height());
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 78)
        .encode(&image, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|error| {
            CommandError::io(format!("Could not encode QuickLook thumbnail: {error}"))
        })?;

    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, &bytes)?;
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, width, height))
}

#[cfg(not(target_os = "macos"))]
fn generate_thumbnail_with_qlmanage(
    _source: &str,
    _destination: &Path,
    _size: u32,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    Err(CommandError::internal(
        "qlmanage not available on this platform".to_string(),
    ))
}

/// Find the newest decodable image generated by QuickLook. `qlmanage` commonly
/// writes PNG files even though our thumbnail cache is JPEG.
fn find_qlmanage_output(dir: &Path) -> Result<std::path::PathBuf, CommandError> {
    let mut best: Option<std::path::PathBuf> = None;
    let mut best_time = std::time::UNIX_EPOCH;
    let entries = std::fs::read_dir(dir)
        .map_err(|error| CommandError::io(format!("Could not read QuickLook output: {error}")))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            CommandError::io(format!("Could not read QuickLook output: {error}"))
        })?;
        let path = entry.path();
        if !entry
            .file_type()
            .map_err(|error| {
                CommandError::io(format!("Could not inspect QuickLook output: {error}"))
            })?
            .is_file()
            || image::image_dimensions(&path).is_err()
        {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.is_none() || modified > best_time {
            best_time = modified;
            best = Some(path);
        }
    }
    best.ok_or_else(|| CommandError::not_found("qlmanage output not found"))
}

#[cfg(test)]
mod qlmanage_thumbnail_tests {
    use super::{find_qlmanage_output, normalize_qlmanage_thumbnail};
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn finds_quicklook_png_output() {
        let root = std::env::temp_dir().join(format!("visto-qlmanage-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test directory");
        let image_path = root.join("video.mov.png");
        image::RgbImage::from_pixel(32, 18, image::Rgb([90, 130, 180]))
            .save(&image_path)
            .expect("write QuickLook PNG");
        fs::write(root.join("video.mov.txt"), b"not an image").expect("write non-image file");

        assert_eq!(
            find_qlmanage_output(&root).expect("find generated QuickLook image"),
            image_path
        );
        fs::remove_dir_all(&root).expect("remove test directory");
    }

    #[test]
    fn normalizes_quicklook_png_to_cached_jpeg() {
        let root = std::env::temp_dir().join(format!("visto-qlmanage-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test directory");
        let source = root.join("video.mov.png");
        let destination = root.join("cached.jpg");
        image::RgbImage::from_pixel(64, 32, image::Rgb([90, 130, 180]))
            .save(&source)
            .expect("write QuickLook PNG");

        let (bytes, width, height) =
            normalize_qlmanage_thumbnail(&source, &destination, 24).expect("normalize thumbnail");

        assert_eq!(
            image::guess_format(&bytes).expect("identify cached image"),
            image::ImageFormat::Jpeg
        );
        assert_eq!(
            image::image_dimensions(&destination).expect("read cached image"),
            (24, 12)
        );
        assert_eq!((width, height), (24, 12));
        fs::remove_dir_all(&root).expect("remove test directory");
    }

    #[test]
    fn reports_when_quicklook_has_no_image_output() {
        let root = std::env::temp_dir().join(format!("visto-qlmanage-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test directory");
        fs::write(root.join("video.mov.txt"), b"not an image").expect("write non-image file");

        assert_eq!(
            find_qlmanage_output(&root)
                .expect_err("no image should be found")
                .message,
            "qlmanage output not found"
        );
        fs::remove_dir_all(&root).expect("remove test directory");
    }
}

fn commit_thumbnail_file(temporary: &Path, destination: &Path) -> Result<(), CommandError> {
    match std::fs::rename(temporary, destination) {
        Ok(()) => {}
        Err(_) if destination.exists() => {
            let _ = std::fs::remove_file(temporary);
        }
        Err(error) => {
            let _ = std::fs::remove_file(temporary);
            return Err(CommandError::internal(error.to_string()));
        }
    }
    Ok(())
}

/// `sips` is a thin wrapper over macOS ImageIO, which downsamples during
/// decode. That keeps memory flat for large photos and handles HEIC/HEIF.
#[cfg(target_os = "macos")]
pub(crate) fn generate_with_macos_sips(
    source: &str,
    destination: &Path,
    size: u32,
    quality: u8,
    reason: &str,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    use std::process::Command;

    let temporary = destination.with_extension(format!("{}.tmp.jpg", Uuid::new_v4()));
    let quality = quality.to_string();
    let edge = size.to_string();
    let mut args = vec![
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        quality.as_str(),
    ];
    // `size` 0 keeps the full decoded size (the viewer's Actual Size).
    if size > 0 {
        args.extend(["-Z", edge.as_str()]);
    }
    let output = Command::new("/usr/bin/sips")
        .args(&args)
        .arg(source)
        .arg("--out")
        .arg(&temporary)
        .output()
        .map_err(|error| {
            format!("Could not create thumbnail ({reason}); macOS ImageIO failed: {error}")
        })?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&temporary);
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(CommandError::internal(format!(
            "Could not create thumbnail ({reason}): {}",
            detail.trim()
        )));
    }
    let dimensions = match image::image_dimensions(&temporary) {
        Ok(dimensions) => dimensions,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(CommandError::internal(error.to_string()));
        }
    };
    let bytes = match std::fs::read(&temporary) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            return Err(CommandError::internal(error.to_string()));
        }
    };
    commit_thumbnail_file(&temporary, destination)?;
    Ok((bytes, dimensions.0, dimensions.1))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn generate_with_macos_sips(
    _source: &str,
    _destination: &Path,
    _size: u32,
    reason: &str,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    Err(CommandError::internal(format!(
        "Could not create thumbnail ({reason})"
    )))
}

#[cfg(test)]
mod thumbnail_bytes_tests {
    use super::jpeg_dimensions;

    #[test]
    fn reads_dimensions_from_encoded_bytes() {
        let img = image::RgbImage::new(7, 3);
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Jpeg,
            )
            .unwrap();
        assert_eq!(jpeg_dimensions(&bytes), Some((7, 3)));
    }

    #[test]
    fn rejects_corrupt_bytes() {
        assert_eq!(jpeg_dimensions(b"not an image"), None);
    }
}
