//! Visual difference hashing (dHash) for near-duplicate and burst photo verification.
//!
//! dHash scales an image to a 9x8 grayscale grid and compares adjacent pixels
//! horizontally. This produces a 64-bit integer (`u64`) fingerprint that tracks
//! relative intensity gradients.
//!
//! Two visually identical or near-duplicate photos have Hamming distance <= 6.
//! Natural burst photos with slight camera or subject movement have Hamming distance <= 10.
//! Completely different photos (different scenes, subjects) have Hamming distance >= 20.

use image::imageops::FilterType;
use image::DynamicImage;
use std::path::Path;

/// Maximum Hamming distance out of 64 bits to qualify as a visual match.
/// Distance <= 10 corresponds to >= 84.4% visual structure match.
pub const BURST_MAX_HAMMING_DISTANCE: u32 = 10;

/// Strict match threshold for near-duplicate / recompressed / resized detection.
#[allow(dead_code)]
pub const NEAR_DUPLICATE_MAX_HAMMING_DISTANCE: u32 = 6;

/// Calculate Hamming distance (number of differing bits) between two 64-bit hashes.
#[inline]
pub fn hamming_distance(hash_a: u64, hash_b: u64) -> u32 {
    (hash_a ^ hash_b).count_ones()
}

/// Calculate dHash from an in-memory `DynamicImage`.
pub fn compute_dhash_from_image(img: &DynamicImage) -> u64 {
    // 9 columns by 8 rows allows 8 horizontal comparisons per row = 64 bits total.
    let small = img.resize_exact(9, 8, FilterType::Nearest).to_luma8();
    let mut hash = 0u64;

    for y in 0..8 {
        for x in 0..8 {
            let left = small.get_pixel(x, y)[0];
            let right = small.get_pixel(x + 1, y)[0];
            if left > right {
                hash |= 1u64 << (y * 8 + x);
            }
        }
    }

    hash
}

/// Calculate dHash from raw encoded image bytes (JPEG, PNG, WebP, GIF, TIFF).
#[allow(dead_code)]
pub fn compute_dhash_from_bytes(bytes: &[u8]) -> Option<u64> {
    let img = image::load_from_memory(bytes).ok()?;
    Some(compute_dhash_from_image(&img))
}

/// Calculate dHash from a file on disk.
///
/// Tries decoding via `image` crate first. On macOS, if `image` cannot decode
/// (e.g., HEIC or Camera RAW), falls back to `sips` downsampled rendering.
pub fn compute_dhash_from_path(path: &Path) -> Option<u64> {
    if let Ok(img) = image::open(path) {
        return Some(compute_dhash_from_image(&img));
    }

    #[cfg(target_os = "macos")]
    {
        decode_with_sips(path)
    }

    #[cfg(not(target_os = "macos"))]
    None
}

#[cfg(target_os = "macos")]
fn decode_with_sips(path: &Path) -> Option<u64> {
    use std::process::Command;

    let path_str = path.to_str()?;
    let scratch_dir = std::env::temp_dir().join("visto-dhash-temp");
    let _ = std::fs::create_dir_all(&scratch_dir);
    let temp_jpg = scratch_dir.join(format!("{}.jpg", uuid::Uuid::new_v4()));

    // Use sips to produce a tiny 32x32 JPEG
    let status = Command::new("sips")
        .arg("-s")
        .arg("format")
        .arg("jpeg")
        .arg("-z")
        .arg("32")
        .arg("32")
        .arg(path_str)
        .arg("--out")
        .arg(&temp_jpg)
        .output()
        .ok()?;

    if !status.status.success() {
        let _ = std::fs::remove_file(&temp_jpg);
        return None;
    }

    let result = image::open(&temp_jpg)
        .ok()
        .map(|img| compute_dhash_from_image(&img));
    let _ = std::fs::remove_file(&temp_jpg);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_path(name: &str) -> PathBuf {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        // manifest_dir is src-tauri, test-media is at root
        manifest_dir.parent().unwrap().join("test-media").join(name)
    }

    #[test]
    fn test_hamming_distance_identity_and_inversion() {
        assert_eq!(hamming_distance(0, 0), 0);
        assert_eq!(hamming_distance(0xFFFFFFFFFFFFFFFF, 0xFFFFFFFFFFFFFFFF), 0);
        assert_eq!(hamming_distance(0, 0xFFFFFFFFFFFFFFFF), 64);
        assert_eq!(hamming_distance(0b0101, 0b1100), 2);
    }

    #[test]
    fn test_same_content_different_formats_have_zero_distance() {
        let jpg_path = fixture_path("still-photo.jpg");
        let png_path = fixture_path("still-image.png");

        if jpg_path.exists() && png_path.exists() {
            let hash_jpg = compute_dhash_from_path(&jpg_path).expect("hash jpg");
            let hash_png = compute_dhash_from_path(&png_path).expect("hash png");

            let dist = hamming_distance(hash_jpg, hash_png);
            assert!(
                dist <= NEAR_DUPLICATE_MAX_HAMMING_DISTANCE,
                "Distance between same visual image in JPG and PNG was {dist}, expected <= {NEAR_DUPLICATE_MAX_HAMMING_DISTANCE}"
            );
        }
    }

    #[test]
    fn test_different_photos_have_large_distance() {
        let photo1 = fixture_path("still-photo.jpg");
        let photo2 = fixture_path("still-photo-2.jpeg");

        if photo1.exists() && photo2.exists() {
            let hash1 = compute_dhash_from_path(&photo1).expect("hash photo 1");
            let hash2 = compute_dhash_from_path(&photo2).expect("hash photo 2");

            let dist = hamming_distance(hash1, hash2);
            assert!(
                dist >= 20,
                "Distance between completely different photos was {dist}, expected >= 20"
            );
        }
    }
}
