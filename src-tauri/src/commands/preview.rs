//! Display-size and full-size previews for the photo viewer.
//!
//! The web view cannot decode RAW files (or a few other still formats), so the
//! viewer used to show the 1024 px grid thumbnail, which zooming and Actual
//! Size only enlarged. macOS ImageIO (through `sips`) decodes RAW at full
//! resolution, so the backend renders a JPEG the viewer can show sharply:
//! [`DISPLAY_EDGE`] for fitting the screen, and the full size when the user
//! zooms past that.
//!
//! Previews are cached under `previews/` like thumbnails, named by item so
//! hiding an item removes them. A hidden item's preview is never cached: it
//! comes back inline instead.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use ts_rs::TS;
use uuid::Uuid;

use crate::errors::CommandError;

/// Long edge of the screen-size preview: sharp on a 5K display at fit.
pub(crate) const DISPLAY_EDGE: u32 = 3072;
const PREVIEW_QUALITY: u8 = 88;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DisplayPreview {
    /// Cached file to load through the asset protocol.
    pub path: Option<String>,
    /// Inline JPEG for a hidden item, whose preview is never cached.
    pub data_url: Option<String>,
    pub width: u32,
    pub height: u32,
    /// The preview is the full decoded size of the original.
    pub full: bool,
}

/// The long edge to render, or 0 for the full size. A photo whose own long
/// edge fits the display preview is rendered at full size straight away.
pub(crate) fn preview_edge(full: bool, width: Option<i64>, height: Option<i64>) -> u32 {
    if full {
        return 0;
    }
    match (width, height) {
        (Some(w), Some(h)) if w > 0 && h > 0 && w.max(h) <= i64::from(DISPLAY_EDGE) => 0,
        _ => DISPLAY_EDGE,
    }
}

pub(crate) fn preview_cache_key(item_id: &str, modified_at: i64, size: i64, edge: u32) -> String {
    format!("preview-v1:{item_id}:{modified_at}:{size}:{edge}:q{PREVIEW_QUALITY}")
}

#[tauri::command]
pub async fn get_display_preview(
    item_id: String,
    full: Option<bool>,
    app: AppHandle,
    catalog: State<'_, crate::Catalog>,
) -> Result<DisplayPreview, CommandError> {
    let db = super::get_db(&catalog)?;
    type Row = (String, String, i64, i64, i64, Option<i64>, Option<i64>);
    let (path, kind, modified_at, size, hidden, width, height): Row = sqlx::query_as(
        "SELECT path, kind, modified_at, size, hidden, width, height FROM media_items WHERE id = ?",
    )
    .bind(&item_id)
    .fetch_optional(&db)
    .await?
    .ok_or_else(|| CommandError::not_found("Item not found in library"))?;
    if kind != "photo" && kind != "raw" {
        return Err(CommandError::invalid("Only photos have viewer previews."));
    }
    let edge = preview_edge(full.unwrap_or(false), width, height);
    let is_full = edge == 0;

    if hidden != 0 {
        let rendered = tokio::task::spawn_blocking(move || render_inline(&path, &kind, edge))
            .await
            .map_err(|error| CommandError::internal(format!("Preview worker failed: {error}")))??;
        let (bytes, width, height) = rendered;
        return Ok(DisplayPreview {
            path: None,
            data_url: Some(format!("data:image/jpeg;base64,{}", BASE64.encode(bytes))),
            width,
            height,
            full: is_full,
        });
    }

    let cache_root = app
        .path()
        .app_cache_dir()?
        .join(super::storage::PREVIEWS_DIR);
    tokio::fs::create_dir_all(&cache_root).await?;
    let key = preview_cache_key(&item_id, modified_at, size, edge);
    let digest = ring::digest::digest(&ring::digest::SHA256, key.as_bytes());
    let target = cache_root.join(super::storage::thumbnail_file_name(
        &item_id,
        &hex::encode(digest.as_ref()),
    ));

    let budget = super::settings::load_persisted_settings(&db)
        .await
        .map(|settings| settings.max_cache_size_gb.max(1) as u64 * 1024 * 1024 * 1024)
        .unwrap_or(4 * 1024 * 1024 * 1024);
    let cached_target = target.clone();
    let (width, height) = tokio::task::spawn_blocking(move || {
        if let Ok(dimensions) = image::image_dimensions(&cached_target) {
            super::storage::touch_if_stale(&cached_target);
            return Ok(dimensions);
        }
        let (_, width, height) = render(&path, &kind, &cached_target, edge)?;
        super::library::prune_thumbnail_cache(&cache_root, budget);
        Ok::<_, CommandError>((width, height))
    })
    .await
    .map_err(|error| CommandError::internal(format!("Preview worker failed: {error}")))??;

    Ok(DisplayPreview {
        path: Some(target.to_string_lossy().into_owned()),
        data_url: None,
        width,
        height,
        full: is_full,
    })
}

