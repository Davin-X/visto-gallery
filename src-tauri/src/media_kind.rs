use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use ts_rs::TS;

/// Canonical catalog media kind. Serialized as `"photo" | "video" | "raw"`
/// over IPC and stored as the same lowercase strings in SQLite (`media_items.kind`
/// has a CHECK constraint on these values in `001_initial_schema.sql`).
///
/// This is the single source of truth for kind values and extension mapping.
/// Adding a supported extension or a kind must happen here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Photo,
    Video,
    Raw,
}

/// The one `(extension, kind)` table the catalog accepts. Extensions are
/// lowercase. The scanner, file picker, kind detection, and tests all derive
/// from this, so they cannot drift apart.
pub const EXTENSION_TABLE: &[(&str, MediaKind)] = &[
    // Images
    ("avif", MediaKind::Photo),
    ("bmp", MediaKind::Photo),
    ("gif", MediaKind::Photo),
    ("heic", MediaKind::Photo),
    ("heif", MediaKind::Photo),
    ("jfif", MediaKind::Photo),
    ("jpe", MediaKind::Photo),
    ("jpeg", MediaKind::Photo),
    ("jpg", MediaKind::Photo),
    ("jxl", MediaKind::Photo),
    ("png", MediaKind::Photo),
    ("tif", MediaKind::Photo),
    ("tiff", MediaKind::Photo),
    ("webp", MediaKind::Photo),
    // RAW
    ("3fr", MediaKind::Raw),
    ("ari", MediaKind::Raw),
    ("arw", MediaKind::Raw),
    ("bay", MediaKind::Raw),
    ("cap", MediaKind::Raw),
    ("cr2", MediaKind::Raw),
    ("cr3", MediaKind::Raw),
    ("dcs", MediaKind::Raw),
    ("dcr", MediaKind::Raw),
    ("dng", MediaKind::Raw),
    ("drf", MediaKind::Raw),
    ("eip", MediaKind::Raw),
    ("erf", MediaKind::Raw),
    ("fff", MediaKind::Raw),
    ("gpr", MediaKind::Raw),
    ("iiq", MediaKind::Raw),
    ("k25", MediaKind::Raw),
    ("kdc", MediaKind::Raw),
    ("mdc", MediaKind::Raw),
    ("mef", MediaKind::Raw),
    ("mos", MediaKind::Raw),
    ("mrw", MediaKind::Raw),
    ("nef", MediaKind::Raw),
    ("nrw", MediaKind::Raw),
    ("obm", MediaKind::Raw),
    ("orf", MediaKind::Raw),
    ("pef", MediaKind::Raw),
    ("ptx", MediaKind::Raw),
    ("pxn", MediaKind::Raw),
    ("r3d", MediaKind::Raw),
    ("raf", MediaKind::Raw),
    ("raw", MediaKind::Raw),
    ("rw2", MediaKind::Raw),
    ("rwl", MediaKind::Raw),
    ("sr2", MediaKind::Raw),
    ("srf", MediaKind::Raw),
    ("srw", MediaKind::Raw),
    ("x3f", MediaKind::Raw),
    // Video
    ("3g2", MediaKind::Video),
    ("3gp", MediaKind::Video),
    ("asf", MediaKind::Video),
    ("avi", MediaKind::Video),
    ("flv", MediaKind::Video),
    ("m2ts", MediaKind::Video),
    ("m4v", MediaKind::Video),
    ("mkv", MediaKind::Video),
    ("mov", MediaKind::Video),
    ("mp4", MediaKind::Video),
    ("mpeg", MediaKind::Video),
    ("mpg", MediaKind::Video),
    ("mts", MediaKind::Video),
    ("ogv", MediaKind::Video),
    ("ts", MediaKind::Video),
    ("vob", MediaKind::Video),
    ("webm", MediaKind::Video),
    ("wmv", MediaKind::Video),
];

#[allow(dead_code)] // part of the public API; referenced in tests and useful for callers
pub const ALL_KINDS: &[MediaKind] = &[MediaKind::Photo, MediaKind::Video, MediaKind::Raw];

