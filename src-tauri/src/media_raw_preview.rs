//! Fast embedded JPEG preview extraction for camera RAW files.
//!
//! Almost every camera RAW container (TIFF/IFD-based DNG, CR2, NEF, ARW, ORF,
//! PEF, RW2, SRW; ISO-BMFF CR3; Fujifilm RAF) embeds a JPEG preview so viewers
//! and galleries do not have to demosaic the full sensor data for thumbnails or
//! screen-fit previews. When a suitable embedded JPEG is missing or smaller than
//! the requested edge, callers fall back to macOS ImageIO (`sips`).

use std::collections::{HashSet, VecDeque};
use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder};
use uuid::Uuid;

/// Maximum embedded JPEG size we will read into memory (32 MiB).
const MAX_EMBEDDED_JPEG_BYTES: u64 = 32 * 1024 * 1024;
/// Minimum size to consider a candidate a real preview rather than noise.
const MIN_EMBEDDED_JPEG_BYTES: u64 = 1024;
/// Cap ISOBMFF `moov` read size so corrupt headers cannot OOM.
const MAX_CR3_MOOV_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IFDS_VISITED: usize = 32;
const MAX_IFD_ENTRIES: usize = 512;

/// Extracted embedded JPEG bytes and the parent RAW container's IFD0 orientation.
pub struct EmbeddedRawPreview {
    pub jpeg: Vec<u8>,
    pub container_orientation: Option<u16>,
}

/// Extract the largest valid embedded JPEG from `path`, if one exists.
pub fn extract_embedded_jpeg(path: &Path) -> Option<EmbeddedRawPreview> {
    let mut file = File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    if file_len < 16 {
        return None;
    }

    let mut head = [0u8; 16];
    file.read_exact(&mut head).ok()?;

    if &head == b"FUJIFILMCCD-RAW " {
        return extract_raf(&mut file, file_len);
    }
    if &head[4..8] == b"ftyp" {
        return extract_cr3(&mut file, file_len);
    }

    let le = match &head[0..4] {
        b"II*\0" | b"IIRO" | b"IIU\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    extract_tiff(&mut file, file_len, le, &head)
}

/// Extract, orient, resize to `max_edge`, and write a cached JPEG to `destination`.
/// Returns `None` if no embedded JPEG exists or its long edge is smaller than
/// `max_edge` (so the caller can fall back to full RAW decoding via `sips`).
pub fn render_embedded_raw_preview(
    source: &Path,
    destination: &Path,
    max_edge: u32,
    quality: u8,
) -> Option<(Vec<u8>, u32, u32)> {
    let preview = extract_embedded_jpeg(source)?;
    if max_edge > 0 {
        let (w, h) = image::ImageReader::new(Cursor::new(&preview.jpeg))
            .with_guessed_format()
            .ok()?
            .into_dimensions()
            .ok()?;
        if w.max(h) < max_edge {
            return None;
        }
    }
    let reader = image::ImageReader::new(Cursor::new(&preview.jpeg))
        .with_guessed_format()
        .ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let _ = decoder.set_limits(image::Limits::default());
    let mut orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    if orientation == Orientation::NoTransforms {
        if let Some(raw_ori) = preview
            .container_orientation
            .and_then(|o| u8::try_from(o).ok())
            .and_then(Orientation::from_exif)
        {
            orientation = raw_ori;
        }
    }

    let mut img = DynamicImage::from_decoder(decoder).ok()?;
    img.apply_orientation(orientation);

    let resized = if max_edge > 0 {
        img.thumbnail(max_edge, max_edge).to_rgb8()
    } else {
        img.to_rgb8()
    };
    let (width, height) = (resized.width(), resized.height());
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode(&resized, width, height, image::ExtendedColorType::Rgb8)
        .ok()?;

    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, &bytes).ok()?;
    match std::fs::rename(&temporary, destination) {
        Ok(()) => {}
        Err(_) if destination.exists() => {
            let _ = std::fs::remove_file(&temporary);
        }
        Err(_) => {
            let _ = std::fs::remove_file(&temporary);
            return None;
        }
    }
    Some((bytes, width, height))
}

fn read_u16(bytes: &[u8], le: bool) -> u16 {
    if le {
        u16::from_le_bytes([bytes[0], bytes[1]])
    } else {
        u16::from_be_bytes([bytes[0], bytes[1]])
    }
}

