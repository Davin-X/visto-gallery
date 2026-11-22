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

#[inline]
fn compute_item_hash(item: &MediaItem, item_thumbnails: &HashMap<String, PathBuf>) -> Option<u64> {
    if let Some(thumb_path) = item_thumbnails.get(&item.id) {
        if let Some(h) = dhash::compute_dhash_from_path(thumb_path) {
            return Some(h);
        }
    }
    let path = Path::new(&item.path);
    dhash::compute_dhash_from_path(path)
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

    let time_window_ms = opts.time_window_ms.unwrap_or(3500).clamp(500, 15_000);
    let max_dist = opts
        .max_hamming_distance
        .unwrap_or(BURST_MAX_HAMMING_DISTANCE)
        .clamp(0, 20);

    emit_progress(
        &window,
        json!({
            "phase": "analyzing",
            "processed": 0,
            "total": 0,
            "currentFile": "Loading photos for visual scan…",
        }),
    );

    // Create visual_hashes cache table if it doesn't exist
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS visual_hashes (
            item_id TEXT PRIMARY KEY,
            hash INTEGER NOT NULL,
            modified_at INTEGER NOT NULL
        )",
    )
    .execute(&db)
    .await?;

    // Query candidate photos and RAW originals
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

    let total = items.len();
    emit_progress(
        &window,
        json!({
            "phase": "analyzing",
            "processed": 0,
            "total": total,
            "currentFile": "Reading visual hash index…",
        }),
    );

    // Load existing cached hashes from SQLite
    let cached_rows: Vec<(String, i64, i64)> =
        sqlx::query_as("SELECT item_id, hash, modified_at FROM visual_hashes")
            .fetch_all(&db)
            .await
            .unwrap_or_default();

    let mut cached_map: HashMap<String, (u64, i64)> = HashMap::with_capacity(cached_rows.len());
    for (id, h, m) in cached_rows {
        cached_map.insert(id, (h as u64, m));
    }

    // Pre-index existing rendered thumbnails and previews once
    let mut item_thumbnails: HashMap<String, PathBuf> = HashMap::new();
    if let Ok(cache_root) = app.path().app_cache_dir() {
        for sub in [super::storage::THUMBNAILS_DIR, super::storage::PREVIEWS_DIR] {
            let dir = cache_root.join(sub);
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if let Some((item_id, _)) = name_str.split_once('.') {
                        item_thumbnails
                            .entry(item_id.to_string())
                            .or_insert_with(|| entry.path());
                    }
                }
            }
        }
    }

    let mut hashes: HashMap<String, u64> = HashMap::with_capacity(total);
    let mut uncached_items: Vec<MediaItem> = Vec::new();
    let mut processed = 0usize;
    let mut last_emit = Instant::now();

    for item in &items {
        if let Some(&(cached_h, cached_mtime)) = cached_map.get(&item.id) {
            if cached_mtime == item.modified_at {
                hashes.insert(item.id.clone(), cached_h);
                processed += 1;
                continue;
            }
        }
        uncached_items.push(item.clone());
    }

    if processed > 0 {
        emit_progress(
            &window,
            json!({
                "phase": "analyzing",
                "processed": processed,
                "total": total,
                "currentFile": "Restored visual index from database cache…",
            }),
        );
    }

    let mut new_hashes_to_persist: Vec<(String, u64, i64)> = Vec::new();

    if !uncached_items.is_empty() && !cancel.is_cancelled() {
        let num_workers = std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(4)
            .clamp(2, 8);

        let items_arc = std::sync::Arc::new(uncached_items);
        let thumbs_arc = std::sync::Arc::new(item_thumbnails);
        let (tx, rx) = std::sync::mpsc::channel();
        let chunk_size = (items_arc.len() + num_workers - 1) / num_workers;

        for w in 0..num_workers {
            let items_clone = std::sync::Arc::clone(&items_arc);
            let thumbs_clone = std::sync::Arc::clone(&thumbs_arc);
            let tx_clone = tx.clone();
            let start = w * chunk_size;
            let end = (start + chunk_size).min(items_clone.len());

            if start < end {
                std::thread::spawn(move || {
                    for i in start..end {
                        let it = &items_clone[i];
                        let h_opt = compute_item_hash(it, &thumbs_clone);
                        let _ =
                            tx_clone.send((it.id.clone(), h_opt, it.modified_at, it.name.clone()));
                    }
                });
            }
        }
        drop(tx);

        while let Ok((id, h_opt, mtime, name)) = rx.recv() {
            if cancel.is_cancelled() {
                break;
            }

            if let Some(h) = h_opt {
                hashes.insert(id.clone(), h);
                new_hashes_to_persist.push((id, h, mtime));
            }

            processed += 1;
            if last_emit.elapsed().as_millis() >= 150 || processed >= total {
                emit_progress(
                    &window,
                    json!({
                        "phase": "analyzing",
                        "processed": processed,
                        "total": total,
                        "currentFile": &name,
                    }),
                );
                last_emit = Instant::now();
            }
        }
    }

    // Persist new hashes in chunks to SQLite
    if !new_hashes_to_persist.is_empty() {
        for chunk in new_hashes_to_persist.chunks(500) {
            let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                "INSERT OR REPLACE INTO visual_hashes (item_id, hash, modified_at) ",
            );
            qb.push_values(chunk, |mut b, (id, h, mtime)| {
                b.push_bind(id).push_bind(*h as i64).push_bind(*mtime);
            });
            let _ = qb.build().execute(&db).await;
        }
    }

    emit_progress(
        &window,
        json!({
            "phase": "analyzing",
            "processed": total,
            "total": total,
            "currentFile": "Clustering near-duplicates and camera bursts…",
        }),
    );

    let mut groups: Vec<SimilarGroup> = Vec::new();
    let mut clustered_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    // -------------------------------------------------------------
    // PASS 1: Cross-Folder & Same-Scene Near-Duplicates (strict dist <= 6)
    // Detects original vs enhanced vs edited copies across folders.
    // -------------------------------------------------------------
    let near_dup_threshold = dhash::NEAR_DUPLICATE_MAX_HAMMING_DISTANCE.min(max_dist);
    let mut quality_ordered_items = items.clone();
    quality_ordered_items.sort_by(|a, b| {
        keeper_score(b)
            .cmp(&keeper_score(a))
            .then_with(|| a.path.cmp(&b.path))
    });

    for anchor in &quality_ordered_items {
        if clustered_ids.contains(&anchor.id) {
            continue;
        }
        let Some(&anchor_hash) = hashes.get(&anchor.id) else {
            continue;
        };

        let mut dup_cluster: Vec<MediaItem> = vec![anchor.clone()];
        let mut max_observed_dist = 0u32;

        for other in &quality_ordered_items {
            if other.id == anchor.id || clustered_ids.contains(&other.id) {
                continue;
            }
            let Some(&other_hash) = hashes.get(&other.id) else {
                continue;
            };

            let dist = dhash::hamming_distance(anchor_hash, other_hash);
            if dist <= near_dup_threshold {
                dup_cluster.push(other.clone());
                if dist > max_observed_dist {
                    max_observed_dist = dist;
                }
            }
        }

        if dup_cluster.len() >= 2 {
            for it in &dup_cluster {
                clustered_ids.insert(it.id.clone());
            }

            let confidence = ((64 - max_observed_dist) as f64) / 64.0;
            let status = if max_observed_dist <= 2 {
                "definite_duplicate".to_string()
            } else {
                "near_duplicate".to_string()
            };

            let (keeper_id, keeper_reason) = choose_keeper(&dup_cluster);
            let count = dup_cluster.len();
            let distinct_folders: std::collections::HashSet<&str> =
                dup_cluster.iter().map(|it| parent_dir(&it.path)).collect();

            let folder_context = if distinct_folders.len() > 1 {
                format!(" across {} folders", distinct_folders.len())
            } else {
                String::new()
            };

            let reason = format!(
                "Near-duplicate: {} visually matching photos ({:.0}% match){}. {}",
                count,
                confidence * 100.0,
                folder_context,
                keeper_reason
            );

            let group_id = format!("dup:{}", keeper_id);
            groups.push(SimilarGroup {
                id: group_id,
                group_type: "duplicate".to_string(),
                status,
                reason,
                keeper_id,
                confidence,
                time_span_ms: None,
                items: dup_cluster,
            });
        }
    }

    // -------------------------------------------------------------
    // PASS 2: Camera Bursts (time-proximate rapid shooting)
    // -------------------------------------------------------------
    let mut burst_candidates: Vec<MediaItem> = items
        .into_iter()
        .filter(|it| !clustered_ids.contains(&it.id) && hashes.contains_key(&it.id))
        .collect();

    burst_candidates.sort_by(|a, b| {
        a.camera
            .cmp(&b.camera)
            .then_with(|| parent_dir(&a.path).cmp(parent_dir(&b.path)))
            .then_with(|| item_time(a).cmp(&item_time(b)))
            .then_with(|| a.path.cmp(&b.path))
    });

    let mut i = 0usize;
    while i < burst_candidates.len() {
        if cancel.is_cancelled() {
            break;
        }

        let first = &burst_candidates[i];
        let start_time = item_time(first);
        let start_camera = &first.camera;
        let start_dir = parent_dir(&first.path);
        let first_hash = hashes[&first.id];

        let has_next_candidate = (i + 1 < burst_candidates.len()) && {
            let next = &burst_candidates[i + 1];
            next.camera == *start_camera
                && parent_dir(&next.path) == start_dir
                && same_dimensions(first, next)
                && item_time(next).saturating_sub(start_time) <= time_window_ms
        };

        if has_next_candidate {
            let mut verified_cluster: Vec<MediaItem> = vec![first.clone()];
            let mut verified_hashes: Vec<u64> = vec![first_hash];
            let mut j = i + 1;

            while j < burst_candidates.len() {
                let prev = &burst_candidates[j - 1];
                let cur = &burst_candidates[j];
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

                let cur_hash = hashes[&cur.id];
                let prev_hash = *verified_hashes.last().unwrap();
                let dist_prev = dhash::hamming_distance(prev_hash, cur_hash);
                let dist_first = dhash::hamming_distance(first_hash, cur_hash);

                if dist_prev <= max_dist && dist_first <= max_dist + 3 {
                    verified_cluster.push(cur.clone());
                    verified_hashes.push(cur_hash);
                    j += 1;
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
                continue;
            }
        }

        i += 1;
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
