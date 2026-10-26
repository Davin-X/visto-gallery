use crate::AppState;
use super::*;
use serde_json::json;
use std::io::Write;
use image::{DynamicImage, ImageEncoder};
use std::path::PathBuf;
use tauri::{State, Window};

#[tauri::command]
pub async fn move_to_trash(
    paths: Vec<String>,
    state: State<'_, AppState>,
    window: Window,
) -> Result<TrashResult, String> {
    super::TRASH_CANCEL.store(false, Ordering::SeqCst);

    let db = super::get_db(&state)?;

    // Only trash paths that exist on disk. Files not in the catalog can still be
    // trashed if they exist (e.g. imported outside the app).
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|p| std::path::Path::new(p).exists())
        .collect();
    if paths.is_empty() {
        return Err("Selected items no longer exist on disk.".to_string());
    }

    let _ = window.emit(
        "import-progress",
        json!({
            "phase": "trashing",
            "processed": 0,
            "total": paths.len(),
        }),
    );

    let mut trashed = Vec::new();
    let mut failed = Vec::new();

    // Trash in chunks using trash::delete_all, which moves many files in a
    // single OS-level operation (much faster than one-by-one). Fall back to
    // per-file deletes if a chunk fails so partial results are still reported.
    const TRASH_CHUNK: usize = 50;
    let total = paths.len();
    let mut processed = 0usize;
    for chunk in paths.chunks(TRASH_CHUNK) {
        if super::TRASH_CANCEL.load(Ordering::SeqCst) {
            for p in chunk {
                failed.push(TrashError {
                    path: p.clone(),
                    error: "Operation cancelled".to_string(),
                });
            }
            processed += chunk.len();
            continue;
        }

        let _ = window.emit(
            "import-progress",
            json!({
                "phase": "trashing",
                "processed": processed,
                "total": total,
                "currentFile": chunk.first().cloned().unwrap_or_default(),
            }),
        );

        let chunk_paths: Vec<String> = chunk.to_vec();
        let result = tokio::task::spawn_blocking(move || trash::delete_all(&chunk_paths)).await;

        match result {
            Ok(Ok(())) => {
                trashed.extend(chunk.iter().cloned());
            }
            _ => {
                // Fallback: try each file individually so partial successes count.
                for path in chunk {
                    if super::TRASH_CANCEL.load(Ordering::SeqCst) {
                        failed.push(TrashError {
                            path: path.clone(),
                            error: "Operation cancelled".to_string(),
                        });
                        continue;
                    }
                    match tokio::task::spawn_blocking({
                        let path = path.clone();
                        move || trash::delete(&path)
                    })
                    .await
                    {
                        Ok(Ok(())) => trashed.push(path.clone()),
                        Ok(Err(e)) => failed.push(TrashError {
                            path: path.clone(),
                            error: format!("Could not move to Trash: {}", e),
                        }),
                        Err(e) => failed.push(TrashError {
                            path: path.clone(),
                            error: format!("Trash task failed: {}", e),
                        }),
                    }
                }
            }
        }

        processed += chunk.len();
    }

    let _ = window.emit(
        "import-progress",
        json!({
            "phase": "trashing",
            "processed": paths.len(),
            "total": paths.len(),
        }),
    );

    if !trashed.is_empty() {
        let mut transaction = db.begin().await.map_err(|e| e.to_string())?;
        for path in &trashed {
            sqlx::query("DELETE FROM media_items WHERE path = ?")
                .bind(path)
                .execute(&mut *transaction)
                .await
                .map_err(|e| e.to_string())?;
        }
        transaction.commit().await.map_err(|e| e.to_string())?;
    }

    Ok(TrashResult { trashed, failed })
}

#[tauri::command]
pub async fn reveal_in_finder(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = super::get_db(&state)?;
    let exists: Option<String> = sqlx::query_scalar("SELECT path FROM media_items WHERE path = ?")
        .bind(&path)
        .fetch_optional(&db)
        .await
        .map_err(|e| e.to_string())?;
    if exists.is_none() {
        return Err("Path is not part of the catalog.".to_string());
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| format!("Could not reveal {}: {}", path, e))?;
    Ok(())
}

