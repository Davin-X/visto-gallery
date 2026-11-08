//! Content-based animation detection.
//!
//! The catalog's `is_animated` flag answers "does this file contain more than
//! one frame (or an animation sequence)?" — not "could this format be
//! animated?". Every supported animated format declares that in its container
//! header, so this module reads a bounded amount of header data and never
//! decodes pixels:
//!
//! - **GIF**: walks blocks until a second image descriptor appears.
//! - **WebP**: `VP8X` flags byte bit `0x02` (or an `ANIM` chunk).
//! - **PNG / APNG**: an `acTL` chunk before the first `IDAT`.
//! - **AVIF / HEIF**: an `avis` (animated AVIF) or `msf1` (image sequence) brand
//!   in the `ftyp` box.
//!
//! A format we cannot read never guesses "still": [`detect_animation`] falls
//! back to the filename rule (`.gif`) so a temporarily unreadable file cannot
//! silently lose its animated status. A later rescan corrects it.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Extensions worth opening for a header probe. Everything else is answered
/// from the extension alone without touching the disk.
pub fn is_probe_candidate(extension: &str) -> bool {
    matches!(
        extension,
        "gif" | "webp" | "png" | "avif" | "heic" | "heif"
    )
}

/// Whether the catalog should treat this item as animated content.
///
/// `extension` is expected to be lowercased (as it is in the scanner). Returns
/// the filename fallback when the container cannot be read or is not one this
/// module understands, so the result is always a decision, never "unknown".
pub fn detect_animation(path: &Path, extension: &str) -> bool {
    if !is_probe_candidate(extension) {
        return false;
    }
    match probe_file(path) {
        Some(animated) => animated,
        None => extension == "gif",
    }
}

/// `Some(true)` = animated, `Some(false)` = still, `None` = could not tell
/// (unreadable file, truncated header, or a container shape we do not parse).
pub fn probe_file(path: &Path) -> Option<bool> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::with_capacity(8 * 1024, file);
    // The header decides the parser, so sniff the magic rather than trusting
    // the extension: a mislabelled `.png` that is really a GIF still works.
    let mut magic = [0u8; 8];
    reader.read_exact(&mut magic).ok()?;
    reader.seek(SeekFrom::Start(0)).ok()?;

    if magic.starts_with(b"GIF87a") || magic.starts_with(b"GIF89a") {
        probe_gif(&mut reader)
    } else if magic.starts_with(b"RIFF") {
        probe_webp(&mut reader)
    } else if magic.starts_with(b"\x89PNG\r\n\x1a\n") {
        probe_png(&mut reader)
    } else {
        probe_isobmff(&mut reader)
    }
}

fn read_u8<R: Read>(reader: &mut R) -> Option<u8> {
    let mut byte = [0u8; 1];
    reader.read_exact(&mut byte).ok()?;
    Some(byte[0])
}

fn read_u32_le<R: Read>(reader: &mut R) -> Option<u32> {
    let mut bytes = [0u8; 4];
    reader.read_exact(&mut bytes).ok()?;
    Some(u32::from_le_bytes(bytes))
}

fn read_u32_be<R: Read>(reader: &mut R) -> Option<u32> {
    let mut bytes = [0u8; 4];
    reader.read_exact(&mut bytes).ok()?;
    Some(u32::from_be_bytes(bytes))
}

/// Skip forward without reading the skipped bytes into memory. `SeekFrom::Current`
/// is relative, so this only works on the `BufReader<File>` we own; the buffered
/// reader adjusts its own cursor correctly.
fn skip<R: Seek>(reader: &mut R, bytes: u64) -> Option<()> {
    reader.seek(SeekFrom::Current(bytes as i64)).ok()?;
    Some(())
}

// ===== GIF =====

/// A block count cap: a malformed file must not spin the scanner forever.
const MAX_GIF_BLOCKS: usize = 500_000;

