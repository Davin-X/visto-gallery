use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;
use ts_rs::TS;

use super::library::apply_item_tags;
use crate::errors::CommandError;

const MAX_XMP_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct XmpMetadata {
    pub captured_at: Option<i64>,
    pub title: Option<String>,
    pub keywords: Vec<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BatchMetadataRequest {
    pub item_ids: Vec<String>,
    /// When `Some`, sets `captured_at` (epoch ms, wall-clock UTC).
    pub captured_at: Option<i64>,
    /// When `Some`, sets `title` (empty/whitespace clears it).
    pub title: Option<String>,
    /// Keywords to apply according to `keywords_mode`.
    #[serde(default)]
    pub keywords: Vec<String>,
    /// `"add"` (default when keywords non-empty), `"replace"`, or `"remove"`.
    pub keywords_mode: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    #[serde(default)]
    pub clear_location: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BatchMetadataFailure {
    pub item_id: String,
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BatchMetadataResult {
    pub updated: usize,
    pub sidecars_written: usize,
    pub failed: Vec<BatchMetadataFailure>,
}

pub fn sidecar_path(media_path: &Path) -> PathBuf {
    media_path.with_extension("xmp")
}

fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

fn xml_unescape(input: &str) -> String {
    input
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Format epoch ms (wall-clock UTC, matching `parse_exif_datetime`) as ISO 8601.
fn format_xmp_datetime(ms: i64) -> Option<String> {
    let dt = time::OffsetDateTime::from_unix_timestamp(ms.div_euclid(1000)).ok()?;
    let fmt = time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");
    dt.format(&fmt).ok()
}

/// Parse ISO 8601 date/time from XMP into wall-clock UTC epoch ms.
fn parse_xmp_datetime(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.len() >= 19 {
        let head = &trimmed[..19];
        let iso =
            time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");
        let space =
            time::macros::format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");
        if let Ok(dt) = time::PrimitiveDateTime::parse(head, iso)
            .or_else(|_| time::PrimitiveDateTime::parse(head, space))
        {
            let ts = dt.assume_utc().unix_timestamp();
            if ts > 0 {
                return Some(ts * 1000);
            }
        }
    }
    // Date-only fallback: YYYY-MM-DD
    if trimmed.len() == 10 {
        let date_fmt = time::macros::format_description!("[year]-[month]-[day]");
        if let Ok(d) = time::Date::parse(trimmed, date_fmt) {
            let dt = d.midnight().assume_utc();
            if dt.unix_timestamp() > 0 {
                return Some(dt.unix_timestamp() * 1000);
            }
        }
    }
    None
}

/// Format decimal degrees as XMP GPSCoordinate: `DD,MM.MMMMMM{N|S|E|W}`.
fn format_xmp_gps(value: f64, pos_hemisphere: char, neg_hemisphere: char) -> String {
    let hemi = if value >= 0.0 {
        pos_hemisphere
    } else {
        neg_hemisphere
    };
    let abs = value.abs();
    let deg = abs.floor() as u32;
    let mins = (abs - deg as f64) * 60.0;
    format!("{deg},{mins:.6}{hemi}")
}

/// Parse XMP GPSCoordinate (`DD,MM.mmN`, `DD,MM,SS.ssN`, or decimal degrees).
fn parse_xmp_gps(text: &str, is_lat: bool) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    let last = trimmed.chars().last()?;
    let (body, sign) = match last {
        'N' | 'n' | 'E' | 'e' => (&trimmed[..trimmed.len() - 1], 1.0),
        'S' | 's' | 'W' | 'w' => (&trimmed[..trimmed.len() - 1], -1.0),
        _ => (trimmed, 1.0),
    };

    let value = if body.contains(',') {
        let parts: Vec<&str> = body.split(',').collect();
        match parts.as_slice() {
            [deg_s, min_s] => {
                let deg: f64 = deg_s.trim().parse().ok()?;
                let min: f64 = min_s.trim().parse().ok()?;
                sign * (deg.abs() + min / 60.0)
            }
            [deg_s, min_s, sec_s] => {
                let deg: f64 = deg_s.trim().parse().ok()?;
                let min: f64 = min_s.trim().parse().ok()?;
                let sec: f64 = sec_s.trim().parse().ok()?;
                sign * (deg.abs() + min / 60.0 + sec / 3600.0)
            }
            _ => return None,
        }
    } else {
        let raw: f64 = body.trim().parse().ok()?;
        if matches!(last, 'S' | 's' | 'W' | 'w') {
            -raw.abs()
        } else {
            raw
        }
    };

    if !value.is_finite() {
        return None;
    }
    let limit = if is_lat { 90.0 } else { 180.0 };
    if value.abs() > limit {
        return None;
    }
    Some(value)
}

fn extract_tag_body<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}");
    let start = xml.find(&open)?;
    let after_open = &xml[start + open.len()..];
    let gt = after_open.find('>')?;
    // Self-closing tag has no body.
    if gt > 0 && after_open.as_bytes()[gt - 1] == b'/' {
        return None;
    }
    let content = &after_open[gt + 1..];
    let close = format!("</{tag}>");
    let end = content.find(&close)?;
    Some(&content[..end])
}

fn extract_attr(xml: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = xml.find(&needle)?;
    let rest = &xml[start + needle.len()..];
    let end = rest.find('"')?;
    Some(xml_unescape(&rest[..end]))
}

fn extract_li_values(section: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut cursor = section;
    while let Some(pos) = cursor.find("<rdf:li") {
        let after = &cursor[pos + 7..];
        let Some(gt) = after.find('>') else { break };
        let body_start = &after[gt + 1..];
        let Some(end) = body_start.find("</rdf:li>") else {
            break;
        };
        let text = xml_unescape(body_start[..end].trim());
        if !text.is_empty() {
            values.push(text);
        }
        cursor = &body_start[end + 9..];
    }
    values
}

pub fn parse_xmp(xml: &str) -> XmpMetadata {
    let mut meta = XmpMetadata::default();

    for tag in [
        "xmp:CreateDate",
        "photoshop:DateCreated",
        "exif:DateTimeOriginal",
    ] {
        if let Some(raw) = extract_attr(xml, tag)
            .or_else(|| extract_tag_body(xml, tag).map(|s| xml_unescape(s.trim())))
        {
            if let Some(ms) = parse_xmp_datetime(&raw) {
                meta.captured_at = Some(ms);
                break;
            }
        }
    }

    if let Some(title_block) = extract_tag_body(xml, "dc:title") {
        if let Some(first) = extract_li_values(title_block).into_iter().next() {
            meta.title = Some(first);
        } else {
            let plain = xml_unescape(title_block.trim());
            if !plain.is_empty() && !plain.contains('<') {
                meta.title = Some(plain);
            }
        }
    }

    if let Some(subject_block) = extract_tag_body(xml, "dc:subject") {
        let mut seen = HashSet::new();
        for kw in extract_li_values(subject_block) {
            if seen.insert(kw.to_lowercase()) {
                meta.keywords.push(kw);
            }
        }
    }

    let lat_raw = extract_attr(xml, "exif:GPSLatitude")
        .or_else(|| extract_tag_body(xml, "exif:GPSLatitude").map(|s| xml_unescape(s.trim())));
    let lon_raw = extract_attr(xml, "exif:GPSLongitude")
        .or_else(|| extract_tag_body(xml, "exif:GPSLongitude").map(|s| xml_unescape(s.trim())));
    if let (Some(lat_s), Some(lon_s)) = (lat_raw, lon_raw) {
        if let (Some(lat), Some(lon)) = (parse_xmp_gps(&lat_s, true), parse_xmp_gps(&lon_s, false))
        {
            if !(lat == 0.0 && lon == 0.0) {
                meta.latitude = Some(lat);
                meta.longitude = Some(lon);
            }
        }
    }

    meta
}

pub fn render_xmp(meta: &XmpMetadata) -> String {
    let mut attrs = String::new();
    if let Some(ms) = meta.captured_at {
        if let Some(iso) = format_xmp_datetime(ms) {
            let escaped = xml_escape(&iso);
            attrs.push_str(&format!(
                "\n      xmp:CreateDate=\"{escaped}\"\n      photoshop:DateCreated=\"{escaped}\"\n      exif:DateTimeOriginal=\"{escaped}\""
            ));
        }
    }
    if let (Some(lat), Some(lon)) = (meta.latitude, meta.longitude) {
        let lat_s = format_xmp_gps(lat, 'N', 'S');
        let lon_s = format_xmp_gps(lon, 'E', 'W');
        attrs.push_str(&format!(
            "\n      exif:GPSLatitude=\"{lat_s}\"\n      exif:GPSLongitude=\"{lon_s}\""
        ));
    }

    let mut children = String::new();
    if let Some(title) = meta
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        children.push_str(&format!(
            "\n      <dc:title>\n        <rdf:Alt>\n          <rdf:li xml:lang=\"x-default\">{}</rdf:li>\n        </rdf:Alt>\n      </dc:title>",
            xml_escape(title)
        ));
    }
    if !meta.keywords.is_empty() {
        children.push_str("\n      <dc:subject>\n        <rdf:Bag>");
        for kw in &meta.keywords {
            let trimmed = kw.trim();
            if !trimmed.is_empty() {
                children.push_str(&format!(
                    "\n          <rdf:li>{}</rdf:li>",
                    xml_escape(trimmed)
                ));
            }
        }
        children.push_str("\n        </rdf:Bag>\n      </dc:subject>");
    }

    format!(
        "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n    <rdf:Description rdf:about=\"\"\n      xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n      xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n      xmlns:exif=\"http://ns.adobe.com/exif/1.0/\"\n      xmlns:photoshop=\"http://ns.adobe.com/photoshop/1.0/\"{attrs}>{children}\n    </rdf:Description>\n  </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>\n"
    )
}

