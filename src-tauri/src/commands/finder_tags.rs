use std::collections::HashSet;

use tauri::State;

use crate::errors::CommandError;
use crate::AppState;

const FINDER_TAGS_ATTRIBUTE: &str = "com.apple.metadata:_kMDItemUserTags";

/** Base tag name without Finder's trailing `\0<color-index>` suffix. */
fn finder_tag_name(raw: &str) -> &str {
    raw.split('\x00').next().unwrap_or(raw)
}

/**
 * Merge app tags into the tags already present on a file.
 *
 * Existing Finder values (and their color suffix) are preserved verbatim and
 * stay first. Incoming tags are appended only when their case-insensitive name
 * is not already present, so a bulk copy never deletes a tag the user added in
 * Finder and never writes duplicates.
 */
fn merge_finder_tag_values(existing: &[String], incoming: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut merged = Vec::with_capacity(existing.len() + incoming.len());
    for raw in existing {
        let name = finder_tag_name(raw).trim();
        if name.is_empty() {
            continue;
        }
        if seen.insert(name.to_lowercase()) {
            merged.push(raw.clone());
        }
    }
    for tag in incoming {
        let name = tag.trim();
        if name.is_empty() {
            continue;
        }
        if seen.insert(name.to_lowercase()) {
            merged.push(format!("{}\x000", name));
        }
    }
    merged
}

fn read_raw_finder_tags(path: &str) -> Result<Vec<String>, CommandError> {
    let value = xattr::get(path, FINDER_TAGS_ATTRIBUTE)?;
    let Some(bytes) = value else {
        return Ok(vec![]);
    };
    let plist_value: plist::Value = plist::from_bytes(&bytes)?;
    let mut tags = Vec::new();
    if let Some(arr) = plist_value.as_array() {
        for value in arr {
            if let Some(raw) = value.as_string() {
                tags.push(raw.to_string());
            }
        }
    }
    Ok(tags)
}

fn write_raw_finder_tags(path: &str, tags: &[String]) -> Result<(), CommandError> {
    let plist_tags: Vec<plist::Value> = tags
        .iter()
        .map(|tag| plist::Value::String(tag.clone()))
        .collect();
    let mut buf = Vec::new();
    plist::to_writer_binary(&mut buf, &plist::Value::Array(plist_tags))?;
    xattr::set(path, FINDER_TAGS_ATTRIBUTE, &buf).map_err(CommandError::from)
}

#[tauri::command]
pub async fn write_finder_tags(
    path: String,
    tags: Vec<String>,
    _state: State<'_, AppState>,
) -> Result<(), CommandError> {
    tokio::task::spawn_blocking(move || {
        let values: Vec<String> = tags
            .into_iter()
            .filter(|tag| !tag.trim().is_empty())
            .map(|tag| format!("{}\x000", tag.trim()))
            .collect();
        write_raw_finder_tags(&path, &values)
    })
    .await?
}

/// Merge VistoGallery tags into a file's existing Finder tags and return the
/// merged display names. Never removes an existing Finder-only tag.
#[tauri::command]
pub async fn merge_finder_tags(
    path: String,
    tags: Vec<String>,
    _state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    tokio::task::spawn_blocking(move || {
        let existing = read_raw_finder_tags(&path)?;
        let merged = merge_finder_tag_values(&existing, &tags);
        write_raw_finder_tags(&path, &merged)?;
        Ok::<Vec<String>, CommandError>(
            merged
                .iter()
                .map(|raw| finder_tag_name(raw).trim().to_string())
                .filter(|name| !name.is_empty())
                .collect(),
        )
    })
    .await?
}

#[tauri::command]
pub async fn read_finder_tags(
    path: String,
    _state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    tokio::task::spawn_blocking(move || {
        let raw = read_raw_finder_tags(&path)?;
        let mut tags = Vec::new();
        let mut seen = HashSet::new();
        for value in raw {
            let name = finder_tag_name(&value).trim();
            if !name.is_empty() && seen.insert(name.to_lowercase()) {
                tags.push(name.to_string());
            }
        }
        Ok(tags)
    })
    .await?
}

#[cfg(test)]
mod finder_tag_merge_tests {
    use super::{finder_tag_name, merge_finder_tag_values};

    fn raw(name: &str) -> String {
        format!("{}\x000", name)
    }

    #[test]
    fn preserves_existing_tags_and_appends_new_ones() {
        let existing = vec![raw("Client"), raw("Paid")];
        let merged = merge_finder_tag_values(&existing, &["Travel".into(), "Paid".into()]);
        assert_eq!(
            merged,
            vec![raw("Client"), raw("Paid"), raw("Travel")],
            "existing tags stay first and duplicate app tags are skipped"
        );
    }

    #[test]
    fn deduplicates_case_insensitively_without_rewriting_existing_case() {
        let existing = vec![raw("Travel")];
        let merged = merge_finder_tag_values(&existing, &["travel".into(), "TRAVEL".into()]);
        assert_eq!(merged, vec![raw("Travel")]);
        assert_eq!(finder_tag_name(&merged[0]), "Travel");
    }

    #[test]
    fn ignores_empty_names_and_blank_app_tags() {
        let existing = vec!["\x000".to_string(), raw("Keep")];
        let merged = merge_finder_tag_values(&existing, &["  ".into(), "New".into()]);
        assert_eq!(merged, vec![raw("Keep"), raw("New")]);
    }

    #[test]
    fn empty_existing_tags_are_created_without_a_trailing_suffix() {
        let merged = merge_finder_tag_values(&[], &["Albums".into()]);
        assert_eq!(merged, vec![raw("Albums")]);
        assert_eq!(finder_tag_name(&merged[0]), "Albums");
    }
}
