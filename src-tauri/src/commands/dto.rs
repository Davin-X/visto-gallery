use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::models::{Album, MediaItem, Tag};

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub items: Vec<MediaItem>,
    pub discovered_count: usize,
    /// Rows removed because their files no longer exist under the scanned root.
    pub removed_count: usize,
    pub cancelled: bool,
    pub albums: Vec<Album>,
    pub tags: Vec<Tag>,
    pub total_size: i64,
    pub duration: i64,
}

/// A folder in the library, either explicitly imported or inferred from the
/// on-disk location of items added before folder tracking existed.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    pub path: String,
    pub name: String,
    pub item_count: i64,
    pub total_size: i64,
    /// False when the folder no longer exists on disk (registered source was
    /// deleted or moved outside the app).
    pub available: bool,
}

#[derive(Deserialize, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct LibraryFilterDTO {
    pub kind: Option<String>,
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    /// `Some(true)` narrows to animated items, `Some(false)` to still ones.
    /// Independent of `kind`, which keeps its photo | video | raw meaning.
    pub animated: Option<bool>,
    pub album_id: Option<String>,
    pub query: Option<String>,
    pub tags: Option<Vec<String>>,
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    pub source_path: Option<String>,
    pub rating: Option<i32>,
    pub color_label: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub limit: Option<i32>,
    /// Opaque cursor returned by a previous `get_library_items` page.
    pub cursor: Option<String>,
    #[ts(
        optional,
        type = "\"capturedAt\" | \"modifiedAt\" | \"name\" | \"size\" | \"kind\""
    )]
    pub sort_by: Option<String>,
    #[ts(optional, type = "\"asc\" | \"desc\"")]
    pub sort_order: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields = nullable)]
pub struct ExifData {
    pub captured_at: Option<i64>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub exposure: Option<String>,
    pub iso: Option<i32>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub metadata_error: Option<String>,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct RenderRequest {
    pub source_path: String,
    /// Catalog id of the item. Required for in-place edits so the original can
    /// be journaled under a stable key.
    pub media_id: Option<String>,
    pub edits: EditValues,
    #[ts(type = "\"jpeg\" | \"png\" | \"webp\" | \"heic\" | \"avif\" | \"in_place\"")]
    pub output_format: String,
    pub quality: f32,
    pub strip_metadata: bool,
    pub crop: Option<CropRect>,
}

#[derive(Deserialize, Serialize, Clone, Default, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditValues {
    pub exposure: i32,
    pub contrast: i32,
    pub warmth: i32,
    pub shadows: i32,
    pub highlights: i32,
    pub saturation: i32,
    pub rotation: i32,
    pub flip: bool,
}

#[derive(Deserialize, Serialize, Clone, TS)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Client-side crop state attached to an edit recipe or preset. `aspectRatio`
/// is either a concrete ratio or the literal `"free"`.
///
/// Edit recipes keep their edits and crop as opaque JSON in SQLite, so nothing
/// in Rust constructs this type. It exists so `EditRecipe`/`EditPreset` can
/// name the shape the frontend persists via `#[ts(type = "CropState")]`; the
/// editor validates values before saving, and the render path that actually
/// applies them takes typed `EditValues`/`CropRect` arguments.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CropState {
    pub enabled: bool,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    #[ts(type = "number | \"free\"")]
    pub aspect_ratio: serde_json::Value,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_path: String,
    pub size: i64,
    pub width: i32,
    pub height: i32,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct BatchExportRequest {
    pub items: Vec<BatchExportItem>,
    pub output_folder: String,
    pub pattern: String,
    #[ts(type = "\"jpeg\" | \"png\" | \"webp\" | \"heic\" | \"avif\" | \"source\"")]
    pub format: String,
    pub quality: f32,
    pub strip_metadata: bool,
    pub max_dimension: Option<u32>,
}

#[derive(Deserialize, Serialize, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct BatchExportItem {
    pub id: String,
    pub source_path: String,
    pub index: u32,
    /// `photo`, `video`, or `raw`. Optional so older callers still work.
    #[serde(default)]
    pub kind: Option<crate::media_kind::MediaKind>,
    /// Capture/modification time in milliseconds, used by the `{date}` token.
    #[serde(default)]
    pub date: Option<i64>,
}