pub fn read_xmp_sidecar(media_path: &Path) -> Option<XmpMetadata> {
    let xmp_path = sidecar_path(media_path);
    let meta = std::fs::metadata(&xmp_path).ok()?;
    if !meta.is_file() || meta.len() > MAX_XMP_BYTES {
        return None;
    }
    let content = std::fs::read_to_string(&xmp_path).ok()?;
    Some(parse_xmp(&content))
}

pub fn write_xmp_sidecar(media_path: &Path, meta: &XmpMetadata) -> Result<PathBuf, CommandError> {
    // shortcut: rewrites the sidecar with VistoGallery's 4 fields instead of merging unknown third-party XMP namespaces; upgrade to an XML DOM/stream patcher if Lightroom crs:* preservation is needed.
    let xmp_path = sidecar_path(media_path);
    let parent = xmp_path
        .parent()
        .ok_or_else(|| CommandError::invalid("Media file has no parent folder for XMP sidecar"))?;
    if !parent.is_dir() {
        return Err(CommandError::not_found(format!(
            "Parent folder does not exist: {}",
            parent.display()
        )));
    }

    let xml = render_xmp(meta);
    let tmp_name = format!(
        ".{}.tmp.{}",
        xmp_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("sidecar.xmp"),
        uuid::Uuid::new_v4()
    );
    let tmp_path = parent.join(tmp_name);
    std::fs::write(&tmp_path, xml.as_bytes()).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        CommandError::io(format!("Failed to write XMP sidecar: {e}"))
    })?;
    std::fs::rename(&tmp_path, &xmp_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        CommandError::io(format!("Failed to finalize XMP sidecar: {e}"))
    })?;
    Ok(xmp_path)
}