impl MediaKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Photo => "photo",
            Self::Video => "video",
            Self::Raw => "raw",
        }
    }

    /// Catalog kind for a supported lowercase extension, or `None` when the
    /// extension is not media.
    pub fn from_ext(ext: &str) -> Option<Self> {
        EXTENSION_TABLE
            .iter()
            .find_map(|(e, kind)| (*e == ext).then_some(*kind))
    }

    /// Like [`Self::from_ext`], but preserves the historical fallback: unknown
    /// extensions default to `Photo` (callers that have already validated the
    /// file still get a stable kind).
    pub fn from_ext_or_photo(ext: &str) -> Self {
        Self::from_ext(ext).unwrap_or(Self::Photo)
    }

    /// Parse a stored/IPC kind string. Accepts only the canonical lowercase
    /// values.
    pub fn parse_str(s: &str) -> Option<Self> {
        match s {
            "photo" => Some(Self::Photo),
            "video" => Some(Self::Video),
            "raw" => Some(Self::Raw),
            _ => None,
        }
    }
}

impl fmt::Display for MediaKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for MediaKind {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse_str(s).ok_or_else(|| format!("unsupported media kind: {s}"))
    }
}

impl From<&str> for MediaKind {
    fn from(s: &str) -> Self {
        Self::parse_str(s).unwrap_or_else(|| panic!("unsupported media kind: {s}"))
    }
}

pub fn is_media_file(ext: &str) -> bool {
    MediaKind::from_ext(ext).is_some()
}

/// Canonical list of supported media extensions, kept in sync with
/// [`EXTENSION_TABLE`].
pub fn supported_extensions() -> Vec<String> {
    EXTENSION_TABLE
        .iter()
        .map(|(ext, _)| (*ext).to_string())
        .collect()
}

/// Catalog kind for an extension, defaulting to photo for unknown extensions
/// (matches the historical `kind_for_ext` behavior).
pub fn kind_for_ext(ext: &str) -> MediaKind {
    MediaKind::from_ext_or_photo(ext)
}

impl PartialEq<&str> for MediaKind {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl PartialEq<str> for MediaKind {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<MediaKind> for &str {
    fn eq(&self, other: &MediaKind) -> bool {
        *self == other.as_str()
    }
}

impl PartialEq<MediaKind> for str {
    fn eq(&self, other: &MediaKind) -> bool {
        self == other.as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_table_is_the_single_source_of_truth() {
        assert!(is_media_file("jpg"));
        assert!(is_media_file("HEIC".to_lowercase().as_str()));
        assert!(is_media_file("mkv"));
        assert!(is_media_file("cr3"));
        assert!(!is_media_file("txt"));
        assert!(!is_media_file("pdf"));
        assert_eq!(kind_for_ext("mkv"), MediaKind::Video);
        assert_eq!(kind_for_ext("cr3"), MediaKind::Raw);
        assert_eq!(kind_for_ext("heic"), MediaKind::Photo);
        let exts = supported_extensions();
        for ext in [
            "jpg", "jpeg", "png", "heic", "dng", "cr2", "cr3", "nef", "arw", "mp4", "mov", "avi",
            "mkv",
        ] {
            assert!(exts.contains(&ext.to_string()), "missing {ext}");
        }
        assert!(!exts.contains(&"txt".to_string()));
        let set: std::collections::HashSet<_> = exts.iter().collect();
        assert_eq!(set.len(), exts.len(), "duplicate extension in table");
        assert_eq!(exts.len(), EXTENSION_TABLE.len());
    }

    #[test]
    fn kind_strings_match_schema_check_constraint() {
        // 001_initial_schema.sql: CHECK (kind IN ('photo', 'video', 'raw'))
        let db_values = ["photo", "video", "raw"];
        let enum_values: Vec<_> = ALL_KINDS.iter().map(|k| k.as_str()).collect();
        assert_eq!(enum_values, db_values);
        for v in db_values {
            assert_eq!(MediaKind::parse_str(v).unwrap().as_str(), v);
        }
    }

    #[test]
    fn ipc_serialization_uses_lowercase_strings() {
        assert_eq!(
            serde_json::to_string(&MediaKind::Photo).unwrap(),
            "\"photo\""
        );
        assert_eq!(serde_json::to_string(&MediaKind::Raw).unwrap(), "\"raw\"");
        assert_eq!(
            serde_json::from_str::<MediaKind>("\"video\"").unwrap(),
            MediaKind::Video
        );
    }
}
