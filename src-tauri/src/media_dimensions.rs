//! Pixel dimensions for every media kind the catalog stores.
//!
//! The `image` crate reads JPEG/PNG/WebP/GIF/BMP/TIFF headers but not HEIC or
//! AVIF, and knows nothing about video. This module adds header-only readers
//! for the ISO base media file format (ISOBMFF), which covers both HEIF images
//! (`.heic`, `.heif`, `.avif`: the `ispe` property) and QuickTime/MP4 video
//! (`.mp4`, `.mov`, `.m4v`, `.3gp`, `.3g2`: the video track's `tkhd`). On macOS,
//! anything still unknown falls back to ImageIO through `sips`, which handles
//! RAW formats and the odd JPEG the `image` crate rejects.
//!
//! Dimensions are reported as displayed: a 90° or 270° rotation (`irot` for
//! HEIF, the track matrix for video) swaps width and height.

use crate::media_kind::MediaKind;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Largest `moov`/`meta` box read into memory. Real headers are far smaller;
/// the cap keeps a corrupt size field from allocating gigabytes.
const MAX_HEADER_BOX: u64 = 64 * 1024 * 1024;

const ISOBMFF_IMAGE_EXTS: &[&str] = &["heic", "heif", "avif"];
const ISOBMFF_VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "3gp", "3g2"];

/// Best-effort dimensions for `path`, trying the cheapest source first:
/// image header, ISOBMFF header, the caller's EXIF dimensions, then `sips`.
/// `kind` is the catalog kind (`photo`, `raw` or `video`).
pub fn probe_dimensions(
    path: &Path,
    ext: &str,
    kind: MediaKind,
    exif: Option<(u32, u32)>,
) -> Option<(u32, u32)> {
    let ext = ext.to_ascii_lowercase();
    let valid = |d: (u32, u32)| (d.0 > 0 && d.1 > 0).then_some(d);

    if kind == MediaKind::Photo && !ISOBMFF_IMAGE_EXTS.contains(&ext.as_str()) {
        if let Some(d) = image::image_dimensions(path).ok().and_then(valid) {
            return Some(d);
        }
    }
    if ISOBMFF_IMAGE_EXTS.contains(&ext.as_str()) {
        if let Some(d) = read_box_file(path, b"meta").and_then(|m| heif_dimensions(&m)) {
            return Some(d);
        }
    }
    if ISOBMFF_VIDEO_EXTS.contains(&ext.as_str()) {
        if let Some(d) = read_box_file(path, b"moov").and_then(|m| movie_dimensions(&m)) {
            return Some(d);
        }
    }
    if let Some(d) = exif.and_then(valid) {
        return Some(d);
    }
    if kind == MediaKind::Photo || kind == MediaKind::Raw {
        return sips_dimensions(path).and_then(valid);
    }
    None
}

/// One ISOBMFF box inside a byte slice: its type and its payload.
struct BoxRef<'a> {
    kind: [u8; 4],
    body: &'a [u8],
}

/// Iterate the boxes laid end to end in `data`. Stops at the first malformed
/// header instead of guessing.
fn boxes(mut data: &[u8]) -> impl Iterator<Item = BoxRef<'_>> {
    std::iter::from_fn(move || {
        if data.len() < 8 {
            return None;
        }
        let size32 = u32::from_be_bytes(data[0..4].try_into().ok()?) as u64;
        let kind: [u8; 4] = data[4..8].try_into().ok()?;
        let (header, size) = match size32 {
            0 => (8, data.len() as u64),
            1 => {
                if data.len() < 16 {
                    return None;
                }
                (16, u64::from_be_bytes(data[8..16].try_into().ok()?))
            }
            n => (8, n),
        };
        if size < header as u64 || size > data.len() as u64 {
            return None;
        }
        let body = &data[header..size as usize];
        data = &data[size as usize..];
        Some(BoxRef { kind, body })
    })
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data).find(|b| &b.kind == kind).map(|b| b.body)
}

fn be_u32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

