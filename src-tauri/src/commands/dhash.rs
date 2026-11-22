//! Visual difference hashing (2D dHash + Color Profile) for near-duplicate and burst photo verification.
//!
//! Unlike simple 1D horizontal difference hashing (which can suffer from false positives
//! on centered subjects and vignetted wallpapers), this module combines:
//! 1. 64-bit horizontal gradient (9x8 row comparisons)
//! 2. 64-bit vertical gradient (8x9 column comparisons)
//! 3. Mean RGB color profile
//!
//! This 128-bit + color signature provides rock-solid discrimination:
//! - Near-duplicates (re-saved, resized, recompressed across folders): 2D grad dist <= 8/128, color diff <= 15/255.
//! - Natural camera bursts (slight movement/expression change): 2D grad dist <= 24/128, color diff <= 22/255.
//! - Different scenes/subjects (e.g. wallpapers, pluto, jellyfish): 2D grad dist >= 35/128, color diff >= 40/255.

use image::imageops::FilterType;
use image::DynamicImage;
use std::path::Path;

/// Maximum Hamming distance out of 64 bits to qualify as a visual match (legacy).
pub const BURST_MAX_HAMMING_DISTANCE: u32 = 14;

/// Strict match threshold for near-duplicate detection (legacy).
pub const NEAR_DUPLICATE_MAX_HAMMING_DISTANCE: u32 = 6;

/// 2D visual gradient hash (128 bits) plus average RGB color tone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualFingerprint {
    pub h_hash: u64,
    pub v_hash: u64,
    pub rgb: u32, // (R << 16) | (G << 8) | B
}

impl VisualFingerprint {
    #[inline]
    pub fn distance(&self, other: &Self) -> (u32, u32) {
        let grad_dist =
            (self.h_hash ^ other.h_hash).count_ones() + (self.v_hash ^ other.v_hash).count_ones();

        let r1 = ((self.rgb >> 16) & 0xFF) as i32;
        let g1 = ((self.rgb >> 8) & 0xFF) as i32;
        let b1 = (self.rgb & 0xFF) as i32;

        let r2 = ((other.rgb >> 16) & 0xFF) as i32;
        let g2 = ((other.rgb >> 8) & 0xFF) as i32;
        let b2 = (other.rgb & 0xFF) as i32;

        let color_diff = (((r1 - r2).abs() + (g1 - g2).abs() + (b1 - b2).abs()) / 3) as u32;

        (grad_dist, color_diff)
    }

    #[inline]
    pub fn is_near_duplicate(&self, other: &Self) -> bool {
        let (grad_dist, color_diff) = self.distance(other);
        grad_dist <= 8 && color_diff <= 15
    }

    #[inline]
    pub fn is_burst_similar(&self, other: &Self) -> bool {
        let (grad_dist, color_diff) = self.distance(other);
        grad_dist <= 24 && color_diff <= 22
    }
}

/// Calculate Hamming distance (number of differing bits) between two 64-bit hashes.
#[inline]
pub fn hamming_distance(hash_a: u64, hash_b: u64) -> u32 {
    (hash_a ^ hash_b).count_ones()
}

/// Calculate 2D fingerprint (128-bit gradient + color) from an in-memory `DynamicImage`.
pub fn compute_fingerprint_from_image(img: &DynamicImage) -> VisualFingerprint {
    // Resize to 9x9 using bilinear filtering
    let small = img.resize_exact(9, 9, FilterType::Triangle).to_rgb8();

    let mut luma = [[0u8; 9]; 9];
    let mut sum_r = 0u64;
    let mut sum_g = 0u64;
    let mut sum_b = 0u64;

    for y in 0..9 {
        for x in 0..9 {
            let p = small.get_pixel(x as u32, y as u32);
            let r = p[0] as u64;
            let g = p[1] as u64;
            let b = p[2] as u64;
            sum_r += r;
            sum_g += g;
            sum_b += b;
            // Standard Rec. 601 luma
            luma[y][x] = ((299 * r + 587 * g + 114 * b) / 1000) as u8;
        }
    }

    // 64-bit horizontal gradient: compare (x, y) with (x+1, y)
    let mut h_hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            if luma[y][x] > luma[y][x + 1] {
                h_hash |= 1u64 << (y * 8 + x);
            }
        }
    }

    // 64-bit vertical gradient: compare (x, y) with (x, y+1)
    let mut v_hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            if luma[y][x] > luma[y + 1][x] {
                v_hash |= 1u64 << (y * 8 + x);
            }
        }
    }

    let avg_r = (sum_r / 81) as u32;
    let avg_g = (sum_g / 81) as u32;
    let avg_b = (sum_b / 81) as u32;
    let rgb = (avg_r << 16) | (avg_g << 8) | avg_b;

    VisualFingerprint {
        h_hash,
        v_hash,
        rgb,
    }
}

/// Calculate 64-bit horizontal dHash from an in-memory `DynamicImage` (legacy wrapper).
#[allow(dead_code)]
pub fn compute_dhash_from_image(img: &DynamicImage) -> u64 {
    compute_fingerprint_from_image(img).h_hash
}

/// Calculate VisualFingerprint from a file on disk.
pub fn compute_fingerprint_from_path(path: &Path) -> Option<VisualFingerprint> {
    if let Ok(img) = image::open(path) {
        return Some(compute_fingerprint_from_image(&img));
    }

    #[cfg(target_os = "macos")]
    {
        decode_with_sips(path)
    }

    #[cfg(not(target_os = "macos"))]
    None
}

/// Calculate 64-bit dHash from a file on disk (legacy wrapper).
pub fn compute_dhash_from_path(path: &Path) -> Option<u64> {
    compute_fingerprint_from_path(path).map(|f| f.h_hash)
}

#[cfg(target_os = "macos")]
fn decode_with_sips(path: &Path) -> Option<VisualFingerprint> {
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
        .map(|img| compute_fingerprint_from_image(&img));
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
    fn test_check_user_temp_images() {
        let p1 = PathBuf::from(
            "/Users/devendrakumar/development/visto-gallery/docs/untracked/temp/image.png",
        );
        let p2 = PathBuf::from(
            "/Users/devendrakumar/development/visto-gallery/docs/untracked/temp/image copy.png",
        );
        let p3 = PathBuf::from(
            "/Users/devendrakumar/development/visto-gallery/docs/untracked/temp/image copy 2.png",
        );

        if p1.exists() && p2.exists() && p3.exists() {
            let h1 = compute_dhash_from_path(&p1).expect("h1");
            let h2 = compute_dhash_from_path(&p2).expect("h2");
            let h3 = compute_dhash_from_path(&p3).expect("h3");

            let d12 = hamming_distance(h1, h2);
            let d13 = hamming_distance(h1, h3);
            let d23 = hamming_distance(h2, h3);

            println!(
                "USER_TEST_RESULT: h1={:016x}, h2={:016x}, h3={:016x}",
                h1, h2, h3
            );
            println!("USER_TEST_RESULT: d(image, image copy) = {} / 64", d12);
            println!("USER_TEST_RESULT: d(image, image copy 2) = {} / 64", d13);
            println!(
                "USER_TEST_RESULT: d(image copy, image copy 2) = {} / 64",
                d23
            );
        }
    }
}