#[derive(Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportProgress {
    pub current: u32,
    pub total: u32,
    pub current_file: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportResult {
    pub exported: u32,
    pub failed: Vec<BatchExportError>,
    pub outputs: Vec<String>,
    pub cancelled: bool,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportError {
    pub item_id: String,
    pub error: String,
}

#[derive(Serialize, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields = nullable)]
pub struct TrashResult {
    /// Catalog ids that were moved to Trash.
    pub trashed: Vec<String>,
    pub failed: Vec<TrashError>,
    /// Set when the files reached the Trash but the catalog could not be
    /// updated. The move succeeded; the rows are stale until a rescan.
    pub catalog_error: Option<String>,
}

#[derive(Serialize, Debug, TS)]
#[serde(rename_all = "camelCase")]
pub struct TrashError {
    pub id: String,
    pub error: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub id: String,
    pub sha256: String,
    pub size: i64,
    pub items: Vec<MediaItem>,
}

macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        $name:ident { $($variant:ident => $value:literal),+ $(,)? } default $default:ident
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
        #[serde(rename_all = "lowercase")]
        pub enum $name {
            $($variant),+
        }

        impl Default for $name {
            fn default() -> Self {
                Self::$default
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(match self {
                    $(Self::$variant => $value),+
                })
            }
        }

        impl std::str::FromStr for $name {
            type Err = ();

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(()),
                }
            }
        }
    };
}

string_enum!(
    /// How the app resolves its light/dark appearance.
    Appearance { Light => "light", Dark => "dark", System => "system" } default System
);
string_enum!(
    /// Accent color used by controls and highlights.
    AccentColor {
        Blue => "blue",
        Purple => "purple",
        Green => "green",
        Orange => "orange",
        Pink => "pink",
        Red => "red"
    } default Blue
);
string_enum!(
    /// Screen restored when the app starts.
    StartupView { Library => "library", Last => "last", Slideshow => "slideshow" } default Library
);
string_enum!(
    /// Default library layout.
    DefaultLayout { Grid => "grid", Details => "details", Timeline => "timeline" } default Grid
);
string_enum!(
    /// Default thumbnail density.
    ThumbnailSize { Small => "small", Medium => "medium", Large => "large" } default Small
);
string_enum!(
    /// How the viewer scales a photo on first open.
    ViewerZoomBehavior { Fit => "fit", Actual => "actual", Last => "last" } default Fit
);

