use crate::AppState;
use super::DuplicateGroup;
use super::MediaItem;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use tauri::{Emitter, State, Window};

#[tauri::command]
pub async fn cancel_find_duplicates() -> Result<(), String> {
    super::DUPLICATE_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn find_duplicates(
    state: State<'_, AppState>,
    window: Window,
) -> Result<Vec<DuplicateGroup>, String> {
    super::DUPLICATE_CANCEL.store(false, Ordering::SeqCst);
    let db = super::get_db(&state)?;

    // Load the catalog (hidden items included — a duplicate doesn't stop being
    // one just because it was hidden).
    let mut items: Vec<MediaItem> = sqlx::query_as::<_, MediaItem>("SELECT * FROM media_items")
        .fetch_all(&db)
        .await
        .map_err(|e| e.to_string())?;

    // Only files that share a size with at least one other file can be exact
    // duplicates, so hash only those — this keeps a full-library scan cheap.
    let mut size_counts: HashMap<i64, usize> = HashMap::new();
    for item in &items {
        *size_counts.entry(item.size).or_insert(0) += 1;
    }

    let candidates: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| size_counts.get(&item.size).copied().unwrap_or(0) > 1)
        .map(|(index, _)| index)
        .collect();

    // Emit initial progress for fingerprinting phase
    let _ = window.emit(
        "import-progress",
        json!({
            "phase": "hashing",
            "processed": 0,
            "total": candidates.len(),
            "currentFile": "Computing quick fingerprints…",
        }),
    );

    // Phase 1: Quick fingerprint (first 64KB + size) for all candidates.
    // Run in parallel batches to avoid blocking the executor.
    let mut quick_fingerprints: Vec<(usize, String)> = Vec::with_capacity(candidates.len());
    // Store prefixes for reuse in full hash phase (across all batches)
    let mut quick_prefixes: HashMap<usize, Vec<u8>> = HashMap::new();
    const FINGERPRINT_BATCH: usize = 50;
    for chunk in candidates.chunks(FINGERPRINT_BATCH) {
        if super::DUPLICATE_CANCEL.load(Ordering::SeqCst) {
            break;
        }
        // Process batch in blocking pool to avoid blocking executor
        let paths: Vec<(usize, String, u64)> = chunk
            .iter()
            .map(|&index| {
                let item = &items[index];
                (index, item.path.clone(), item.size as u64)
            })
            .collect();
        let fps = tokio::task::spawn_blocking(move || {
            paths
                .into_iter()
                .filter_map(|(index, path, size)| {
                    compute_quick_fingerprint(&path, size).map(|(fp, prefix)| (index, fp, prefix))
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| format!("Fingerprint task failed: {e}"))?;
        
        for (index, fp, prefix) in fps {
            quick_fingerprints.push((index, fp));
            quick_prefixes.insert(index, prefix);
        }

        let _ = window.emit(
            "import-progress",
            json!({
                "phase": "hashing",
                "processed": quick_fingerprints.len(),
                "total": candidates.len(),
                "currentFile": "Computing quick fingerprints…",
            }),
        );
        tokio::task::yield_now().await;
    }

    // Group by quick fingerprint. Only groups with >1 member need full SHA-256.
    let mut fp_groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, fp) in quick_fingerprints {
        fp_groups.entry(fp).or_default().push(index);
    }

    let full_hash_candidates: Vec<usize> = fp_groups
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .flat_map(|(_, v)| v)
        .collect();

    // Phase 2: Full SHA-256 only for files that share a quick fingerprint.
    // Use controlled concurrency (max 2 at a time) to avoid I/O saturation.
    use std::sync::Arc;
    use tokio::sync::Semaphore;

    let total = full_hash_candidates.len() as u64;
    
    let semaphore = Arc::new(Semaphore::new(2));
    let quick_prefixes = Arc::new(quick_prefixes);
    let mut hash_updates: Vec<(String, String)> = Vec::with_capacity(full_hash_candidates.len());
    let mut bytes_completed = 0u64;
    let mut processed = 0u64;

    // Emit progress for full hash phase start
    let _ = window.emit(
        "import-progress",
        json!({
            "phase": "hashing",
            "processed": 0,
            "total": full_hash_candidates.len(),
            "currentFile": "Computing full SHA-256…",
        }),
    );

    // Process with controlled concurrency
    let mut join_set = tokio::task::JoinSet::new();
    for &index in &full_hash_candidates {
        if super::DUPLICATE_CANCEL.load(Ordering::SeqCst) {
            break;
        }
        let path = items[index].path.clone();
        let name = items[index].name.clone();
        let size = items[index].size.max(0) as u64;
        let id = items[index].id.clone();
        let sem = semaphore.clone();
        let window_clone = window.clone();
        let prefixes = quick_prefixes.clone();

        join_set.spawn(async move {
            let _permit = sem.acquire().await.ok();
            if super::DUPLICATE_CANCEL.load(Ordering::SeqCst) {
                return None;
            }
            // Reuse cached prefix from quick fingerprint phase
            let prefix = prefixes.get(&index).cloned();
            let hash = compute_full_sha256_with_progress(
                path,
                name,
                size,
                0, // bytes_before not needed for individual task
                0,
                1,
                1,
                window_clone,
                prefix,
            )
            .await;
            Some((index, id, hash, size))
        });
    }

    while let Some(result) = join_set.join_next().await {
        if super::DUPLICATE_CANCEL.load(Ordering::SeqCst) {
            break;
        }
        if let Ok(Some((index, id, hash, size))) = result {
            if super::DUPLICATE_CANCEL.load(Ordering::SeqCst) {
                break;
            }
            processed += 1;
            if let Some(hash) = hash {
                hash_updates.push((id.clone(), hash.clone()));
                items[index].sha256 = Some(hash);
            }
            bytes_completed = bytes_completed.saturating_add(size);
            let _ = window.emit(
                "import-progress",
                json!({
                    "phase": "hashing",
                    "processed": processed,
                    "total": total,
                    "currentFile": "Computing full SHA-256…",
                }),
            );
            tokio::task::yield_now().await;
        }
    }

    // Persist newly computed hashes in one transaction. This avoids a durable
    // SQLite commit for every candidate while retaining each per-file hash.
    if !hash_updates.is_empty() {
        let mut transaction = db.begin().await.map_err(|e| e.to_string())?;
        for (id, hash) in hash_updates {
            sqlx::query("UPDATE media_items SET sha256 = ? WHERE id = ?")
                .bind(hash)
                .bind(id)
                .execute(&mut *transaction)
                .await
                .map_err(|e| e.to_string())?;
        }
        transaction.commit().await.map_err(|e| e.to_string())?;
    }

    // Group by content hash.
    let mut groups_map: HashMap<String, Vec<MediaItem>> = HashMap::new();
    for item in items {
        if let Some(hash) = item.sha256.clone().filter(|h| !h.is_empty()) {
            groups_map.entry(hash).or_default().push(item);
        }
    }

    let mut groups: Vec<DuplicateGroup> = groups_map
        .into_iter()
        .filter(|(_, v)| v.len() > 1)
        .map(|(hash, items)| DuplicateGroup {
            id: hash.clone(),
            sha256: hash,
            size: items.first().map(|i| i.size).unwrap_or(0),
            items,
        })
        .collect();

    // Largest duplicate groups first.
    groups.sort_by(|a, b| b.items.len().cmp(&a.items.len()).then(b.size.cmp(&a.size)));

    Ok(groups)
}

/// Two-phase duplicate detection:
/// 1. Quick fingerprint: first 64KB + file size — O(1) per file
/// 2. Full SHA-256 only for files that share a quick fingerprint.
///
/// This avoids reading entire multi-GB video files unless they actually
/// have a matching prefix + size, which is extremely rare.
fn compute_quick_fingerprint(path: &str, size: u64) -> Option<(String, Vec<u8>)> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 64 * 1024];
    let n = file.read(&mut buf).ok()?;
    if n == 0 && size > 0 {
        return None;
    }
    // Hash the first 64KB + file size.
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    ctx.update(&buf[..n]);
    ctx.update(&size.to_le_bytes());
    let fingerprint = hex::encode(ctx.finish().as_ref());
    // Return both fingerprint AND the prefix bytes for reuse in full hash
    Some((fingerprint, buf[..n].to_vec()))
}