fn merge_keywords(existing: &[String], incoming: &[String], mode: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    match mode {
        "replace" => {
            for kw in incoming {
                let t = kw.trim();
                if !t.is_empty() && seen.insert(t.to_lowercase()) {
                    out.push(t.to_string());
                }
            }
        }
        "remove" => {
            let remove_set: HashSet<String> = incoming
                .iter()
                .map(|k| k.trim().to_lowercase())
                .filter(|k| !k.is_empty())
                .collect();
            for kw in existing {
                let t = kw.trim();
                if !t.is_empty()
                    && !remove_set.contains(&t.to_lowercase())
                    && seen.insert(t.to_lowercase())
                {
                    out.push(t.to_string());
                }
            }
        }
        _ => {
            for kw in existing.iter().chain(incoming.iter()) {
                let t = kw.trim();
                if !t.is_empty() && seen.insert(t.to_lowercase()) {
                    out.push(t.to_string());
                }
            }
        }
    }
    out
}

pub async fn run_batch_edit_metadata(
    db: &SqlitePool,
    req: &BatchMetadataRequest,
) -> Result<BatchMetadataResult, CommandError> {
    if req.item_ids.is_empty() {
        return Err(CommandError::invalid(
            "Select at least one item to update metadata",
        ));
    }

    let mode = req.keywords_mode.as_deref().unwrap_or("add");
    if !matches!(mode, "add" | "replace" | "remove") {
        return Err(CommandError::invalid(format!(
            "Unsupported keywords mode: {mode}"
        )));
    }

    let new_coords = match (req.clear_location, req.latitude, req.longitude) {
        (true, _, _) => Some(None),
        (false, Some(lat), Some(lon)) => {
            if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
                return Err(CommandError::invalid(
                    "Latitude must be between -90 and 90, and longitude between -180 and 180",
                ));
            }
            if lat == 0.0 && lon == 0.0 {
                return Err(CommandError::invalid(
                    "Coordinates (0, 0) are treated as missing GPS fix",
                ));
            }
            Some(Some((lat, lon)))
        }
        (false, None, None) => None,
        _ => {
            return Err(CommandError::invalid("Provide both latitude and longitude"));
        }
    };

    let mut updated = 0usize;
    let mut sidecars_written = 0usize;
    let mut failed = Vec::new();
    let now = super::now_ms();

    type MediaMetadataRow = (
        String,
        Option<i64>,
        Option<String>,
        Option<f64>,
        Option<f64>,
    );

    for item_id in &req.item_ids {
        let row: Option<MediaMetadataRow> = sqlx::query_as(
            "SELECT path, captured_at, title, latitude, longitude FROM media_items WHERE id = ?",
        )
        .bind(item_id)
        .fetch_optional(db)
        .await?;

        let Some((path, cur_captured_at, cur_title, cur_lat, cur_lon)) = row else {
            failed.push(BatchMetadataFailure {
                item_id: item_id.clone(),
                path: String::new(),
                error: "Item not found in catalog".to_string(),
            });
            continue;
        };

        let existing_tags: Vec<String> = sqlx::query_scalar(
            "SELECT t.name FROM tags t JOIN media_tags mt ON mt.tag_id = t.id WHERE mt.media_id = ? ORDER BY t.name COLLATE NOCASE",
        )
        .bind(item_id)
        .fetch_all(db)
        .await?;

        let next_captured_at = req.captured_at.or(cur_captured_at);
        let next_title = match &req.title {
            Some(t) => {
                let trimmed = t.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
            None => cur_title,
        };
        let next_keywords = if !req.keywords.is_empty() || mode == "replace" {
            merge_keywords(&existing_tags, &req.keywords, mode)
        } else {
            existing_tags.clone()
        };
        let (next_lat, next_lon) = match new_coords {
            Some(Some((lat, lon))) => (Some(lat), Some(lon)),
            Some(None) => (None, None),
            None => (cur_lat, cur_lon),
        };

        let xmp_meta = XmpMetadata {
            captured_at: next_captured_at,
            title: next_title.clone(),
            keywords: next_keywords.clone(),
            latitude: next_lat,
            longitude: next_lon,
        };

        let path_buf = PathBuf::from(&path);
        let write_res =
            tokio::task::spawn_blocking(move || write_xmp_sidecar(&path_buf, &xmp_meta))
                .await
                .map_err(|e| CommandError::internal(format!("XMP write task failed: {e}")))?;

        if let Err(err) = write_res {
            failed.push(BatchMetadataFailure {
                item_id: item_id.clone(),
                path,
                error: err.message,
            });
            continue;
        }
        sidecars_written += 1;

        sqlx::query(
            "UPDATE media_items SET captured_at = ?, title = ?, latitude = ?, longitude = ?, updated_at = ? WHERE id = ?",
        )
        .bind(next_captured_at)
        .bind(&next_title)
        .bind(next_lat)
        .bind(next_lon)
        .bind(now)
        .bind(item_id)
        .execute(db)
        .await?;

        if next_keywords != existing_tags {
            apply_item_tags(db, item_id, &next_keywords).await?;
        }
        updated += 1;
    }

    Ok(BatchMetadataResult {
        updated,
        sidecars_written,
        failed,
    })
}

