//! Batch export helpers (filename rendering, image conversion/copy).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, GenericImageView, ImageEncoder};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::commands::{BatchExportItem, BatchExportRequest};

pub(crate) fn sanitize_batch_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().to_string();
    if trimmed.is_empty() {
        "export".to_string()
    } else {
        trimmed
    }
}

pub(crate) fn batch_output_extension(format: &str, source: &Path) -> String {
    match format {
        "jpeg" => "jpg".to_string(),
        "png" => "png".to_string(),
        "webp" => "webp".to_string(),
        _ => source
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .filter(|ext| !ext.is_empty())
            .unwrap_or_else(|| "jpg".to_string()),
    }
}

pub(crate) fn batch_date_label(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp(ms / 1000)
        .map(|dt| {
            format!(
                "{:04}-{:02}-{:02}",
                dt.year(),
                u8::from(dt.month()),
                dt.day()
            )
        })
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Render the filename pattern exactly the way the Batch screen previews it.
pub(crate) fn render_batch_filename(
    item: &BatchExportItem,
    pattern: &str,
    date_ms: Option<i64>,
    extension: &str,
) -> String {
    let source = Path::new(&item.source_path);
    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("export");
    let number = format!("{:03}", item.index + 1);
    let date = date_ms
        .map(batch_date_label)
        .unwrap_or_else(|| "unknown".to_string());
    let template = if pattern.trim().is_empty() {
        "{name}_{number}"
    } else {
        pattern
    };

    let rendered = template
        .replace("{name}", &sanitize_batch_name(stem))
        .replace("{number}", &number)
        .replace("{date}", &date)
        .replace("{ext}", extension);
    let rendered = sanitize_batch_name(&rendered);

    // The pattern may include an extension; always finish with the extension
    // that matches the bytes we are about to write.
    let path = Path::new(&rendered);
    let existing_ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if existing_ext.is_empty() {
        format!("{}.{}", rendered, extension)
    } else if existing_ext == extension || (extension == "jpg" && existing_ext == "jpeg") {
        rendered
    } else {
        let base = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or(&rendered);
        format!("{}.{}", sanitize_batch_name(base), extension)
    }
}

/// Never overwrite an existing export (or a name used earlier in this batch).
pub(crate) fn unique_batch_path(
    folder: &Path,
    file_name: &str,
    used: &mut HashSet<String>,
) -> PathBuf {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("export");
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");

    let mut candidate = file_name.to_string();
    let mut suffix = 2;
    while used.contains(&candidate.to_ascii_lowercase()) || folder.join(&candidate).exists() {
        candidate = if extension.is_empty() {
            format!("{}-{}", stem, suffix)
        } else {
            format!("{}-{}.{}", stem, suffix, extension)
        };
        suffix += 1;
    }
    used.insert(candidate.to_ascii_lowercase());
    folder.join(candidate)
}

pub(crate) fn resize_batch_image(image: DynamicImage, max_dimension: u32) -> DynamicImage {
    let (width, height) = image.dimensions();
    let longest = width.max(height);
    if longest == 0 || longest <= max_dimension {
        return image;
    }
    let scale = max_dimension as f64 / longest as f64;
    let next_width = ((width as f64) * scale).round().max(1.0) as u32;
    let next_height = ((height as f64) * scale).round().max(1.0) as u32;
    image.resize_exact(
        next_width,
        next_height,
        image::imageops::FilterType::Lanczos3,
    )
}

pub(crate) fn write_batch_jpeg(
    image: DynamicImage,
    path: &Path,
    quality: u8,
) -> Result<(), String> {
    let rgb = image.to_rgb8();
    let file = std::fs::File::create(path)
        .map_err(|e| format!("Could not create the export file: {}", e))?;
    let mut writer = std::io::BufWriter::new(file);
    JpegEncoder::new_with_quality(&mut writer, quality)
        .encode(
            &rgb,
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("JPEG encoding failed: {}", e))
}

pub(crate) fn write_batch_png(image: DynamicImage, path: &Path) -> Result<(), String> {
    let file = std::fs::File::create(path)
        .map_err(|e| format!("Could not create the export file: {}", e))?;
    let writer = std::io::BufWriter::new(file);
    PngEncoder::new_with_quality(writer, CompressionType::Default, FilterType::Adaptive)
        .write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
        .map_err(|e| format!("PNG encoding failed: {}", e))
}

pub(crate) fn write_batch_webp(image: DynamicImage, path: &Path) -> Result<(), String> {
    let file = std::fs::File::create(path)
        .map_err(|e| format!("Could not create the export file: {}", e))?;
    let mut writer = std::io::BufWriter::new(file);
    WebPEncoder::new_lossless(&mut writer)
        .encode(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
        .map_err(|e| format!("WebP encoding failed: {}", e))
}

/// macOS ImageIO can decode HEIC/HEIF and other formats the Rust `image`
/// crate cannot. `sips` exposes that pipeline on every Mac, so use it as a
/// fallback for JPEG/PNG targets.
pub(crate) fn write_batch_with_sips(
    source: &Path,
    output: &Path,
    extension: &str,
    quality: u8,
    max_dimension: Option<u32>,
) -> Result<(), String> {
    let format = match extension {
        "jpg" | "jpeg" => "jpeg",
        "png" => "png",
        other => return Err(format!("Unsupported fallback format: {}", other)),
    };

    let mut command = std::process::Command::new("/usr/bin/sips");
    if let Some(max) = max_dimension.filter(|dim| *dim > 0) {
        command.arg("-Z").arg(max.to_string());
    }
    command.arg("-s").arg("format").arg(format);
    if format == "jpeg" {
        command
            .arg("-s")
            .arg("formatOptions")
            .arg(quality.to_string());
    }
    let result = command
        .arg(source)
        .arg("--out")
        .arg(output)
        .output()
        .map_err(|e| format!("Could not run the macOS image converter: {}", e))?;

    if !result.status.success() || !output.exists() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            "macOS could not decode this image.".to_string()
        } else {
            detail.to_string()
        });
    }
    Ok(())
}