fn render(
    source: &str,
    kind: &str,
    target: &Path,
    edge: u32,
) -> Result<(Vec<u8>, u32, u32), CommandError> {
    if kind == "raw" && edge > 0 {
        if let Some(result) = crate::media_raw_preview::render_embedded_raw_preview(
            Path::new(source),
            target,
            edge,
            PREVIEW_QUALITY,
        ) {
            return Ok(result);
        }
    }
    #[cfg(target_os = "macos")]
    {
        super::library::generate_with_macos_sips(
            source,
            target,
            edge,
            PREVIEW_QUALITY,
            "viewer preview via macOS ImageIO",
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source, target, edge);
        Err(CommandError::internal(
            "Viewer previews need macOS ImageIO.",
        ))
    }
}

/// A hidden item's preview: rendered in a private temp folder and deleted as
/// soon as it is read, so it never stays on disk.
fn render_inline(source: &str, kind: &str, edge: u32) -> Result<(Vec<u8>, u32, u32), CommandError> {
    let scratch = std::env::temp_dir().join("visto-uncached-thumbnails");
    std::fs::create_dir_all(&scratch)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&scratch, std::fs::Permissions::from_mode(0o700));
    }
    let target = scratch.join(format!("{}.jpg", Uuid::new_v4()));
    let result = render(source, kind, &target, edge);
    let _ = std::fs::remove_file(&target);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_photos_render_at_full_size_and_large_ones_at_the_display_edge() {
        assert_eq!(preview_edge(false, Some(2000), Some(1500)), 0);
        assert_eq!(preview_edge(false, Some(6000), Some(4000)), DISPLAY_EDGE);
        assert_eq!(preview_edge(false, None, None), DISPLAY_EDGE);
        assert_eq!(preview_edge(true, Some(6000), Some(4000)), 0);
    }

    #[test]
    fn each_size_of_a_version_has_its_own_cache_key() {
        let display = preview_cache_key("a", 1, 2, DISPLAY_EDGE);
        let full = preview_cache_key("a", 1, 2, 0);
        let edited = preview_cache_key("a", 9, 2, DISPLAY_EDGE);
        assert_ne!(display, full);
        assert_ne!(display, edited);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn renders_a_display_preview_and_the_full_size() {
        let dir = std::env::temp_dir().join(format!("visto-preview-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("wide.png");
        image::RgbImage::from_pixel(4000, 1000, image::Rgb([200, 120, 40]))
            .save(&source)
            .unwrap();

        let display = dir.join("display.jpg");
        let (_, w, h) = render(source.to_str().unwrap(), "photo", &display, DISPLAY_EDGE).unwrap();
        assert_eq!((w, h), (DISPLAY_EDGE, 768));

        let full = dir.join("full.jpg");
        let (_, w, h) = render(source.to_str().unwrap(), "photo", &full, 0).unwrap();
        assert_eq!((w, h), (4000, 1000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn renders_raw_from_embedded_jpeg_preview() {
        let dir = std::env::temp_dir().join(format!("visto-raw-render-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let img = image::RgbImage::from_pixel(640, 480, image::Rgb([10, 90, 180]));
        let mut jpg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 85)
            .encode(&img, 640, 480, image::ExtendedColorType::Rgb8)
            .unwrap();

        // Synthetic TIFF-RAW with an embedded JPEG in IFD0 (sips cannot decode
        // a bare synthetic TIFF-RAW without sensor data, so success proves the
        // embedded-JPEG path ran).
        let ifd0_off = 8u32;
        let jpg_off = 8u32 + 2 + 24 + 4;
        let mut raw = vec![0u8; jpg_off as usize + jpg.len()];
        raw[0..4].copy_from_slice(b"II*\0");
        raw[4..8].copy_from_slice(&ifd0_off.to_le_bytes());
        let mut p = ifd0_off as usize;
        raw[p..p + 2].copy_from_slice(&2u16.to_le_bytes());
        p += 2;
        raw[p..p + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        raw[p + 2..p + 4].copy_from_slice(&4u16.to_le_bytes());
        raw[p + 4..p + 8].copy_from_slice(&1u32.to_le_bytes());
        raw[p + 8..p + 12].copy_from_slice(&jpg_off.to_le_bytes());
        p += 12;
        raw[p..p + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        raw[p + 2..p + 4].copy_from_slice(&4u16.to_le_bytes());
        raw[p + 4..p + 8].copy_from_slice(&1u32.to_le_bytes());
        raw[p + 8..p + 12].copy_from_slice(&(jpg.len() as u32).to_le_bytes());
        raw[jpg_off as usize..].copy_from_slice(&jpg);

        let source = dir.join("sample.cr2");
        std::fs::write(&source, raw).unwrap();
        let dest = dir.join("preview.jpg");
        let (_, w, h) = render(source.to_str().unwrap(), "raw", &dest, 320).unwrap();
        assert_eq!((w, h), (320, 240));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