#[tauri::command]
pub async fn batch_edit_metadata(
    request: BatchMetadataRequest,
    catalog: State<'_, crate::Catalog>,
) -> Result<BatchMetadataResult, CommandError> {
    let db = super::get_db(&catalog)?;
    run_batch_edit_metadata(&db, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xmp_roundtrip_preserves_fields_and_escapes_xml() {
        let meta = XmpMetadata {
            captured_at: Some(1_732_540_133_000), // 2024-11-25T13:08:53Z
            title: Some("Sunrise & <Sea>".to_string()),
            keywords: vec!["travel".to_string(), "coast & cliff".to_string()],
            latitude: Some(37.7749),
            longitude: Some(-122.4194),
        };
        let xml = render_xmp(&meta);
        let parsed = parse_xmp(&xml);
        assert_eq!(parsed.captured_at, meta.captured_at);
        assert_eq!(parsed.title, meta.title);
        assert_eq!(parsed.keywords, meta.keywords);
        assert!((parsed.latitude.unwrap() - 37.7749).abs() < 1e-4);
        assert!((parsed.longitude.unwrap() - (-122.4194)).abs() < 1e-4);
    }

    #[tokio::test]
    async fn batch_edit_writes_sidecars_without_touching_originals() {
        let dir = std::env::temp_dir().join(format!("visto-xmp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let photo_path = dir.join("DSC_0001.NEF");
        let original_bytes = b"RAW_BYTES_MUST_NOT_CHANGE";
        std::fs::write(&photo_path, original_bytes).unwrap();

        let db = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES ('item-1', ?, 'DSC_0001.NEF', 'nef', 'raw', 25, 100, 100, 100)",
        )
        .bind(photo_path.to_string_lossy().to_string())
        .execute(&db)
        .await
        .unwrap();

        let req = BatchMetadataRequest {
            item_ids: vec!["item-1".to_string()],
            captured_at: Some(1_700_000_000_000),
            title: Some("Golden Hour".to_string()),
            keywords: vec!["landscape".to_string(), "sunset".to_string()],
            keywords_mode: Some("add".to_string()),
            latitude: Some(35.6762),
            longitude: Some(139.6503),
            clear_location: false,
        };
        let res = run_batch_edit_metadata(&db, &req).await.unwrap();
        assert_eq!(res.updated, 1);
        assert_eq!(res.sidecars_written, 1);
        assert!(res.failed.is_empty());

        // Original file is untouched.
        assert_eq!(std::fs::read(&photo_path).unwrap(), original_bytes);

        // XMP sidecar exists and parses cleanly.
        let parsed = read_xmp_sidecar(&photo_path).unwrap();
        assert_eq!(parsed.title.as_deref(), Some("Golden Hour"));
        assert_eq!(parsed.keywords, vec!["landscape", "sunset"]);
        assert_eq!(parsed.captured_at, Some(1_700_000_000_000));
        assert!((parsed.latitude.unwrap() - 35.6762).abs() < 1e-4);

        // SQLite catalog is updated too.
        let (title, lat): (Option<String>, Option<f64>) =
            sqlx::query_as("SELECT title, latitude FROM media_items WHERE id = 'item-1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(title.as_deref(), Some("Golden Hour"));
        assert_eq!(lat, Some(35.6762));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