pub(crate) fn export_batch_item(
    item: &BatchExportItem,
    request: &BatchExportRequest,
    folder: &Path,
    quality: u8,
    used: &mut HashSet<String>,
) -> Result<PathBuf, String> {
    let source = Path::new(&item.source_path);
    if !source.is_file() {
        return Err("Source file not found on disk.".to_string());
    }

    let output_ext = batch_output_extension(&request.format, source);
    let date = item.date.or_else(|| {
        std::fs::metadata(source)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
    });
    let file_name = render_batch_filename(item, &request.pattern, date, &output_ext);
    let output_path = unique_batch_path(folder, &file_name, used);

    let converting = request.format != "source";
    let resizing = request.max_dimension.map(|dim| dim > 0).unwrap_or(false);
    let kind = item.kind.unwrap_or(crate::media_kind::MediaKind::Photo);

    // Videos and RAW files cannot be decoded by the built-in image encoder.
    // They can still be renamed and copied without modification.
    if kind == crate::media_kind::MediaKind::Video || kind == crate::media_kind::MediaKind::Raw {
        if converting || resizing || request.strip_metadata {
            let message = if kind == crate::media_kind::MediaKind::Video {
                "Video conversion is not supported yet. Choose “Keep source format” and turn off resizing and metadata stripping to copy videos."
            } else {
                "RAW conversion needs native macOS image support. Choose “Keep source format” and turn off resizing and metadata stripping to copy RAW files."
            };
            return Err(message.to_string());
        }
        std::fs::copy(source, &output_path)
            .map_err(|e| format!("Could not copy the file: {}", e))?;
        return Ok(output_path);
    }

    // A straight copy preserves the original bytes (and its metadata) exactly.
    if !converting && !resizing && !request.strip_metadata {
        std::fs::copy(source, &output_path)
            .map_err(|e| format!("Could not copy the file: {}", e))?;
        return Ok(output_path);
    }

    let image = match image::open(source) {
        Ok(image) => image,
        Err(decode_error) => {
            // HEIC/HEIF and some camera formats are only decodable through
            // macOS ImageIO. Fall back to `sips` when writing JPEG or PNG,
            // and use a temporary PNG when the target is WebP.
            let fallback_ext = match output_ext.as_str() {
                "jpg" | "jpeg" | "png" => output_ext.clone(),
                "webp" => "png".to_string(),
                _ => return Err(format!("Could not decode this image: {}", decode_error)),
            };
            let direct = fallback_ext == output_ext;
            let target = if direct {
                output_path.clone()
            } else {
                folder.join(format!(".visto-gallery-{}.png", Uuid::new_v4()))
            };

            if let Err(fallback_error) = write_batch_with_sips(
                source,
                &target,
                &fallback_ext,
                quality,
                request.max_dimension,
            ) {
                if !direct {
                    std::fs::remove_file(&target).ok();
                }
                return Err(format!(
                    "Could not decode this image: {} ({})",
                    decode_error, fallback_error
                ));
            }

            if direct {
                return Ok(output_path);
            }

            let decoded = image::open(&target)
                .map_err(|e| format!("Could not read the converted image: {}", e))?;
            let result = write_batch_webp(decoded, &output_path);
            std::fs::remove_file(&target).ok();
            return result.map(|_| output_path);
        }
    };
    let image = match request.max_dimension.filter(|dim| *dim > 0) {
        Some(max_dimension) => resize_batch_image(image, max_dimension),
        None => image,
    };

    match output_ext.as_str() {
        "jpg" | "jpeg" => write_batch_jpeg(image, &output_path, quality)?,
        "png" => write_batch_png(image, &output_path)?,
        "webp" => write_batch_webp(image, &output_path)?,
        other => {
            return Err(format!(
                "Can’t write .{} files yet. Choose JPEG, PNG, or WebP.",
                other
            ))
        }
    }

    Ok(output_path)
}