/// Read the payload of the first top-level box of type `kind` in the file,
/// seeking over everything else (an `mdat` can be gigabytes).
fn read_box_file(path: &Path, kind: &[u8; 4]) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let mut offset = 0u64;
    while offset + 8 <= file_len {
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut header = [0u8; 16];
        file.read_exact(&mut header[..8]).ok()?;
        let size32 = u32::from_be_bytes(header[0..4].try_into().ok()?) as u64;
        let (header_len, size) = match size32 {
            0 => (8, file_len - offset),
            1 => {
                file.read_exact(&mut header[8..16]).ok()?;
                (16, u64::from_be_bytes(header[8..16].try_into().ok()?))
            }
            n => (8, n),
        };
        if size < header_len || offset + size > file_len {
            return None;
        }
        if &header[4..8] == kind {
            let body_len = size - header_len;
            if body_len > MAX_HEADER_BOX {
                return None;
            }
            let mut body = vec![0u8; body_len as usize];
            file.read_exact(&mut body).ok()?;
            return Some(body);
        }
        offset += size;
    }
    None
}

/// HEIF/AVIF: the largest `ispe` (image spatial extents) property is the
/// full-size primary image (grid tiles and thumbnails are smaller). `meta` is
/// a full box, so its children start after 4 bytes of version and flags.
fn heif_dimensions(meta: &[u8]) -> Option<(u32, u32)> {
    let ipco = child(child(meta.get(4..)?, b"iprp")?, b"ipco")?;
    let mut best: Option<(u32, u32)> = None;
    let mut quarter_turn = false;
    for prop in boxes(ipco) {
        match &prop.kind {
            b"ispe" => {
                let w = be_u32(prop.body, 4)?;
                let h = be_u32(prop.body, 8)?;
                if best.is_none_or(|(bw, bh)| (w as u64 * h as u64) > (bw as u64 * bh as u64)) {
                    best = Some((w, h));
                }
            }
            b"irot" => {
                quarter_turn = prop.body.first().is_some_and(|angle| angle & 1 == 1);
            }
            _ => {}
        }
    }
    best.map(|(w, h)| if quarter_turn { (h, w) } else { (w, h) })
}

/// QuickTime/MP4: the largest track with non-zero `tkhd` dimensions is the
/// video track (audio tracks report 0 × 0).
fn movie_dimensions(moov: &[u8]) -> Option<(u32, u32)> {
    boxes(moov)
        .filter(|b| &b.kind == b"trak")
        .filter_map(|trak| child(trak.body, b"tkhd").and_then(track_dimensions))
        .filter(|&(w, h)| w > 0 && h > 0)
        .max_by_key(|&(w, h)| w as u64 * h as u64)
}

/// Parse a `tkhd` payload (version 0 or 1) into displayed dimensions.
fn track_dimensions(tkhd: &[u8]) -> Option<(u32, u32)> {
    let version = *tkhd.first()?;
    // version/flags (4) + times, track id, reserved, duration.
    let after_duration = if version == 1 {
        4 + 8 + 8 + 4 + 4 + 8
    } else {
        4 + 4 + 4 + 4 + 4 + 4
    };
    // reserved (8), layer (2), alternate group (2), volume (2), reserved (2).
    let matrix = after_duration + 16;
    let a = be_u32(tkhd, matrix)? as i32;
    let d = be_u32(tkhd, matrix + 16)? as i32;
    let size_at = matrix + 36;
    let w = be_u32(tkhd, size_at)? >> 16;
    let h = be_u32(tkhd, size_at + 4)? >> 16;
    // A 90° or 270° rotation zeroes the matrix diagonal.
    Some(if a == 0 && d == 0 { (h, w) } else { (w, h) })
}

#[cfg(target_os = "macos")]
fn sips_dimensions(path: &Path) -> Option<(u32, u32)> {
    let output = std::process::Command::new("/usr/bin/sips")
        .args(["-g", "pixelWidth", "-g", "pixelHeight"])
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_sips_dimensions(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "macos"))]
fn sips_dimensions(_path: &Path) -> Option<(u32, u32)> {
    None
}