fn read_u32(bytes: &[u8], le: bool) -> u32 {
    if le {
        u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
    } else {
        u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
    }
}

fn read_u32_vec(file: &mut File, offset: u64, count: usize, le: bool) -> Option<Vec<u32>> {
    let byte_len = count.checked_mul(4)?;
    if byte_len > 4096 {
        return None;
    }
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; byte_len];
    file.read_exact(&mut buf).ok()?;
    Some(
        buf.as_chunks::<4>()
            .0
            .iter()
            .map(|c| read_u32(c, le))
            .collect(),
    )
}

fn has_jpeg_magic(file: &mut File, offset: u64, len: u64, file_len: u64) -> bool {
    if !(MIN_EMBEDDED_JPEG_BYTES..=MAX_EMBEDDED_JPEG_BYTES).contains(&len) {
        return false;
    }
    if offset.checked_add(len).is_none_or(|end| end > file_len) {
        return false;
    }
    let mut magic = [0u8; 3];
    file.seek(SeekFrom::Start(offset)).is_ok()
        && file.read_exact(&mut magic).is_ok()
        && magic == [0xFF, 0xD8, 0xFF]
}

fn extract_tiff(
    file: &mut File,
    file_len: u64,
    le: bool,
    head: &[u8; 16],
) -> Option<EmbeddedRawPreview> {
    let ifd0_offset = u64::from(read_u32(&head[4..8], le));
    let mut queue = VecDeque::from([ifd0_offset]);
    let mut visited = HashSet::new();
    let mut candidates: Vec<(u64, u64)> = Vec::new();
    let mut container_orientation: Option<u16> = None;

    while let Some(offset) = queue.pop_front() {
        if offset == 0 || offset >= file_len || !visited.insert(offset) {
            continue;
        }
        if visited.len() > MAX_IFDS_VISITED {
            break;
        }
        if file.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let mut count_buf = [0u8; 2];
        if file.read_exact(&mut count_buf).is_err() {
            continue;
        }
        let entry_count = usize::from(read_u16(&count_buf, le)).min(MAX_IFD_ENTRIES);
        let mut entries = vec![0u8; entry_count * 12];
        if file.read_exact(&mut entries).is_err() {
            continue;
        }
        let mut next_buf = [0u8; 4];
        if file.read_exact(&mut next_buf).is_ok() {
            let next_ifd = u64::from(read_u32(&next_buf, le));
            if next_ifd > 0 {
                queue.push_back(next_ifd);
            }
        }

        let mut jpg_start: Option<u64> = None;
        let mut jpg_len: Option<u64> = None;
        let mut strip_offset: Option<u64> = None;
        let mut strip_len: Option<u64> = None;
        let mut compression: Option<u16> = None;

        for entry in entries.as_chunks::<12>().0 {
            let tag = read_u16(&entry[0..2], le);
            let field_type = read_u16(&entry[2..4], le);
            let count = read_u32(&entry[4..8], le) as usize;
            let value_u32 = read_u32(&entry[8..12], le);
            let value_u16 = read_u16(&entry[8..10], le);

            match tag {
                // Orientation (IFD0 only)
                0x0112 if offset == ifd0_offset && count == 1 => {
                    container_orientation = Some(value_u16);
                }
                // Compression
                0x0103 if count == 1 => compression = Some(value_u16),
                // JPEGInterchangeFormat / JPEGInterchangeFormatLength
                0x0201 if count == 1 => jpg_start = Some(u64::from(value_u32)),
                0x0202 if count == 1 => jpg_len = Some(u64::from(value_u32)),
                // StripOffsets / StripByteCounts (single-strip JPEG in CR2 IFD0)
                0x0111 if count == 1 => strip_offset = Some(u64::from(value_u32)),
                0x0117 if count == 1 => strip_len = Some(u64::from(value_u32)),
                // Panasonic RW2 JpgFromRaw (UNDEFINED bytes inline at offset)
                0x002E if field_type == 7 && count > 4 => {
                    candidates.push((u64::from(value_u32), count as u64));
                }
                // SubIFDs
                0x014A if count == 1 => queue.push_back(u64::from(value_u32)),
                0x014A if count > 1 && count <= 16 => {
                    if let Some(offs) = read_u32_vec(file, u64::from(value_u32), count, le) {
                        for o in offs {
                            queue.push_back(u64::from(o));
                        }
                    }
                }
                _ => {}
            }
        }

        if let (Some(s), Some(l)) = (jpg_start, jpg_len) {
            candidates.push((s, l));
        }
        if let (Some(s), Some(l)) = (strip_offset, strip_len) {
            if matches!(compression, Some(6 | 7)) {
                candidates.push((s, l));
            }
        }
    }

    let best = candidates
        .into_iter()
        .filter(|&(off, len)| has_jpeg_magic(file, off, len, file_len))
        .max_by_key(|&(_, len)| len)?;

    file.seek(SeekFrom::Start(best.0)).ok()?;
    let mut jpeg = vec![0u8; best.1 as usize];
    file.read_exact(&mut jpeg).ok()?;
    Some(EmbeddedRawPreview {
        jpeg,
        container_orientation,
    })
}

