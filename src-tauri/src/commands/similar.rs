//! Visual burst and near-duplicate photo detection.
//!
//! Unlike naive timestamp/filename clustering (which false-matches unrelated
//! photos downloaded or copied together), this module pairs capture-time
//! proximity with 2D difference hashing and mean RGB color profiling (`VisualFingerprint`).
//! Photos are only grouped if their visual structure and color profiles match.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State, Window};

use super::dhash::{self, VisualFingerprint, BURST_MAX_HAMMING_DISTANCE};
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

use crate::commands::parse_filename_timestamp;

#[inline]
fn item_time(item: &MediaItem) -> (i64, bool) {
    if let Some(t) = item.captured_at {
        return (t, true);
    }
    if let Some(t) = parse_filename_timestamp(&item.name) {
        return (t, true);
    }
    (item.modified_at, false)
}

#[inline]
fn normalize_stem(stem: &str) -> &str {
    let s = stem.trim_start_matches('_');
    if s.len() > 4
        && (s.starts_with("IMG_")
            || s.starts_with("img_")
            || s.starts_with("DSC_")
            || s.starts_with("dsc_"))
    {
        &s[4..]
    } else if s.len() > 3 && (s.starts_with("MG_") || s.starts_with("mg_")) {
        &s[3..]
    } else {
        s
    }
}

