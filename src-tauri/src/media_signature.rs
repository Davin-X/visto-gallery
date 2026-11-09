//! Content fingerprints for catalog items.
//!
//! The catalog id is derived from the absolute path (see `models::stable_id`),
//! which is what makes a re-scan update a row instead of appending a duplicate.
//! The downside is that moving or renaming a file on disk looks like a delete
//! plus an unrelated import, so the row — and with it the favourite flag,
//! rating, tags and album membership — is lost.
//!
//! This module provides the small, cheap fingerprint used to recognise the same
//! bytes at a new path during a scan. It hashes the file size plus the first and
//! last 64 KiB, so the cost stays bounded for multi-gigabyte videos and no full
//! decode or full read is ever performed.

use ring::digest;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Bytes sampled from each end of the file.
const SAMPLE_BYTES: u64 = 64 * 1024;

/// Fingerprint the file's content, or `None` when it cannot be read.
///
/// Returning `None` is deliberate: an unreadable file must not be treated as a
/// fingerprint of "empty content", which would then be free to match anything.
pub fn content_signature(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();

    let mut context = digest::Context::new(&digest::SHA256);
    context.update(&length.to_le_bytes());

    let head_size = SAMPLE_BYTES.min(length);
    let mut head = vec![0u8; usize::try_from(head_size).ok()?];
    file.read_exact(&mut head).ok()?;
    context.update(&head);

    // Small files use the same bytes twice; that is harmless and keeps the
    // layout identical for every size, so a file that grows still hashes from
    // its new tail instead of silently reusing an old sample.
    let tail_size = SAMPLE_BYTES.min(length);
    file.seek(SeekFrom::Start(length.saturating_sub(tail_size)))
        .ok()?;
    let mut tail = vec![0u8; usize::try_from(tail_size).ok()?];
    file.read_exact(&mut tail).ok()?;
    context.update(&tail);

    Some(hex::encode(context.finish().as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "visto-gallery-signature-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn same_bytes_at_a_different_path_share_a_signature() {
        let dir = temp_dir("move");
        let original = dir.join("original.jpg");
        let moved = dir.join("renamed-and-moved.jpg");
        fs::write(&original, vec![7u8; 4096]).expect("write original");
        fs::copy(&original, &moved).expect("copy");

        assert_eq!(
            content_signature(&original),
            content_signature(&moved),
            "identical content must fingerprint identically"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn different_bytes_do_not_collide() {
        let dir = temp_dir("differ");
        let a = dir.join("a.jpg");
        let b = dir.join("b.jpg");
        fs::write(&a, vec![1u8; 4096]).expect("write a");
        fs::write(&b, vec![2u8; 4096]).expect("write b");

        assert_ne!(content_signature(&a), content_signature(&b));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn same_size_different_content_is_distinguished() {
        // The fingerprint exists to survive a move, not to be a duplicate
        // detector, but it must still tell two same-sized files apart.
        let dir = temp_dir("same-size");
        let a = dir.join("a.jpg");
        let b = dir.join("b.jpg");
        let mut first = vec![0u8; 1024];
        let mut second = vec![0u8; 1024];
        first[0] = 1;
        second[0] = 2;
        fs::write(&a, &first).expect("write a");
        fs::write(&b, &second).expect("write b");

        assert_ne!(content_signature(&a), content_signature(&b));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn samples_both_ends_of_a_large_file() {
        let dir = temp_dir("large");
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        let mut bytes = vec![0u8; 300 * 1024];
        fs::write(&a, &bytes).expect("write a");
        // Change one byte in the middle: outside both samples, so this is
        // expected to match. Change the tail instead and it must not.
        bytes[150 * 1024] = 9;
        fs::write(&b, &bytes).expect("write b");
        assert_eq!(content_signature(&a), content_signature(&b));

        let mut tail_changed = bytes.clone();
        tail_changed[299 * 1024] = 9;
        fs::write(&b, &tail_changed).expect("rewrite b");
        assert_ne!(content_signature(&a), content_signature(&b));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_has_no_signature() {
        let dir = temp_dir("missing");
        assert!(content_signature(&dir.join("nope.jpg")).is_none());
        fs::remove_dir_all(&dir).ok();
    }
}