/// The single settings contract. Both the full read model and the partial save
/// patch are generated from this list so they can never drift apart.
macro_rules! define_settings {
    (
        $(
            $(#[$meta:meta])*
            $field:ident : $ty:ty = $default:expr
        ),+ $(,)?
    ) => {
        #[derive(Serialize, Deserialize, TS)]
        #[serde(rename_all = "camelCase")]
        pub struct AppSettings {
            $(
                $(#[$meta])*
                pub $field: $ty,
            )+
        }

        impl Default for AppSettings {
            fn default() -> Self {
                Self {
                    $($field: $default,)+
                }
            }
        }

        #[derive(Deserialize, Serialize, Default, TS)]
        #[serde(rename_all = "camelCase")]
        #[ts(optional_fields)]
        pub struct PartialSettings {
            $(
                $(#[$meta])*
                pub $field: Option<$ty>,
            )+
        }
    };
}

define_settings! {
    appearance: Appearance = Appearance::System,
    accent_color: AccentColor = AccentColor::Blue,
    sidebar_width: i32 = 220,
    inspector_width: i32 = 300,
    show_extensions: bool = false,
    animate_transitions: bool = true,
    startup_view: StartupView = StartupView::Library,
    open_last_folder: bool = true,
    restore_window_state: bool = true,
    default_layout: DefaultLayout = DefaultLayout::Grid,
    thumbnail_size: ThumbnailSize = ThumbnailSize::Small,
    viewer_zoom_behavior: ViewerZoomBehavior = ViewerZoomBehavior::Fit,
    slideshow_interval: i32 = 5,
    slideshow_shuffle: bool = false,
    slideshow_loop: bool = true,
    video_auto_play: bool = true,
    video_loop: bool = false,
    watch_folders: Vec<String> = Vec::new(),
    auto_import: bool = false,
    /// Dormant compatibility field. RAW+JPEG pairing is not implemented yet;
    /// the control is marked unavailable in Settings, but the persisted value
    /// is kept so an upgrade never drops a user preference.
    pair_raw_jpeg: bool = true,
    /// Dormant compatibility field. Burst stacking is not implemented yet; the
    /// control is marked unavailable in Settings, but the persisted value is
    /// kept so an upgrade never drops a user preference.
    stack_bursts: bool = true,
    /// Dormant compatibility field. Live Photo stacking is not implemented yet;
    /// the control is marked unavailable in Settings, but the persisted value
    /// is kept so an upgrade never drops a user preference.
    stack_live_photos: bool = true,
    /// Contact GitHub for public release metadata once after launch. Defaults
    /// to false to preserve the local-first promise; Help > Check for Updates
    /// always works regardless of this preference.
    check_for_updates_on_launch: bool = false,
    /// Thumbnail cache budget in gigabytes.
    // Serialized with the acronym the UI has always used.
    #[serde(rename = "maxCacheSizeGB")]
    max_cache_size_gb: i32 = 5,
    thumbnail_quality: i32 = 80,
    enable_debug_logging: bool = false,
    show_native_limit_warnings: bool = true,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pull the field names out of a generated object type declaration.
    fn generated_fields(type_name: &str) -> Vec<String> {
        let source = std::fs::read_to_string(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../src/engine/types/generated/ipc.ts"),
        )
        .expect("read generated IPC types");
        let marker = format!("export type {type_name} = {{");
        let start = source.find(&marker).expect("generated declaration") + marker.len();
        let body = &source[start..];
        let end = body.find("};").expect("declaration end");
        let body = &body[..end];

        // The generated file inlines doc comments; drop them before splitting.
        let mut clean = String::new();
        let mut comment = false;
        for line in body.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("/*") {
                comment = true;
            }
            if !comment {
                clean.push_str(line);
                clean.push(' ');
            }
            if comment && trimmed.ends_with("*/") {
                comment = false;
            }
        }

        clean
            .split(',')
            .filter_map(|field| {
                let name = field.split(':').next()?.trim();
                (!name.is_empty()).then(|| name.to_string())
            })
            .collect()
    }

    #[test]
    fn app_settings_json_matches_generated_typescript() {
        let value = serde_json::to_value(AppSettings::default()).expect("serialize settings");
        let object = value.as_object().expect("settings serialize to an object");
        let mut actual: Vec<String> = object.keys().cloned().collect();
        let mut expected = generated_fields("AppSettings");
        actual.sort();
        expected.sort();

        assert_eq!(
            actual, expected,
            "settings JSON keys drifted from the UI contract"
        );
        assert!(object.contains_key("maxCacheSizeGB"));
        assert!(object.contains_key("inspectorWidth"));
    }

    #[test]
    fn partial_settings_accepts_generated_typescript_keys() {
        let patch: PartialSettings = serde_json::from_str(
            r#"{"maxCacheSizeGB": 3, "inspectorWidth": 320, "appearance": "dark"}"#,
        )
        .expect("deserialize partial settings");

        assert_eq!(patch.max_cache_size_gb, Some(3));
        assert_eq!(patch.inspector_width, Some(320));
        assert_eq!(patch.appearance, Some(Appearance::Dark));
    }

    /// `Display`/`FromStr` drive the SQLite settings table, `Serialize` drives
    /// IPC. They must agree, or a saved setting changes meaning on reload.
    fn assert_round_trip<T>(values: &[T])
    where
        T: Serialize + std::str::FromStr + std::fmt::Display + PartialEq + std::fmt::Debug + Copy,
    {
        for value in values {
            let json = serde_json::to_value(value).expect("serialize enum");
            let text = json.as_str().expect("enum serializes to a string");
            assert_eq!(text, value.to_string(), "Display must match serde");
            assert_eq!(value.to_string().parse::<T>().ok(), Some(*value));
        }
    }

    #[test]
    fn setting_enums_serialize_consistently() {
        assert_round_trip(&[Appearance::Light, Appearance::Dark, Appearance::System]);
        assert_round_trip(&[
            AccentColor::Blue,
            AccentColor::Purple,
            AccentColor::Green,
            AccentColor::Orange,
            AccentColor::Pink,
            AccentColor::Red,
        ]);
        assert_round_trip(&[
            StartupView::Library,
            StartupView::Last,
            StartupView::Slideshow,
        ]);
        assert_round_trip(&[
            DefaultLayout::Grid,
            DefaultLayout::Details,
            DefaultLayout::Timeline,
        ]);
        assert_round_trip(&[
            ThumbnailSize::Small,
            ThumbnailSize::Medium,
            ThumbnailSize::Large,
        ]);
        assert_round_trip(&[
            ViewerZoomBehavior::Fit,
            ViewerZoomBehavior::Actual,
            ViewerZoomBehavior::Last,
        ]);
    }
}