/// Full SHA-256 with progress. Uses a 1MB buffer and async I/O for throughput.
/// Accepts an optional prefix (first 64KB) from the quick fingerprint phase
/// to avoid re-reading the beginning of the file.
async fn compute_full_sha256_with_progress(
    path: String,
    name: String,
    file_size: u64,
    bytes_before_file: u64,
    total_bytes: u64,
    file_number: u64,
    total_files: u64,
    window: Window,
    prefix: Option<Vec<u8>>,
) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(&path).await.ok()?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    
    // If we have a prefix from quick fingerprint, use it and skip those bytes
    if let Some(prefix) = prefix {
        ctx.update(&prefix);
        // Skip the prefix bytes in the file
        use tokio::io::AsyncSeekExt;
        file.seek(std::io::SeekFrom::Start(prefix.len() as u64)).await.ok()?;
    }
    
    // 1MB buffer for sequential throughput on SSD/NVMe (reduced from 64MB)
    let mut buf = vec![0u8; 1024 * 1024];
    let mut file_bytes = 0u64;
    let mut last_reported_bytes = 0u64;
    let mut last_reported_at = std::time::Instant::now();
    
    loop {
        if super::DUPLICATE_CANCEL.load(Ordering::SeqCst) {
            return None;
        }
        let n = file.read(&mut buf).await.ok()?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
        file_bytes = file_bytes.saturating_add(n as u64);
        let should_report = file_bytes.saturating_sub(last_reported_bytes) >= 64 * 1024 * 1024
            || last_reported_at.elapsed() >= std::time::Duration::from_millis(500);
        if should_report {
            let _ = window.emit(
                "import-progress",
                json!({
                    "phase": "hashing",
                    "processed": file_number.saturating_sub(1),
                    "total": total_files,
                    "filesProcessed": file_number.saturating_sub(1),
                    "filesTotal": total_files,
                    "bytesProcessed": bytes_before_file.saturating_add(file_bytes),
                    "bytesTotal": total_bytes,
                    "currentFile": &name,
                    "currentFileBytes": file_bytes,
                    "currentFileSize": file_size,
                }),
            );
            last_reported_bytes = file_bytes;
            last_reported_at = std::time::Instant::now();
        }
        tokio::task::yield_now().await;
    }
    let _ = window.emit(
        "import-progress",
        json!({
            "phase": "hashing",
            "processed": file_number,
            "total": total_files,
            "filesProcessed": file_number,
            "filesTotal": total_files,
            "bytesProcessed": bytes_before_file.saturating_add(file_bytes),
            "bytesTotal": total_bytes,
            "currentFile": &name,
            "currentFileBytes": file_bytes,
            "currentFileSize": file_size,
        }),
    );
    Some(hex::encode(ctx.finish().as_ref()))
}