#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    // Unlike `open -R` (which selects a file in its parent), this opens the
    // folder itself in Finder. Used by Batch export results.
    if !std::path::Path::new(&path).is_dir() {
        return Err("Path is not a directory.".to_string());
    }
    std::process::Command::new("open")
        .arg(&path)
        .status()
        .map_err(|e| format!("Could not open {}: {}", path, e))?;
    Ok(())
}

#[tauri::command]
pub async fn read_exif(path: String, state: State<'_, AppState>) -> Result<ExifData, String> {
    let db = super::get_db(&state)?;
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    if !registered.is_empty() {
        validate_path_under_registered_roots(&path, &registered)?;
    }
    tokio::task::spawn_blocking(move || {
        let mut data = ExifData {
            captured_at: None,
            camera: None,
            lens: None,
            exposure: None,
            iso: None,
            latitude: None,
            longitude: None,
            width: None,
            height: None,
            metadata_error: None,
        };

        let file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                data.metadata_error = Some(e.to_string());
                return Ok(data);
            }
        };
        let mut buf = std::io::BufReader::new(&file);
        let exif_reader = exif::Reader::new();
        let exif = match exif_reader.read_from_container(&mut buf) {
            Ok(e) => e,
            Err(e) => {
                data.metadata_error = Some(e.to_string());
                return Ok(data);
            }
        };

        if let Some(field) = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
            let s = field.display_value().to_string();
            if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&s, "%Y:%m:%d %H:%M:%S") {
                data.captured_at = Some(dt.and_utc().timestamp());
            }
        }
        let make = exif.get_field(exif::Tag::Make, exif::In::PRIMARY).map(|f| f.display_value().to_string());
        let model = exif.get_field(exif::Tag::Model, exif::In::PRIMARY).map(|f| f.display_value().to_string());
        data.camera = match (make, model) {
            (Some(m), Some(modl)) => Some(format!("{} {}", m.trim(), modl.trim())),
            (Some(m), None) => Some(m.trim().to_string()),
            (None, Some(modl)) => Some(modl.trim().to_string()),
            _ => None,
        };
        if let Some(f) = exif.get_field(exif::Tag::LensModel, exif::In::PRIMARY) {
            data.lens = Some(f.display_value().to_string().trim().to_string());
        }
        if let Some(f) = exif.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY) {
            data.exposure = Some(f.display_value().to_string());
        }
        if let Some(f) = exif.get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY) {
            if let exif::Value::Short(ref v) = f.value {
                if let Some(&x) = v.first() {
                    data.iso = Some(x as i32);
                }
            }
        }
        if let Some(f) = exif.get_field(exif::Tag::PixelXDimension, exif::In::PRIMARY) {
            if let exif::Value::Long(ref v) = f.value {
                data.width = v.first().map(|&x| x as i32);
            }
        }
        if let Some(f) = exif.get_field(exif::Tag::PixelYDimension, exif::In::PRIMARY) {
            if let exif::Value::Long(ref v) = f.value {
                data.height = v.first().map(|&x| x as i32);
            }
        }
        // GPS
        if let (Some(lat), Some(lon)) = (
            exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY),
            exif.get_field(exif::Tag::GPSLongitude, exif::In::PRIMARY),
        ) {
            // Convert DMS to decimal degrees is non-trivial; leave display string for now.
            let _ = (lat, lon);
        }
        Ok(data)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_exif(path: String, data: PartialExifData, state: State<'_, AppState>) -> Result<(), String> {
    let db = super::get_db(&state)?;
    let registered: Vec<String> = sqlx::query_scalar("SELECT path FROM library_folders")
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;
    if !registered.is_empty() {
        validate_path_under_registered_roots(&path, &registered)?;
    }
    let _ = (path, data, state);
    Ok(())
}