fn extract_raf(file: &mut File, file_len: u64) -> Option<EmbeddedRawPreview> {
    if file_len < 0x5C {
        return None;
    }
    file.seek(SeekFrom::Start(0x54)).ok()?;
    let mut buf = [0u8; 8];
    file.read_exact(&mut buf).ok()?;
    let offset = u64::from(u32::from_be_bytes(buf[0..4].try_into().ok()?));
    let len = u64::from(u32::from_be_bytes(buf[4..8].try_into().ok()?));
    if !has_jpeg_magic(file, offset, len, file_len) {
        return None;
    }
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut jpeg = vec![0u8; len as usize];
    file.read_exact(&mut jpeg).ok()?;
    Some(EmbeddedRawPreview {
        jpeg,
        container_orientation: None,
    })
}

fn extract_cr3(file: &mut File, file_len: u64) -> Option<EmbeddedRawPreview> {
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut pos = 0u64;
    while pos + 8 <= file_len {
        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut hdr = [0u8; 8];
        file.read_exact(&mut hdr).ok()?;
        let size32 = u64::from(u32::from_be_bytes(hdr[0..4].try_into().ok()?));
        let kind = &hdr[4..8];
        let (header, size) = match size32 {
            0 => (8, file_len - pos),
            1 => {
                if pos + 16 > file_len {
                    return None;
                }
                let mut ext = [0u8; 8];
                file.read_exact(&mut ext).ok()?;
                (16, u64::from_be_bytes(ext))
            }
            n => (8, n),
        };
        if size < header || pos.checked_add(size).is_none_or(|end| end > file_len) {
            return None;
        }
        if kind == b"moov" {
            let body_len = size - header;
            if body_len > MAX_CR3_MOOV_BYTES {
                return None;
            }
            let mut moov = vec![0u8; body_len as usize];
            file.read_exact(&mut moov).ok()?;
            let jpeg = find_cr3_preview_jpeg(&moov)?;
            return Some(EmbeddedRawPreview {
                jpeg,
                container_orientation: None,
            });
        }
        pos += size;
    }
    None
}