fn probe_gif<R: Read + Seek>(reader: &mut R) -> Option<bool> {
    // Header is 6 bytes; the logical screen descriptor is width(2),
    // height(2), packed(1), background(1), aspect ratio(1).
    skip(reader, 10)?;
    let packed = read_u8(reader)?;
    skip(reader, 2)?;
    // A global color table sits between the descriptor and the first block.
    // Walking into it would read palette bytes as block introducers.
    if packed & 0x80 != 0 {
        let entries = 1u32 << ((packed & 0x07) as u32 + 1);
        skip(reader, entries as u64 * 3)?;
    }
    let mut blocks = 0usize;
    let mut frames = 0usize;
    loop {
        blocks += 1;
        if blocks > MAX_GIF_BLOCKS {
            return None;
        }
        match read_u8(reader)? {
            // Trailer: the file ends without a second frame.
            0x3B => return Some(frames > 1),
            // Extension block: label byte, then data sub-blocks.
            0x21 => {
                let _label = read_u8(reader)?;
                skip_sub_blocks(reader)?;
            }
            // Image descriptor: the frame itself.
            0x2C => {
                frames += 1;
                if frames > 1 {
                    // Two descriptors is all we need to know.
                    return Some(true);
                }
                // Left/top/width/height (8) + packed byte (1).
                let packed = {
                    skip(reader, 8)?;
                    read_u8(reader)?
                };
                // Local color table: 3 bytes per entry, 2^(N+1) entries.
                if packed & 0x80 != 0 {
                    let entries = 1u32 << ((packed & 0x07) as u32 + 1);
                    skip(reader, entries as u64 * 3)?;
                }
                // LZW minimum code size, then the compressed data sub-blocks.
                let _lzw_min_code_size = read_u8(reader)?;
                skip_sub_blocks(reader)?;
            }
            // Unknown block introducer: let the caller fall back.
            _ => return None,
        }
    }
}

/// Data sub-blocks: a chain of `[len][len bytes]` terminated by a zero length.
fn skip_sub_blocks<R: Read + Seek>(reader: &mut R) -> Option<()> {
    loop {
        let len = read_u8(reader)?;
        if len == 0 {
            return Some(());
        }
        skip(reader, len as u64)?;
    }
}

// ===== WebP =====

/// `VP8X` flags: bit 1 (0x02) is the animation flag.
const WEBP_FLAG_ANIMATION: u8 = 0x02;

fn probe_webp<R: Read + Seek>(reader: &mut R) -> Option<bool> {
    // "RIFF" + file size (4) + "WEBP" (4).
    skip(reader, 12)?;
    for _ in 0..64 {
        let mut fourcc = [0u8; 4];
        reader.read_exact(&mut fourcc).ok()?;
        let size = read_u32_le(reader)?;
        match &fourcc {
            b"VP8X" => {
                let flags = read_u8(reader)?;
                return Some(flags & WEBP_FLAG_ANIMATION != 0);
            }
            // An ANIM chunk without a VP8X header is malformed, but it is a
            // clear enough statement of intent to trust.
            b"ANIM" => return Some(true),
            // Simple lossy / lossless still images have no animation chunks.
            b"VP8 " | b"VP8L" => return Some(false),
            _ => {
                // Chunk payloads are padded to an even length.
                let padded = size as u64 + (size as u64 & 1);
                skip(reader, padded)?;
            }
        }
    }
    None
}

// ===== PNG / APNG =====

fn probe_png<R: Read + Seek>(reader: &mut R) -> Option<bool> {
    // Signature.
    skip(reader, 8)?;
    for _ in 0..1024 {
        let length = read_u32_be(reader)?;
        let mut kind = [0u8; 4];
        reader.read_exact(&mut kind).ok()?;
        match &kind {
            // `acTL` must precede the first `IDAT` for a valid APNG, so seeing
            // `IDAT` first settles it: this is a still PNG.
            b"IDAT" | b"IEND" => return Some(false),
            b"acTL" => return Some(true),
            _ => {
                // Skip the payload plus the 4-byte CRC.
                skip(reader, length as u64 + 4)?;
            }
        }
    }
    None
}

// ===== AVIF / HEIF =====