/// Detects whether two items represent a camera RAW + JPEG/HEIC companion pair of the same capture.
/// Such pairs are related formats, not duplicates or burst candidates to be pruned.
pub fn is_raw_jpeg_pair(a: &MediaItem, b: &MediaItem) -> bool {
    let one_raw = (a.kind == "raw" && b.kind == "photo") || (a.kind == "photo" && b.kind == "raw");
    if !one_raw {
        return false;
    }

    if let (Some(c1), Some(c2)) = (&a.camera, &b.camera) {
        if !c1.is_empty() && !c2.is_empty() && c1 != c2 {
            return false;
        }
    }

    let stem_a = Path::new(&a.name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let stem_b = Path::new(&b.name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let norm_a = normalize_stem(stem_a);
    let norm_b = normalize_stem(stem_b);
    let same_stem = !norm_a.is_empty() && norm_a.eq_ignore_ascii_case(norm_b);

    let (time_a, _) = item_time(a);
    let (time_b, _) = item_time(b);
    let time_diff_ms = (time_a - time_b).abs();

    let same_folder = parent_dir(&a.path) == parent_dir(&b.path);

    if same_stem {
        if same_folder {
            return time_diff_ms <= 10_000;
        } else {
            return time_diff_ms <= 3_000;
        }
    }

    if same_folder && time_diff_ms <= 1_000 {
        if let (Some(w1), Some(h1), Some(w2), Some(h2)) = (a.width, a.height, b.width, b.height) {
            if w1 > 0 && h1 > 0 && w2 > 0 && h2 > 0 {
                let ratio1 = (w1 as f64) / (h1 as f64);
                let ratio2 = (w2 as f64) / (h2 as f64);
                if (ratio1 - ratio2).abs() < 0.05 {
                    return true;
                }
            }
        }
    }

    false
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
    let mut best_time = item_time(best).0;

    for item in &items[1..] {
        let score = keeper_score(item);
        let time = item_time(item).0;
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
fn compute_item_fingerprint(
    item: &MediaItem,
    item_thumbnails: &HashMap<String, PathBuf>,
) -> Option<VisualFingerprint> {
    if let Some(thumb_path) = item_thumbnails.get(&item.id) {
        if let Some(fp) = dhash::compute_fingerprint_from_path(thumb_path) {
            return Some(fp);
        }
    }
    let path = Path::new(&item.path);
    dhash::compute_fingerprint_from_path(path)
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
    let settings = super::settings::load_persisted_settings(&db)
        .await
        .unwrap_or_default();
    let guard_raw_jpeg = settings.pair_raw_jpeg;
    let opts = options.unwrap_or(SimilarScanOptions {
        time_window_ms: Some(2000),
        max_hamming_distance: Some(BURST_MAX_HAMMING_DISTANCE),
        scope: None,
        scope_item_ids: None,
    });

    let time_window_ms = opts.time_window_ms.unwrap_or(3500).clamp(500, 15_000);

    emit_progress(
        &window,
        json!({
            "phase": "analyzing",
            "processed": 0,
            "total": 0,
            "currentFile": "Loading photos for visual scan…",
        }),
    );

    // Create visual_fingerprints cache table if it doesn't exist
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS visual_fingerprints (
            item_id TEXT PRIMARY KEY,
            h_hash INTEGER NOT NULL,
            v_hash INTEGER NOT NULL,
            rgb INTEGER NOT NULL,
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
            "currentFile": "Reading visual fingerprint index…",
        }),
    );

    // Load existing cached fingerprints from SQLite
    let cached_rows: Vec<(String, i64, i64, i64, i64)> =
        sqlx::query_as("SELECT item_id, h_hash, v_hash, rgb, modified_at FROM visual_fingerprints")
            .fetch_all(&db)
            .await
            .unwrap_or_default();

    let mut cached_map: HashMap<String, (VisualFingerprint, i64)> =
        HashMap::with_capacity(cached_rows.len());
    for (id, h, v, rgb, m) in cached_rows {
        cached_map.insert(
            id,
            (
                VisualFingerprint {
                    h_hash: h as u64,
                    v_hash: v as u64,
                    rgb: rgb as u32,
                },
                m,
            ),
        );
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

    let mut fingerprints: HashMap<String, VisualFingerprint> = HashMap::with_capacity(total);
    let mut uncached_items: Vec<MediaItem> = Vec::new();
    let mut processed = 0usize;
    let mut last_emit = Instant::now();

    for item in &items {
        if let Some(&(cached_fp, cached_mtime)) = cached_map.get(&item.id) {
            if cached_mtime == item.modified_at {
                fingerprints.insert(item.id.clone(), cached_fp);
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
                "currentFile": "Restored visual fingerprints from cache…",
            }),
        );
    }

    let mut new_fps_to_persist: Vec<(String, VisualFingerprint, i64)> = Vec::new();

    if !uncached_items.is_empty() && !cancel.is_cancelled() {
        let num_workers = std::thread::available_parallelism()
            .map(|p| p.get())
            .unwrap_or(4)
            .clamp(2, 8);

        let items_arc = std::sync::Arc::new(uncached_items);
        let thumbs_arc = std::sync::Arc::new(item_thumbnails);
        let (tx, rx) = std::sync::mpsc::channel();
        let chunk_size = items_arc.len().div_ceil(num_workers);

        for w in 0..num_workers {
            let items_clone = std::sync::Arc::clone(&items_arc);
            let thumbs_clone = std::sync::Arc::clone(&thumbs_arc);
            let tx_clone = tx.clone();
            let cancel_flag = cancel.flag();
            let start = w * chunk_size;
            let end = (start + chunk_size).min(items_clone.len());

            if start < end {
                std::thread::spawn(move || {
                    for i in start..end {
                        if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                            break;
                        }
                        let it = &items_clone[i];
                        let fp_opt = compute_item_fingerprint(it, &thumbs_clone);
                        if tx_clone
                            .send((it.id.clone(), fp_opt, it.modified_at, it.name.clone()))
                            .is_err()
                        {
                            break;
                        }
                    }
                });
            }
        }
        drop(tx);

        loop {
            if cancel.is_cancelled() {
                break;
            }
            match rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok((id, fp_opt, mtime, name)) => {
                    if let Some(fp) = fp_opt {
                        fingerprints.insert(id.clone(), fp);
                        new_fps_to_persist.push((id, fp, mtime));
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
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    if cancel.is_cancelled() {
        return Ok(vec![]);
    }

    // Persist new fingerprints in chunks to SQLite
    if !new_fps_to_persist.is_empty() {
        for chunk in new_fps_to_persist.chunks(500) {
            let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                "INSERT OR REPLACE INTO visual_fingerprints (item_id, h_hash, v_hash, rgb, modified_at) ",
            );
            qb.push_values(chunk, |mut b, (id, fp, mtime)| {
                b.push_bind(id)
                    .push_bind(fp.h_hash as i64)
                    .push_bind(fp.v_hash as i64)
                    .push_bind(fp.rgb as i64)
                    .push_bind(*mtime);
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
    // PASS 1: Cross-Folder & Same-Scene Near-Duplicates
    // Uses 128-bit 2D dHash + Mean RGB color profile
    // -------------------------------------------------------------
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
        let Some(&anchor_fp) = fingerprints.get(&anchor.id) else {
            continue;
        };

        let mut dup_cluster: Vec<MediaItem> = vec![anchor.clone()];
        let mut min_confidence = 1.0f64;

        for other in &quality_ordered_items {
            if other.id == anchor.id || clustered_ids.contains(&other.id) {
                continue;
            }
            if guard_raw_jpeg
                && dup_cluster
                    .iter()
                    .any(|existing| is_raw_jpeg_pair(existing, other))
            {
                continue;
            }
            let Some(&other_fp) = fingerprints.get(&other.id) else {
                continue;
            };

            if anchor_fp.is_near_duplicate(&other_fp) {
                let (grad_dist, color_diff) = anchor_fp.distance(&other_fp);
                let pair_conf =
                    (1.0 - (grad_dist as f64 / 128.0) * 0.7 - (color_diff as f64 / 255.0) * 0.3)
                        .clamp(0.0, 1.0);
                if pair_conf < min_confidence {
                    min_confidence = pair_conf;
                }
                dup_cluster.push(other.clone());
            }
        }

        if dup_cluster.len() >= 2 {
            for it in &dup_cluster {
                clustered_ids.insert(it.id.clone());
            }

            let (keeper_id, keeper_reason) = choose_keeper(&dup_cluster);
            let count = dup_cluster.len();
            let distinct_folders: std::collections::HashSet<&str> =
                dup_cluster.iter().map(|it| parent_dir(&it.path)).collect();

            let folder_context = if distinct_folders.len() > 1 {
                format!(" across {} folders", distinct_folders.len())
            } else {
                String::new()
            };

            let status = if min_confidence >= 0.94 {
                "definite_duplicate".to_string()
            } else {
                "near_duplicate".to_string()
            };

            let reason = format!(
                "Near-duplicate: {} visually matching photos ({:.0}% match){}. {}",
                count,
                min_confidence * 100.0,
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
                confidence: min_confidence,
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
        .filter(|it| !clustered_ids.contains(&it.id) && fingerprints.contains_key(&it.id))
        .collect();

    burst_candidates.sort_by(|a, b| {
        a.camera
            .cmp(&b.camera)
            .then_with(|| parent_dir(&a.path).cmp(parent_dir(&b.path)))
            .then_with(|| item_time(a).0.cmp(&item_time(b).0))
            .then_with(|| a.path.cmp(&b.path))
    });

    let mut i = 0usize;
    while i < burst_candidates.len() {
        if cancel.is_cancelled() {
            break;
        }

        let first = &burst_candidates[i];
        let (start_time, first_is_capture) = item_time(first);
        let start_camera = &first.camera;
        let start_dir = parent_dir(&first.path);
        let first_fp = fingerprints[&first.id];

        let has_next_candidate = (i + 1 < burst_candidates.len()) && {
            let next = &burst_candidates[i + 1];
            let (next_time, next_is_capture) = item_time(next);
            (first_is_capture || next_is_capture || start_camera.is_some())
                && next.camera == *start_camera
                && parent_dir(&next.path) == start_dir
                && same_dimensions(first, next)
                && next_time.saturating_sub(start_time) <= time_window_ms
        };

        if has_next_candidate {
            let mut verified_cluster: Vec<MediaItem> = vec![first.clone()];
            let mut verified_fps: Vec<VisualFingerprint> = vec![first_fp];
            let mut j = i + 1;

            while j < burst_candidates.len() {
                let prev = &burst_candidates[j - 1];
                let cur = &burst_candidates[j];
                let (prev_time, _) = item_time(prev);
                let (cur_time, _) = item_time(cur);

                if cur.camera != *start_camera
                    || parent_dir(&cur.path) != start_dir
                    || !same_dimensions(first, cur)
                    || cur_time.saturating_sub(prev_time) > time_window_ms
                    || cur_time.saturating_sub(start_time) > time_window_ms.saturating_mul(10)
                {
                    break;
                }

                if guard_raw_jpeg && verified_cluster.iter().any(|it| is_raw_jpeg_pair(it, cur)) {
                    j += 1;
                    continue;
                }

                let cur_fp = fingerprints[&cur.id];
                let prev_fp = *verified_fps.last().unwrap();
                let (dist_first, color_first) = first_fp.distance(&cur_fp);

                if prev_fp.is_burst_similar(&cur_fp) && dist_first <= 28 && color_first <= 26 {
                    verified_cluster.push(cur.clone());
                    verified_fps.push(cur_fp);
                    j += 1;
                } else {
                    break;
                }
            }

            if verified_cluster.len() >= 2 {
                let first_item = &verified_cluster[0];
                let last_item = verified_cluster.last().unwrap();
                let time_span_ms = item_time(last_item)
                    .0
                    .saturating_sub(item_time(first_item).0);

                let mut max_observed_grad = 0u32;
                let mut max_observed_color = 0u32;
                for a in 0..verified_fps.len() {
                    for b in (a + 1)..verified_fps.len() {
                        let (g, c) = verified_fps[a].distance(&verified_fps[b]);
                        if g > max_observed_grad {
                            max_observed_grad = g;
                        }
                        if c > max_observed_color {
                            max_observed_color = c;
                        }
                    }
                }

                let confidence = (1.0
                    - (max_observed_grad as f64 / 128.0) * 0.7
                    - (max_observed_color as f64 / 255.0) * 0.3)
                    .clamp(0.0, 1.0);

                let status = if max_observed_grad <= 12 && max_observed_color <= 10 {
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
    fn test_parse_filename_timestamp() {
        let ts = parse_filename_timestamp("2026-07-12_14-18-40_Devansh_On_Bed_edited.jpg");
        assert!(ts.is_some());
        let ts2 = parse_filename_timestamp("IMG_20260712_141840.jpg");
        assert!(ts2.is_some());
        let none = parse_filename_timestamp("unrelated_photo.jpg");
        assert!(none.is_none());
    }

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

    #[test]
    fn test_is_raw_jpeg_pair() {
        let raw = MediaItem::new(
            "/photos/Trip/IMG_0001.CR2".into(),
            "IMG_0001.CR2".into(),
            "cr2".into(),
            MediaKind::Raw,
            25_000_000,
            1700000000000,
        );
        let mut jpg = MediaItem::new(
            "/photos/Trip/IMG_0001.JPG".into(),
            "IMG_0001.JPG".into(),
            "jpg".into(),
            MediaKind::Photo,
            5_000_000,
            1700000000000,
        );
        jpg.captured_at = Some(1700000000000);

        let mut raw_with_time = raw.clone();
        raw_with_time.captured_at = Some(1700000000000);

        // 1. Identical stem in same folder: true
        assert!(is_raw_jpeg_pair(&raw_with_time, &jpg));
        assert!(is_raw_jpeg_pair(&jpg, &raw_with_time));

        // 2. Canon AdobeRGB prefix _MG_ vs IMG_: true
        let mut canon_raw = raw_with_time.clone();
        canon_raw.name = "_MG_0001.CR2".into();
        canon_raw.path = "/photos/Trip/_MG_0001.CR2".into();
        assert!(is_raw_jpeg_pair(&canon_raw, &jpg));

        // 3. Cross-folder (e.g. RAW/ vs JPG/): true when close in time
        let mut cross_folder_raw = raw_with_time.clone();
        cross_folder_raw.path = "/photos/Trip/RAW/IMG_0001.CR2".into();
        let mut cross_folder_jpg = jpg.clone();
        cross_folder_jpg.path = "/photos/Trip/JPG/IMG_0001.JPG".into();
        assert!(is_raw_jpeg_pair(&cross_folder_raw, &cross_folder_jpg));

        // 4. Reject if both are raw or both are photo
        let mut raw_copy = raw_with_time.clone();
        raw_copy.path = "/photos/Trip/IMG_0001_copy.CR2".into();
        assert!(!is_raw_jpeg_pair(&raw_with_time, &raw_copy));

        let mut jpg_copy = jpg.clone();
        jpg_copy.path = "/photos/Trip/IMG_0001_copy.JPG".into();
        assert!(!is_raw_jpeg_pair(&jpg, &jpg_copy));

        // 5. Reject if capture time differs significantly (> 10s)
        let mut distant_jpg = jpg.clone();
        distant_jpg.captured_at = Some(1700000050000);
        distant_jpg.modified_at = 1700000050000;
        assert!(!is_raw_jpeg_pair(&raw_with_time, &distant_jpg));

        // 6. Reject if cameras explicitly differ
        let mut cam_raw = raw_with_time.clone();
        cam_raw.camera = Some("Canon EOS 5D Mark IV".into());
        let mut cam_jpg = jpg.clone();
        cam_jpg.camera = Some("Sony A7R V".into());
        assert!(!is_raw_jpeg_pair(&cam_raw, &cam_jpg));
    }
}