fn find_cr3_preview_jpeg(data: &[u8]) -> Option<Vec<u8>> {
    // Search boxes recursively for PRVW (preferred) or THMB containing FF D8 FF ... FF D9.
    let mut best: Option<&[u8]> = None;
    let mut stack = vec![data];
    while let Some(mut slice) = stack.pop() {
        while slice.len() >= 8 {
            let size32 = u32::from_be_bytes(slice[0..4].try_into().ok()?) as usize;
            let kind = &slice[4..8];
            let (header, size) = if size32 == 0 {
                (8, slice.len())
            } else if size32 == 1 && slice.len() >= 16 {
                let s = u64::from_be_bytes(slice[8..16].try_into().ok()?) as usize;
                (16, s)
            } else {
                (8, size32)
            };
            if size < header || size > slice.len() {
                break;
            }
            let body = &slice[header..size];
            if kind == b"PRVW" || kind == b"THMB" {
                if let Some(start) = body.windows(3).position(|w| w == [0xFF, 0xD8, 0xFF]) {
                    let jpeg = &body[start..];
                    if jpeg.len() as u64 >= MIN_EMBEDDED_JPEG_BYTES
                        && best.is_none_or(|b| jpeg.len() > b.len())
                    {
                        best = Some(jpeg);
                    }
                }
            } else if kind == b"uuid" && body.len() > 16 {
                // Canon CR3 wraps PRVW inside a uuid container box.
                stack.push(&body[16..]);
            } else if matches!(
                kind,
                b"trak" | b"mdia" | b"minf" | b"stbl" | b"udta" | b"meta"
            ) {
                stack.push(body);
            }
            slice = &slice[size..];
        }
    }
    best.map(|b| b.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_jpeg(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb([40, 120, 200]));
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 85)
            .encode(&img, width, height, image::ExtendedColorType::Rgb8)
            .unwrap();
        bytes
    }

    fn build_tiff_with_subifd_preview(
        small_jpg: &[u8],
        large_jpg: &[u8],
        orientation: u16,
    ) -> Vec<u8> {
        // Layout:
        // 0..8:    TIFF header ("II*\0", IFD0 = 8)
        // 8..50:   IFD0 (3 entries: Orientation, SubIFDs, next=0) -> 2 + 36 + 4 = 42 bytes
        // 50..80:  SubIFD (2 entries: JPEGInterchangeFormat, Length, next=0) -> 2 + 24 + 4 = 30 bytes
        // 80..:    IFD1 (for small_jpg) or put small_jpg after large_jpg
        let ifd0_off = 8u32;
        let subifd_off = 50u32;
        let ifd1_off = 80u32;
        let small_off = 110u32;
        let large_off = small_off + small_jpg.len() as u32;

        let mut buf = vec![0u8; large_off as usize + large_jpg.len()];
        buf[0..4].copy_from_slice(b"II*\0");
        buf[4..8].copy_from_slice(&ifd0_off.to_le_bytes());

        // IFD0: 2 entries + next=ifd1_off
        let mut p = ifd0_off as usize;
        buf[p..p + 2].copy_from_slice(&2u16.to_le_bytes());
        p += 2;
        // Orientation (0x0112, SHORT=3, count=1)
        buf[p..p + 2].copy_from_slice(&0x0112u16.to_le_bytes());
        buf[p + 2..p + 4].copy_from_slice(&3u16.to_le_bytes());
        buf[p + 4..p + 8].copy_from_slice(&1u32.to_le_bytes());
        buf[p + 8..p + 10].copy_from_slice(&orientation.to_le_bytes());
        p += 12;
        // SubIFDs (0x014A, LONG=4, count=1)
        buf[p..p + 2].copy_from_slice(&0x014Au16.to_le_bytes());
        buf[p + 2..p + 4].copy_from_slice(&4u16.to_le_bytes());
        buf[p + 4..p + 8].copy_from_slice(&1u32.to_le_bytes());
        buf[p + 8..p + 12].copy_from_slice(&subifd_off.to_le_bytes());
        p += 12;
        buf[p..p + 4].copy_from_slice(&ifd1_off.to_le_bytes());

        // SubIFD: large_jpg
        let mut s = subifd_off as usize;
        buf[s..s + 2].copy_from_slice(&2u16.to_le_bytes());
        s += 2;
        buf[s..s + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        buf[s + 2..s + 4].copy_from_slice(&4u16.to_le_bytes());
        buf[s + 4..s + 8].copy_from_slice(&1u32.to_le_bytes());
        buf[s + 8..s + 12].copy_from_slice(&large_off.to_le_bytes());
        s += 12;
        buf[s..s + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        buf[s + 2..s + 4].copy_from_slice(&4u16.to_le_bytes());
        buf[s + 4..s + 8].copy_from_slice(&1u32.to_le_bytes());
        buf[s + 8..s + 12].copy_from_slice(&(large_jpg.len() as u32).to_le_bytes());

        // IFD1: small_jpg
        let mut i1 = ifd1_off as usize;
        buf[i1..i1 + 2].copy_from_slice(&2u16.to_le_bytes());
        i1 += 2;
        buf[i1..i1 + 2].copy_from_slice(&0x0201u16.to_le_bytes());
        buf[i1 + 2..i1 + 4].copy_from_slice(&4u16.to_le_bytes());
        buf[i1 + 4..i1 + 8].copy_from_slice(&1u32.to_le_bytes());
        buf[i1 + 8..i1 + 12].copy_from_slice(&small_off.to_le_bytes());
        i1 += 12;
        buf[i1..i1 + 2].copy_from_slice(&0x0202u16.to_le_bytes());
        buf[i1 + 2..i1 + 4].copy_from_slice(&4u16.to_le_bytes());
        buf[i1 + 4..i1 + 8].copy_from_slice(&1u32.to_le_bytes());
        buf[i1 + 8..i1 + 12].copy_from_slice(&(small_jpg.len() as u32).to_le_bytes());

        buf[small_off as usize..small_off as usize + small_jpg.len()].copy_from_slice(small_jpg);
        buf[large_off as usize..large_off as usize + large_jpg.len()].copy_from_slice(large_jpg);
        buf
    }

    #[test]
    fn picks_largest_embedded_jpeg_from_subifd_and_applies_container_orientation() {
        let dir = std::env::temp_dir().join(format!("visto-raw-preview-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let small = sample_jpeg(160, 120);
        let large = sample_jpeg(800, 400);
        let raw_bytes = build_tiff_with_subifd_preview(&small, &large, 6); // 90 deg CW
        let raw_path = dir.join("test.dng");
        std::fs::write(&raw_path, raw_bytes).unwrap();

        let extracted = extract_embedded_jpeg(&raw_path).expect("should extract");
        assert_eq!(extracted.jpeg, large);
        assert_eq!(extracted.container_orientation, Some(6));

        let dest = dir.join("thumb.jpg");
        let (_, w, h) = render_embedded_raw_preview(&raw_path, &dest, 256, 82).expect("rendered");
        // Orientation 6 swaps 800x400 -> 400x800, scaled to 256 -> 128x256
        assert_eq!((w, h), (128, 256));
        // Requesting a 2048px preview from an 800px embedded JPEG falls back (returns None)
        assert!(render_embedded_raw_preview(&raw_path, &dest, 2048, 88).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_fujifilm_raf_and_canon_cr3_previews() {
        let dir = std::env::temp_dir().join(format!("visto-raw-containers-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let jpg = sample_jpeg(640, 480);

        // RAF
        let raf_path = dir.join("test.raf");
        let mut raf = vec![0u8; 0x60 + jpg.len()];
        raf[0..16].copy_from_slice(b"FUJIFILMCCD-RAW ");
        raf[0x54..0x58].copy_from_slice(&(0x60u32).to_be_bytes());
        raf[0x58..0x5C].copy_from_slice(&(jpg.len() as u32).to_be_bytes());
        raf[0x60..].copy_from_slice(&jpg);
        std::fs::write(&raf_path, raf).unwrap();
        assert_eq!(extract_embedded_jpeg(&raf_path).unwrap().jpeg, jpg);

        // CR3 (ftyp + moov -> uuid(16 bytes) -> PRVW(8-byte header + 16-byte meta + jpg))
        let cr3_path = dir.join("test.cr3");
        let mut prvw = Vec::new();
        let prvw_size = (8 + 16 + jpg.len()) as u32;
        prvw.extend_from_slice(&prvw_size.to_be_bytes());
        prvw.extend_from_slice(b"PRVW");
        prvw.extend_from_slice(&[0u8; 16]);
        prvw.extend_from_slice(&jpg);

        let mut uuid_box = Vec::new();
        let uuid_size = (8 + 16 + prvw.len()) as u32;
        uuid_box.extend_from_slice(&uuid_size.to_be_bytes());
        uuid_box.extend_from_slice(b"uuid");
        uuid_box.extend_from_slice(&[0xAA; 16]);
        uuid_box.extend_from_slice(&prvw);

        let mut cr3 = Vec::new();
        cr3.extend_from_slice(&16u32.to_be_bytes());
        cr3.extend_from_slice(b"ftypcrx     ");
        let moov_size = (8 + uuid_box.len()) as u32;
        cr3.extend_from_slice(&moov_size.to_be_bytes());
        cr3.extend_from_slice(b"moov");
        cr3.extend_from_slice(&uuid_box);
        std::fs::write(&cr3_path, cr3).unwrap();
        assert_eq!(extract_embedded_jpeg(&cr3_path).unwrap().jpeg, jpg);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_raw_and_corrupt_files_cleanly() {
        let dir = std::env::temp_dir().join(format!("visto-raw-bad-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bad = dir.join("corrupt.dng");
        std::fs::write(&bad, b"II*\0\xff\xff\xff\xff").unwrap();
        assert!(extract_embedded_jpeg(&bad).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