fn parse_sips_dimensions(stdout: &str) -> Option<(u32, u32)> {
    let value = |key: &str| {
        stdout.lines().find_map(|line| {
            let (k, v) = line.trim().split_once(':')?;
            (k.trim() == key)
                .then(|| v.trim().parse::<u32>().ok())
                .flatten()
        })
    };
    Some((value("pixelWidth")?, value("pixelHeight")?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    fn full(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut payload = vec![0, 0, 0, 0];
        payload.extend_from_slice(body);
        bx(kind, &payload)
    }

    fn ispe(w: u32, h: u32) -> Vec<u8> {
        let mut body = w.to_be_bytes().to_vec();
        body.extend_from_slice(&h.to_be_bytes());
        full(b"ispe", &body)
    }

    fn heif_file(props: &[Vec<u8>]) -> Vec<u8> {
        let ipco = bx(b"ipco", &props.concat());
        let iprp = bx(b"iprp", &ipco);
        let mut file = bx(b"ftyp", b"heicmif1");
        file.extend(full(b"meta", &[bx(b"hdlr", b"pict"), iprp].concat()));
        file
    }

    fn tkhd_v0(w: u32, h: u32, rotated: bool) -> Vec<u8> {
        let mut body = vec![0u8; 20]; // times, track id, reserved, duration
        body.extend_from_slice(&[0u8; 16]); // reserved, layer, group, volume, reserved
        let one = 0x0001_0000u32.to_be_bytes();
        let neg = (-0x0001_0000i32 as u32).to_be_bytes();
        let zero = [0u8; 4];
        let matrix: [[u8; 4]; 9] = if rotated {
            [
                zero,
                one,
                zero,
                neg,
                zero,
                zero,
                zero,
                zero,
                0x4000_0000u32.to_be_bytes(),
            ]
        } else {
            [
                one,
                zero,
                zero,
                zero,
                one,
                zero,
                zero,
                zero,
                0x4000_0000u32.to_be_bytes(),
            ]
        };
        body.extend(matrix.concat());
        body.extend_from_slice(&(w << 16).to_be_bytes());
        body.extend_from_slice(&(h << 16).to_be_bytes());
        full(b"tkhd", &body)
    }

    fn movie_file(tracks: &[Vec<u8>], moov_last: bool) -> Vec<u8> {
        let traks: Vec<u8> = tracks.iter().flat_map(|t| bx(b"trak", t)).collect();
        let moov = bx(b"moov", &traks);
        let mdat = bx(b"mdat", &[0u8; 64]);
        let mut file = bx(b"ftyp", b"isom");
        if moov_last {
            file.extend(mdat);
            file.extend(moov);
        } else {
            file.extend(moov);
            file.extend(mdat);
        }
        file
    }

    fn write_temp(ext: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("visto-dims-{}.{ext}", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn heif_uses_largest_ispe() {
        let file = write_temp("heic", &heif_file(&[ispe(512, 512), ispe(4032, 3024)]));
        assert_eq!(
            probe_dimensions(&file, "heic", MediaKind::Photo, None),
            Some((4032, 3024))
        );
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn heif_irot_quarter_turn_swaps() {
        let file = write_temp("avif", &heif_file(&[ispe(4032, 3024), bx(b"irot", &[1])]));
        assert_eq!(
            probe_dimensions(&file, "avif", MediaKind::Photo, None),
            Some((3024, 4032))
        );
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn mp4_reads_video_track_and_skips_audio() {
        let file = write_temp(
            "mp4",
            &movie_file(&[tkhd_v0(0, 0, false), tkhd_v0(1920, 1080, false)], true),
        );
        assert_eq!(
            probe_dimensions(&file, "mp4", MediaKind::Video, None),
            Some((1920, 1080))
        );
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn rotated_video_reports_display_size() {
        let file = write_temp("mov", &movie_file(&[tkhd_v0(1920, 1080, true)], false));
        assert_eq!(
            probe_dimensions(&file, "mov", MediaKind::Video, None),
            Some((1080, 1920))
        );
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn exif_dimensions_fill_in_when_header_fails() {
        let file = write_temp("jpg", b"not a real jpeg");
        assert_eq!(
            probe_dimensions(&file, "jpg", MediaKind::Photo, Some((800, 600))),
            Some((800, 600))
        );
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn truncated_or_garbage_files_give_none() {
        let file = write_temp("mkv", b"\x1aE\xdf\xa3garbage");
        assert_eq!(probe_dimensions(&file, "mkv", MediaKind::Video, None), None);
        let mut broken = movie_file(&[tkhd_v0(1920, 1080, false)], false);
        broken.truncate(30);
        let file2 = write_temp("mp4", &broken);
        assert_eq!(
            probe_dimensions(&file2, "mp4", MediaKind::Video, None),
            None
        );
        let _ = std::fs::remove_file(file);
        let _ = std::fs::remove_file(file2);
    }

    #[test]
    fn parses_sips_output() {
        let out = "/x/a.cr2\n  pixelWidth: 6000\n  pixelHeight: 4000\n";
        assert_eq!(parse_sips_dimensions(out), Some((6000, 4000)));
        assert_eq!(parse_sips_dimensions("<nil>"), None);
    }
}
