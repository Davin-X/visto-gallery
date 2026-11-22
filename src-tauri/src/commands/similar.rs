//! Visual burst and near-duplicate photo detection.
//!
//! Unlike naive timestamp/filename clustering (which false-matches unrelated
//! photos downloaded or copied together), this module pairs capture-time
//! proximity with visual difference hashing (`dhash`). Photos are only grouped
//! if they are confirmed to be visually similar (Hamming distance <= 10).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State, Window};

use super::dhash::{self, BURST_MAX_HAMMING_DISTANCE};
use super::dto::{SimilarGroup, SimilarScanOptions};
use super::MediaItem;
use crate::errors::CommandError;

fn emit_progress(window: &tauri::Window, payload: serde_json::Value) {
    let _ = window.emit("similar-photos-progress", &payload);
    let _ = window.emit("import-progress", &payload);
}

fn parent_dir(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

#[inline]
fn item_time(item: &MediaItem) -> i64 {
    item.captured_at.unwrap_or(item.modified_at)
}

#[inline]
fn same_dimensions(a: &MediaItem, b: &MediaItem) -> bool {
    match (a.width, a.height, b.width, b.height) {
        (Some(w1), Some(h1), Some(w2), Some(h2)) => w1 == w2 && h1 == h2,
        _ => true,
    }
}

fn keeper_score(item: &MediaItem) -> (i32, i64, i64) {
    let ext = item.extension.to_ascii_lowercase();
    let format_rank = if item.kind == "raw" {
        5
    } else if ext == "tif" || ext == "tiff" {
        4
    } else if ext == "png" {
        3
    } else if ext == "jpg" || ext == "jpeg" || ext == "heic" || ext == "heif" {
        2
    } else {
        1
    };
    let pixels = (item.width.unwrap_or(0) as i64).max(0) * (item.height.unwrap_or(0) as i64).max(0);
    (format_rank, pixels, item.size.max(0))
}

fn choose_keeper(items: &[MediaItem]) -> (String, String) {
    let mut best = &items[0];
    let mut best_score = keeper_score(best);
    let mut best_time = best.captured_at.unwrap_or(best.modified_at);

    for item in &items[1..] {
        let score = keeper_score(item);
        let time = item.captured_at.unwrap_or(item.modified_at);
        if score > best_score
            || (score == best_score && time < best_time)
            || (score == best_score && time == best_time && item.path < best.path)
        {
            best = item;
            best_score = score;
            best_time = time;
        }
    }

    let reason = if best_score.0 >= 5 {
        "Suggested keeper: RAW original".to_string()
    } else if best_score.1 > 0 {
        "Suggested keeper: highest resolution".to_string()
    } else {
        "Suggested keeper: best quality".to_string()
    };

    (best.id.clone(), reason)
}

fn item_dhash(
    item: &MediaItem,
    item_thumbnails: &HashMap<String, PathBuf>,
    hash_cache: &mut HashMap<String, u64>,
) -> Option<u64> {
    if let Some(&h) = hash_cache.get(&item.id) {
        return Some(h);
    }

    if let Some(thumb_path) = item_thumbnails.get(&item.id) {
        if let Some(h) = dhash::compute_dhash_from_path(thumb_path) {
            hash_cache.insert(item.id.clone(), h);
            return Some(h);
        }
    }

    // Direct compute from source file
    let path = Path::new(&item.path);
    if let Some(h) = dhash::compute_dhash_from_path(path) {
        hash_cache.insert(item.id.clone(), h);
        Some(h)
    } else {
        None
    }
}

#[tauri::command]
pub async fn find_similar_photos(
    options: Option<SimilarScanOptions>,
    catalog: State<'_, crate::Catalog>,
    state: State<'_, crate::AppState>,
    app: AppHandle,
    window: Window,
) -> Result<Vec<SimilarGroup>, CommandError> {
    let cancel = state.similar_cancel.start();
    let db = super::get_db(&catalog)?;
    let opts = options.unwrap_or(SimilarScanOptions {
        time_window_ms: Some(2000),
        max_hamming_distance: Some(BURST_MAX_HAMMING_DISTANCE),
        scope: None,
        scope_item_ids: None,
    });

    let time_window_ms = opts.time_window_ms.unwrap_or(2000).clamp(500, 10_000);
    let max_dist = opts
        .max_hamming_distance
        .unwrap_or(BURST_MAX_HAMMING_DISTANCE)
        .clamp(0, 16);

    emit_progress(
        &window,
        json!({
            "phase": "analyzing",
            "processed": 0,
            "total": 0,
            "currentFile": "Loading photos for visual burst scan…",
        }),
    );

    // Query candidate photos and RAW originals (using capture time with modified_at fallback)
    let items: Vec<MediaItem> = if let Some(ids) = &opts.scope_item_ids {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT * FROM media_items WHERE hidden = 0 AND kind IN ('photo', 'raw') AND id IN (",
        );
        let mut separated = qb.separated(", ");
        for id in ids {
            separated.push_bind(id);
        }
        separated.push_unseparated(")");
        qb.build_query_as::<MediaItem>().fetch_all(&db).await?
    } else if let Some(scope_folder) = opts
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let folder = scope_folder.trim_end_matches('/');
        sqlx::query_as::<_, MediaItem>(
            "SELECT * FROM media_items WHERE hidden = 0 AND kind IN ('photo', 'raw') AND substr(path, 1, length(?) + 1) = ? || '/'",
        )
        .bind(folder)
        .bind(folder)
        .fetch_all(&db)
        .await?
    } else {
        sqlx::query_as::<_, MediaItem>(
            "SELECT * FROM media_items WHERE hidden = 0 AND kind IN ('photo', 'raw')",
        )
        .fetch_all(&db)
        .await?
    };

    if cancel.is_cancelled() {
        emit_progress(
            &window,
            json!({ "phase": "analyzing", "processed": 0, "total": 0, "cancelled": true }),
        );
        return Ok(vec![]);
    }

    let mut sorted_items = items;
    // Sort by camera model, parent folder, then capture timestamp and path
    sorted_items.sort_by(|a, b| {
        a.camera
            .cmp(&b.camera)
            .then_with(|| parent_dir(&a.path).cmp(parent_dir(&b.path)))
            .then_with(|| item_time(a).cmp(&item_time(b)))
            .then_with(|| a.path.cmp(&b.path))
    });

    let total = sorted_items.len();
    emit_progress(
        &window,
        json!({
            "phase": "analyzing",
            "processed": 0,
            "total": total,
            "currentFile": "Comparing visual gradients across bursts…",
        }),
    );

    let thumbnail_cache_dir = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|p| p.join(super::storage::THUMBNAILS_DIR));

    // Pre-index existing rendered thumbnails once to avoid scanning directory in tight loop
    let mut item_thumbnails: HashMap<String, PathBuf> = HashMap::new();
    if let Some(dir) = &thumbnail_cache_dir {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if let Some((item_id, _)) = name_str.split_once('.') {
                    item_thumbnails.insert(item_id.to_string(), entry.path());
                }
            }
        }
    }

    let mut dhash_cache: HashMap<String, u64> = HashMap::new();
    let mut groups: Vec<SimilarGroup> = Vec::new();
    let mut i = 0usize;
    let mut last_emit = Instant::now();

    while i < sorted_items.len() {
        if cancel.is_cancelled() {
            emit_progress(
                &window,
                json!({
                    "phase": "analyzing",
                    "processed": i,
                    "total": total,
                    "cancelled": true,
                }),
            );
            return Ok(groups);
        }

        let first = &sorted_items[i];
        let start_time = item_time(first);
        let start_camera = &first.camera;
        let start_dir = parent_dir(&first.path);

        // Fast check: does the immediate next photo share camera/dir, matching dimensions, and time <= time_window_ms?
        // Standalone photos with no neighbor in time window are skipped with zero disk reads!
        let has_next_candidate = (i + 1 < sorted_items.len()) && {
            let next = &sorted_items[i + 1];
            next.camera == *start_camera
                && parent_dir(&next.path) == start_dir
                && same_dimensions(first, next)
                && item_time(next).saturating_sub(start_time) <= time_window_ms
        };

        if has_next_candidate {
            if let Some(h1) = item_dhash(first, &item_thumbnails, &mut dhash_cache) {
                let mut verified_cluster: Vec<MediaItem> = vec![first.clone()];
                let mut verified_hashes: Vec<u64> = vec![h1];
                let mut j = i + 1;

                while j < sorted_items.len() {
                    let prev = &sorted_items[j - 1];
                    let cur = &sorted_items[j];
                    let prev_time = item_time(prev);
                    let cur_time = item_time(cur);

                    if cur.camera != *start_camera
                        || parent_dir(&cur.path) != start_dir
                        || !same_dimensions(first, cur)
                        || cur_time.saturating_sub(prev_time) > time_window_ms
                        || cur_time.saturating_sub(start_time) > time_window_ms.saturating_mul(10)
                    {
                        break;
                    }

                    if let Some(h_cur) = item_dhash(cur, &item_thumbnails, &mut dhash_cache) {
                        let prev_hash = *verified_hashes.last().unwrap();
                        let dist_prev = dhash::hamming_distance(prev_hash, h_cur);
                        let first_hash = verified_hashes[0];
                        let dist_first = dhash::hamming_distance(first_hash, h_cur);

                        if dist_prev <= max_dist && dist_first <= max_dist + 2 {
                            verified_cluster.push(cur.clone());
                            verified_hashes.push(h_cur);
                            j += 1;
                        } else {
                            break;
                        }
                    } else {
                        break;
                    }
                }

                if verified_cluster.len() >= 2 {
                    let first_item = &verified_cluster[0];
                    let last_item = verified_cluster.last().unwrap();
                    let time_span_ms = item_time(last_item).saturating_sub(item_time(first_item));

                    let mut max_observed_dist = 0u32;
                    for a in 0..verified_hashes.len() {
                        for b in (a + 1)..verified_hashes.len() {
                            let d = dhash::hamming_distance(verified_hashes[a], verified_hashes[b]);
                            if d > max_observed_dist {
                                max_observed_dist = d;
                            }
                        }
                    }

                    let confidence = ((64 - max_observed_dist) as f64) / 64.0;
                    let status = if max_observed_dist <= 6 {
                        "definite_burst".to_string()
                    } else {
                        "likely_similar".to_string()
                    };

                    let (keeper_id, keeper_reason) = choose_keeper(&verified_cluster);
                    let count = verified_cluster.len();
                    let span_secs = (time_span_ms as f64) / 1000.0;
                    let reason = format!(
                        "Burst: {} photos in {:.1}s ({:.0}% visual match). {}",
                        count,
                        span_secs,
                        confidence * 100.0,
                        keeper_reason
                    );

                    let group_id = format!("burst:{}:{}", keeper_id, start_time);
                    groups.push(SimilarGroup {
                        id: group_id,
                        group_type: "burst".to_string(),
                        status,
                        reason,
                        keeper_id,
                        confidence,
                        time_span_ms: Some(time_span_ms),
                        items: verified_cluster,
                    });

                    i = j;
                    if last_emit.elapsed().as_millis() >= 150 || i >= total {
                        emit_progress(
                            &window,
                            json!({
                                "phase": "analyzing",
                                "processed": i.min(total),
                                "total": total,
                                "currentFile": "Comparing visual gradients across bursts…",
                            }),
                        );
                        last_emit = Instant::now();
                    }
                    continue;
                }
            }
        }

        i += 1;

        if last_emit.elapsed().as_millis() >= 150 || i >= total {
            emit_progress(
                &window,
                json!({
                    "phase": "analyzing",
                    "processed": i.min(total),
                    "total": total,
                    "currentFile": "Comparing visual gradients across bursts…",
                }),
            );
            last_emit = Instant::now();
        }
    }

    emit_progress(
        &window,
        json!({
            "phase": "completed",
            "processed": total,
            "total": total,
            "currentFile": "Visual scan complete.",
        }),
    );

    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_kind::MediaKind;

    #[test]
    fn test_keeper_choice_prioritizes_resolution() {
        let mut item1 = MediaItem::new(
            "/photos/IMG_0001.jpg".into(),
            "IMG_0001.jpg".into(),
            "jpg".into(),
            MediaKind::Photo,
            2_000_000,
            1000,
        );
        item1.captured_at = Some(1000);
        item1.width = Some(2000);
        item1.height = Some(1000); // 2 MP
        item1.camera = Some("Sony A7IV".into());

        let mut item2 = item1.clone();
        item2.id = "2".into();
        item2.path = "/photos/IMG_0002.jpg".into();
        item2.width = Some(4000);
        item2.height = Some(3000); // 12 MP

        let cluster = vec![item1, item2];
        let (keeper_id, reason) = choose_keeper(&cluster);
        assert_eq!(keeper_id, "2");
        assert!(reason.contains("highest resolution"));
    }
}