#[tauri::command]
pub async fn render_edited(request: RenderRequest, _state: State<'_, AppState>) -> Result<ExportResult, String> {
    // Offload CPU-intensive image processing to blocking pool
    tauri::async_runtime::spawn_blocking(move || {
        render_edited_blocking(request)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Core image editing pipeline - runs in blocking pool
fn render_edited_blocking(request: RenderRequest) -> Result<ExportResult, String> {
    use std::path::PathBuf;

    let source_path = PathBuf::from(&request.source_path);
    
    // 1. Load image with metadata
    let reader = image::ImageReader::open(&source_path)
        .map_err(|e| format!("Could not open image: {}", e))?
        .with_guessed_format()
        .map_err(|e| format!("Could not identify image format: {}", e))?;
    
    let _format = reader.format().ok_or("Unknown image format")?;
    let mut img = reader.decode()
        .map_err(|e| format!("Could not decode image: {}", e))?;
    
    let (orig_width, orig_height) = (img.width(), img.height());
    
    // 2. Read EXIF data before any modifications (for preservation)
    let exif_data = read_exif_bytes(&source_path);
    
    // 3. Apply crop in SOURCE space (before rotation/flip)
    // CropRect is normalized (0-1) against source dimensions
    if let Some(crop) = request.crop {
        let crop_x = (crop.x * orig_width as f32).round() as u32;
        let crop_y = (crop.y * orig_height as f32).round() as u32;
        let crop_w = (crop.width * orig_width as f32).round() as u32;
        let crop_h = (crop.height * orig_height as f32).round() as u32;
        
        // Clamp to image bounds
        let crop_x = crop_x.min(orig_width.saturating_sub(1));
        let crop_y = crop_y.min(orig_height.saturating_sub(1));
        let crop_w = crop_w.min(orig_width - crop_x).max(1);
        let crop_h = crop_h.min(orig_height - crop_y).max(1);
        
        img = img.crop_imm(crop_x, crop_y, crop_w, crop_h);
    }
    
    // 4. Apply rotation (in 90-degree increments)
    let rotation = ((request.edits.rotation % 360) + 360) % 360;
    match rotation {
        90 => img = img.rotate90(),
        180 => img = img.rotate180(),
        270 => img = img.rotate270(),
        _ => {}
    }
    
    // 5. Apply horizontal flip
    if request.edits.flip {
        img = img.fliph();
    }
    
    // 6. Apply color adjustments
    // exposure, contrast, warmth, shadows, highlights, saturation
    // These are applied as linear RGB adjustments
    if has_color_adjustments(&request.edits) {
        img = apply_color_adjustments(img, &request.edits);
    }
    
    let (final_width, final_height) = (img.width(), img.height());
    
    // 7. Determine output format for writing (preserve source format for in-place edits)
    let write_format = if request.output_format == "in_place" {
        match source_path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .as_deref()
        {
            Some("png") => "image/png".to_string(),
            Some("webp") => "image/webp".to_string(),
            _ => "image/jpeg".to_string(),
        }
    } else {
        request.output_format.clone()
    };

    // 8. Determine output path
    let output_path = if request.output_format == "in_place" {
        // In-place: write to temp next to source, then atomic rename
        let tmp_path = source_path.with_extension(format!(
            "tmp-{}",
            uuid::Uuid::new_v4()
        ));
        
        // Create backup
        let backup_path = source_path.with_extension(format!("{}.bak", 
            source_path.extension().and_then(|s| s.to_str()).unwrap_or("bak")));
        let _ = std::fs::copy(&source_path, &backup_path);
        
        // Write to temp
        write_image(&img, &tmp_path, &write_format, request.quality, request.strip_metadata, &exif_data)?;
        
        // Atomic rename
        std::fs::rename(&tmp_path, &source_path)
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp_path);
                format!("Failed to replace original: {}", e)
            })?;
        
        source_path.to_string_lossy().into_owned()
    } else {
        // Save a copy - caller handles path via dialog
        // We write to a temp location and return the path
        let tmp_dir = std::env::temp_dir();
        let output_name = format!(
            "{}_edited.{}",
            source_path.file_stem().and_then(|s| s.to_str()).unwrap_or("image"),
            match request.output_format.as_str() {
                "image/png" => "png",
                "image/webp" => "webp",
                _ => "jpg",
            }
        );
        let output_path = tmp_dir.join(output_name);
        
        write_image(&img, &output_path, &write_format, request.quality, request.strip_metadata, &exif_data)?;
        
        output_path.to_string_lossy().into_owned()
    };
    
    // 8. Verify output
    let metadata = std::fs::metadata(&output_path).map_err(|e| format!("Output verification failed: {}", e))?;
    let size = metadata.len() as i64;
    
    Ok(ExportResult {
        output_path,
        size,
        width: final_width as i32,
        height: final_height as i32,
    })
}