fn probe_isobmff<R: Read + Seek>(reader: &mut R) -> Option<bool> {
    let box_size = read_u32_be(reader)? as u64;
    let mut kind = [0u8; 4];
    reader.read_exact(&mut kind).ok()?;
    if &kind != b"ftyp" || box_size < 16 {
        return None;
    }
    // Major brand (4) + minor version (4).
    let mut major = [0u8; 4];
    reader.read_exact(&mut major).ok()?;
    skip(reader, 4)?;

    let mut brands: Vec<[u8; 4]> = vec![major];
    // Each compatible brand is 4 bytes inside the ftyp payload.
    let remaining = box_size.saturating_sub(16) / 4;
    for _ in 0..remaining.min(64) {
        let mut brand = [0u8; 4];
        reader.read_exact(&mut brand).ok()?;
        brands.push(brand);
    }

    // `avis` = animated AVIF, `msf1` = HEIF image sequence.
    let animated = brands
        .iter()
        .any(|brand| brand == b"avis" || brand == b"msf1");
    Some(animated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn write_temp(extension: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "visto-animation-probe-{}.{}",
            Uuid::new_v4(),
            extension
        ));
        std::fs::write(&path, bytes).expect("write fixture");
        path
    }

    fn gif_with_palette(header: &[u8], frames: usize, global_palette: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(header);
        // Logical screen descriptor: width, height, packed, bg, aspect.
        // packed 0x80 = global color table present, 2^(0+1) = 2 entries.
        let packed = if global_palette { 0x80 } else { 0x00 };
        bytes.extend_from_slice(&[0x01, 0x00, 0x01, 0x00, packed, 0x00, 0x00]);
        if global_palette {
            // Two RGB entries: black and white.
            bytes.extend_from_slice(&[0, 0, 0, 255, 255, 255]);
        }
        for _ in 0..frames {
            // Image descriptor with no local color table.
            bytes.push(0x2C);
            bytes.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0, 0x00]);
            // LZW minimum code size + one data sub-block + block terminator.
            bytes.push(0x02);
            bytes.extend_from_slice(&[0x02, 0x44, 0x01, 0x00]);
        }
        bytes.push(0x3B); // trailer
        bytes
    }

    fn gif(header: &[u8], frames: usize) -> Vec<u8> {
        gif_with_palette(header, frames, false)
    }

    fn riff_webp(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.extend_from_slice(b"WEBP");
        for (fourcc, body) in chunks {
            payload.extend_from_slice(*fourcc);
            payload.extend_from_slice(&(body.len() as u32).to_le_bytes());
            payload.extend_from_slice(body);
            if body.len() % 2 == 1 {
                payload.push(0);
            }
        }
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn png_chunks(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        for (kind, body) in chunks {
            bytes.extend_from_slice(&(body.len() as u32).to_be_bytes());
            bytes.extend_from_slice(*kind);
            bytes.extend_from_slice(body);
            bytes.extend_from_slice(&[0, 0, 0, 0]); // CRC (not validated)
        }
        bytes
    }

    fn isobmff(brands: &[&[u8]]) -> Vec<u8> {
        let mut payload = Vec::new();
        for brand in brands {
            payload.extend_from_slice(*brand);
        }
        let size = 16 + payload.len() as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&size.to_be_bytes());
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(b"isom"); // major brand
        bytes.extend_from_slice(&[0, 0, 0, 0]); // minor version
        bytes.extend_from_slice(&payload);
        bytes
    }

    #[test]
    fn gif_with_two_frames_is_animated() {
        for header in [b"GIF87a".as_slice(), b"GIF89a".as_slice()] {
            let path = write_temp("gif", &gif(header, 2));
            assert_eq!(detect_animation(&path, "gif"), true);
            assert_eq!(probe_file(&path), Some(true));
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn single_frame_gif_is_still() {
        let path = write_temp("gif", &gif(b"GIF89a", 1));
        assert_eq!(probe_file(&path), Some(false));
        assert_eq!(detect_animation(&path, "gif"), false);
        let _ = std::fs::remove_file(path);
    }

    /// Real GIFs almost always carry a global color table. Walking into it
    /// made every ffmpeg-produced GIF look animated, so this pins the skip.
    #[test]
    fn global_color_table_is_skipped_before_the_block_walk() {
        let still = write_temp("gif", &gif_with_palette(b"GIF89a", 1, true));
        assert_eq!(probe_file(&still), Some(false));

        let animated = write_temp("gif", &gif_with_palette(b"GIF89a", 3, true));
        assert_eq!(probe_file(&animated), Some(true));

        let _ = std::fs::remove_file(still);
        let _ = std::fs::remove_file(animated);
    }

    #[test]
    fn gif_extension_with_gif_magic_still_wins_the_fallback() {
        // Truncated: the walk fails, so the filename rule answers instead of
        // reporting "still".
        let path = write_temp("gif", b"GIF89a\x01");
        assert_eq!(probe_file(&path), None);
        assert_eq!(detect_animation(&path, "gif"), true);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn webp_with_animation_flag_is_animated() {
        let path = write_temp(
            "webp",
            &riff_webp(&[
                (b"VP8X", vec![0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                (b"ANIM", vec![0, 0, 0, 0, 0, 0]),
            ]),
        );
        assert_eq!(probe_file(&path), Some(true));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn still_webp_without_the_flag_is_not_animated() {
        let extended = write_temp(
            "webp",
            &riff_webp(&[(
                b"VP8X",
                vec![0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            )]),
        );
        assert_eq!(probe_file(&extended), Some(false));

        let simple = write_temp("webp", &riff_webp(&[(b"VP8L", vec![0x2f, 1, 2, 3, 4])]));
        assert_eq!(probe_file(&simple), Some(false));
        assert_eq!(detect_animation(&simple, "webp"), false);

        let _ = std::fs::remove_file(extended);
        let _ = std::fs::remove_file(simple);
    }

    #[test]
    fn apng_is_animated_and_plain_png_is_not() {
        let apng = write_temp(
            "png",
            &png_chunks(&[
                (b"acTL", vec![0, 0, 0, 2, 0, 0, 0, 0]),
                (b"IDAT", vec![1, 2, 3]),
                (b"IEND", vec![]),
            ]),
        );
        assert_eq!(probe_file(&apng), Some(true));

        let still = write_temp(
            "png",
            &png_chunks(&[(b"IDAT", vec![1, 2, 3]), (b"IEND", vec![])]),
        );
        assert_eq!(probe_file(&still), Some(false));
        assert_eq!(detect_animation(&still, "png"), false);

        let _ = std::fs::remove_file(apng);
        let _ = std::fs::remove_file(still);
    }

    #[test]
    fn avif_sequence_brand_is_animated_and_still_avif_is_not() {
        let animated = write_temp(
            "avif",
            &isobmff(&[b"avif".as_slice(), b"avis".as_slice()]),
        );
        assert_eq!(probe_file(&animated), Some(true));

        let still = write_temp("avif", &isobmff(&[b"avif".as_slice(), b"mif1".as_slice()]));
        assert_eq!(probe_file(&still), Some(false));

        let heif_sequence = write_temp("heic", &isobmff(&[b"heic".as_slice(), b"msf1".as_slice()]));
        assert_eq!(probe_file(&heif_sequence), Some(true));

        let _ = std::fs::remove_file(animated);
        let _ = std::fs::remove_file(still);
        let _ = std::fs::remove_file(heif_sequence);
    }

    #[test]
    fn unreadable_or_foreign_files_fall_back_to_the_extension_rule() {
        let garbage = write_temp("png", b"not really an image");
        assert_eq!(probe_file(&garbage), None);
        assert_eq!(detect_animation(&garbage, "png"), false);
        assert_eq!(detect_animation(&garbage, "gif"), true);

        let missing = std::env::temp_dir().join("visto-animation-probe-missing.gif");
        let _ = std::fs::remove_file(&missing);
        assert_eq!(detect_animation(&missing, "gif"), true);
        assert_eq!(detect_animation(&missing, "webp"), false);

        let _ = std::fs::remove_file(garbage);
    }

    #[test]
    fn formats_without_animation_support_never_open_the_file() {
        for extension in ["jpg", "jpeg", "heic_", "tiff", "cr3", "mp4", ""] {
            assert!(!is_probe_candidate(extension), "{extension}");
            assert_eq!(detect_animation(Path::new("/nope"), extension), false);
        }
    }
}