/// Move an exported temp file to its final destination.
#[tauri::command]
pub async fn move_exported_file(source_path: String, destination_path: String, _state: State<'_, AppState>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        use std::path::PathBuf;
        let src = PathBuf::from(&source_path);
        let dst = PathBuf::from(&destination_path);

        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Could not create destination folder: {}", e))?;
        }

        // Prefer an atomic rename; fall back to copy+remove for cross-device moves.
        if std::fs::rename(&src, &dst).is_ok() {
            return Ok(());
        }

        std::fs::copy(&src, &dst).map_err(|e| format!("Could not copy exported file: {}", e))?;
        let _ = std::fs::remove_file(&src);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Check if any color adjustments are non-zero
fn has_color_adjustments(edits: &EditValues) -> bool {
    edits.exposure != 0 || edits.contrast != 0 || edits.warmth != 0 ||
    edits.shadows != 0 || edits.highlights != 0 || edits.saturation != 0
}

/// Apply color adjustments to image
fn apply_color_adjustments(img: DynamicImage, edits: &EditValues) -> DynamicImage {
    // Convert to RGBA for pixel manipulation
    let mut rgba = img.to_rgba8();
    
    // Precompute factors
    let exposure = edits.exposure as f32 / 100.0;
    let contrast = edits.contrast as f32 / 100.0;
    let warmth = edits.warmth as f32 / 100.0;
    let shadows = edits.shadows as f32 / 100.0;
    let highlights = edits.highlights as f32 / 100.0;
    let saturation = edits.saturation as f32 / 100.0;
    
    // Combined brightness factor
    let brightness = 1.0 + exposure + shadows * 0.22 + highlights * 0.1;
    let contrast_factor = 1.0 + contrast - shadows * 0.08 + highlights * 0.12;
    let saturation_factor = 1.0 + saturation;
    
    for pixel in rgba.pixels_mut() {
        let mut r = pixel[0] as f32 / 255.0;
        let mut g = pixel[1] as f32 / 255.0;
        let mut b = pixel[2] as f32 / 255.0;
        
        // Brightness
        r *= brightness;
        g *= brightness;
        b *= brightness;
        
        // Contrast (around 0.5 midpoint)
        r = (r - 0.5) * contrast_factor + 0.5;
        g = (g - 0.5) * contrast_factor + 0.5;
        b = (b - 0.5) * contrast_factor + 0.5;
        
        // Saturation
        let gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * saturation_factor;
        g = gray + (g - gray) * saturation_factor;
        b = gray + (b - gray) * saturation_factor;
        
        // Warmth
        if warmth > 0.0 {
            r += warmth * 0.3;
            b -= warmth * 0.3;
        } else if warmth < 0.0 {
            b += -warmth * 0.3;
            r -= -warmth * 0.3;
        }
        
        // Clamp and convert back
        pixel[0] = (r.clamp(0.0, 1.0) * 255.0).round() as u8;
        pixel[1] = (g.clamp(0.0, 1.0) * 255.0).round() as u8;
        pixel[2] = (b.clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    
    DynamicImage::ImageRgba8(rgba)
}

/// Read EXIF bytes from file for preservation
fn read_exif_bytes(path: &PathBuf) -> Option<Vec<u8>> {
    // For JPEG, read the APP1 segment (EXIF)
    if let Ok(mut file) = std::fs::File::open(path) {
        use std::io::Read;
        let mut buffer = Vec::new();
        if file.read_to_end(&mut buffer).is_ok() {
            // Look for EXIF marker (0xFFE1) in JPEG
            if buffer.len() > 4 && buffer[0] == 0xFF && buffer[1] == 0xD8 {
                // Simple JPEG EXIF extraction - find APP1 marker
                let mut i = 2;
                while i + 4 < buffer.len() {
                    if buffer[i] == 0xFF && buffer[i + 1] == 0xE1 {
                        let len = ((buffer[i + 2] as usize) << 8) | (buffer[i + 3] as usize);
                        if i + 2 + len <= buffer.len() {
                            // Check for "Exif\0\0" signature
                            if i + 8 < buffer.len() &&
                               buffer[i + 4] == b'E' && buffer[i + 5] == b'x' &&
                               buffer[i + 6] == b'i' && buffer[i + 7] == b'f' &&
                               buffer[i + 8] == 0 && buffer[i + 9] == 0 {
                                return Some(buffer[i..i + 2 + len].to_vec());
                            }
                        }
                        break;
                    }
                    i += 1;
                }
            }
        }
    }
    None
}

/// Write image with format-specific options, optionally preserving EXIF
fn write_image(
    img: &DynamicImage,
    path: &PathBuf,
    format: &str,
    quality: f32,
    strip_metadata: bool,
    exif_data: &Option<Vec<u8>>,
) -> Result<(), String> {
    let quality = (quality * 100.0).round().clamp(1.0, 100.0) as u8;
    
    match format {
        "image/png" => {
            let encoder = image::codecs::png::PngEncoder::new_with_quality(
                std::fs::File::create(path).map_err(|e| e.to_string())?,
                image::codecs::png::CompressionType::Default,
                image::codecs::png::FilterType::default(),
            );
            encoder.write_image(
                img.as_bytes(),
                img.width(),
                img.height(),
                img.color().into(),
            ).map_err(|e| e.to_string())?;
        }
        "image/webp" => {
            let encoder = image::codecs::webp::WebPEncoder::new_lossless(
                std::fs::File::create(path).map_err(|e| e.to_string())?
            );
            encoder.write_image(
                img.as_bytes(),
                img.width(),
                img.height(),
                img.color().into(),
            ).map_err(|e| e.to_string())?;
        }
        _ => { // JPEG default
            // For JPEG, we can preserve EXIF by injecting it
            let mut file = std::fs::File::create(path).map_err(|e| e.to_string())?;

            // JPEG only supports RGB; flatten any alpha channel.
            let rgb = img.to_rgb8();

            if !strip_metadata {
                if let Some(exif) = exif_data {
                    // Write JPEG with EXIF injection
                    write_jpeg_with_exif(&mut file, &rgb, quality, exif)?;
                } else {
                    // No EXIF to preserve, write normally
                    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, quality);
                    encoder.write_image(
                        rgb.as_raw(),
                        rgb.width(),
                        rgb.height(),
                        image::ExtendedColorType::Rgb8,
                    ).map_err(|e| e.to_string())?;
                }
            } else {
                // Strip metadata explicitly requested
                let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, quality);
                encoder.write_image(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    image::ExtendedColorType::Rgb8,
                ).map_err(|e| e.to_string())?;
            }
            file.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Write JPEG with EXIF injection
fn write_jpeg_with_exif(
    file: &mut std::fs::File,
    img: &image::RgbImage,
    quality: u8,
    exif: &[u8],
) -> Result<(), String> {
    use std::io::Write;
    
    // Encode to memory buffer first
    let mut buffer = Vec::new();
    {
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality);
        encoder.write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgb8,
        ).map_err(|e| e.to_string())?;
    }
    
    // Inject EXIF after SOI marker (0xFFD8)
    let mut output = Vec::new();
    
    // Write SOI
    output.extend_from_slice(&[0xFF, 0xD8]);
    
    // Skip any existing APP0 (JFIF) marker - check at buffer[2]
    if buffer.len() > 4 && buffer[2] == 0xFF && buffer[3] == 0xE0 {
        let len = ((buffer[4] as usize) << 8) | (buffer[5] as usize);
        output.extend_from_slice(&buffer[2..2 + 2 + len]);
    }
    
    // Inject our EXIF (APP1)
    output.extend_from_slice(&[0xFF, 0xE1]);
    let exif_len = exif.len() + 2;
    output.extend_from_slice(&[(exif_len >> 8) as u8, (exif_len & 0xFF) as u8]);
    output.extend_from_slice(exif);
    
    // Copy rest of buffer (skip SOI at buffer[0..2])
    output.extend_from_slice(&buffer[2..]);
    
    file.write_all(&output).map_err(|e| e.to_string())?;
    Ok(())
}

