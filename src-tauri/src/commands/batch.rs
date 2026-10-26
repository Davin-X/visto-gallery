use super::*;
use std::path::PathBuf;
use walkdir::WalkDir;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn cancel_batch_export() -> Result<(), String> {
    super::BATCH_CANCEL.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn export_bytes(
    app: tauri::AppHandle,
    suggested_name: String,
    bytes: Vec<u8>,
    backup: Option<bool>,
) -> Result<String, String> {
    use std::io::Write;

    // 1. User confirms destination via native dialog (no arbitrary path from frontend)
    let picked = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter("JPEG Image", &["jpg", "jpeg"])
        .add_filter("PNG Image", &["png"])
        .add_filter("WebP Image", &["webp"])
        .add_filter("All Images", &["jpg", "jpeg", "png", "webp"])
        .blocking_save_file()
        .ok_or("Export cancelled by user")?;

    let path = picked.into_path().map_err(|e| e.to_string())?;

    // 2. Optional backup of existing file (only if user chose to replace)
    if backup.unwrap_or(false) && path.exists() {
        let bak = path.with_extension(format!(
            "{}.bak",
            path.extension().and_then(|s| s.to_str()).unwrap_or("bak")
        ));
        let _ = std::fs::copy(&path, &bak);
    }

    // 3. Atomic write: temp file next to destination, then rename
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;

    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod thumbnail_cache_tests {
    use super::library::{prune_thumbnail_cache, thumbnail_cache_key};
    use super::{prune_missing_items, upsert_media_batch, MediaItem};
    use std::collections::HashSet;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn requested_size_changes_cache_identity() {
        let small = thumbnail_cache_key("photo-1", 100, 2_000, 64);
        let large = thumbnail_cache_key("photo-1", 100, 2_000, 1024);

        assert_ne!(small, large);
        assert!(small.contains(":64:"));
        assert!(large.contains(":1024:"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn large_sources_use_the_native_downsample_path() {
        let root =
            std::env::temp_dir().join(format!("visto-gallery-thumb-sips-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test dir");
        let source = root.join("source.png");
        image::RgbaImage::from_pixel(64, 32, image::Rgba([40, 90, 150, 255]))
            .save(&source)
            .expect("write source image");
        let destination = root.join("thumb.jpg");

        let (bytes, width, height) = super::generate_cached_thumbnail(
            source.to_str().expect("source path"),
            &destination,
            32,
            super::LARGE_THUMBNAIL_SOURCE_BYTES,
        )
        .expect("sips should create a thumbnail");

        assert!(!bytes.is_empty());
        assert!(width <= 32 && height <= 32);
        assert!(destination.exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prune_keeps_cache_within_budget() {
        let root =
            std::env::temp_dir().join(format!("visto-gallery-thumb-cache-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create cache dir");
        for index in 0..3 {
            fs::write(root.join(format!("{index}.jpg")), [0_u8; 10]).expect("write cache file");
        }

        prune_thumbnail_cache(&root, 25);

        let total: u64 = fs::read_dir(&root)
            .expect("read cache dir")
            .flatten()
            .filter_map(|entry| entry.metadata().ok())
            .map(|metadata| metadata.len())
            .sum();
        assert!(total <= 25, "cache should be pruned below the budget");
        assert!(total > 0, "pruning should not remove everything");

        fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn prune_missing_items_removes_deleted_files() {
        use super::{prune_missing_items, upsert_media_batch, MediaItem};
        use sqlx::sqlite::SqlitePoolOptions;

        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        sqlx::query(
            "CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at INTEGER, width INTEGER, height INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, favorite INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, sha256 TEXT)",
        )
        .execute(&db)
        .await
        .expect("create media_items");
        sqlx::query(
            "CREATE TABLE media_tags (media_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (media_id, tag_id))",
        )
        .execute(&db)
        .await
        .expect("create media_tags");
        sqlx::query(
            "CREATE TABLE album_items (media_id TEXT NOT NULL, album_id TEXT NOT NULL, PRIMARY KEY (media_id, album_id))",
        )
        .execute(&db)
        .await
        .expect("create album_items");

        let root =
            std::env::temp_dir().join(format!("visto-gallery-prune-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test dir");

        // Create two real files
        let file1 = root.join("photo1.jpg");
        let file2 = root.join("photo2.jpg");
        fs::write(&file1, b"fake jpeg").unwrap();
        fs::write(&file2, b"fake jpeg").unwrap();

        // Insert three items: two with existing files, one with a deleted file
        let item1 = MediaItem::new(
            file1.to_string_lossy().into_owned(),
            "photo1.jpg".into(),
            "jpg".into(),
            "photo".into(),
            9,
            1000,
        );
        let item2 = MediaItem::new(
            file2.to_string_lossy().into_owned(),
            "photo2.jpg".into(),
            "jpg".into(),
            "photo".into(),
            9,
            1000,
        );
        let deleted_path = root.join("deleted.jpg").to_string_lossy().into_owned();
        let mut item3 = MediaItem::new(
            deleted_path.clone(),
            "deleted.jpg".into(),
            "jpg".into(),
            "photo".into(),
            9,
            1000,
        );
        upsert_media_batch(
            &db,
            &[
                (item1.clone(), None, None),
                (item2.clone(), None, None),
                (item3.clone(), None, None),
            ],
        )
        .await
        .expect("insert items");

        // Add some relations for item3
        sqlx::query("INSERT INTO media_tags (media_id, tag_id) VALUES (?, 'tag1')")
            .bind(&item3.id)
            .execute(&db)
            .await
            .expect("insert tag");
        sqlx::query("INSERT INTO album_items (media_id, album_id) VALUES (?, 'album1')")
            .bind(&item3.id)
            .execute(&db)
            .await
            .expect("insert album");

        // Prune with only file1 and file2 in seen_paths
        let mut seen = HashSet::new();
        seen.insert(file1.to_string_lossy().into_owned());
        seen.insert(file2.to_string_lossy().into_owned());

        let removed = prune_missing_items(&db, root.to_str().unwrap(), &seen)
            .await
            .expect("prune should succeed");
        assert_eq!(removed, 1, "should have removed the deleted file's row");

        // Verify item3 is gone from media_items
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_items WHERE id = ?")
            .bind(&item3.id)
            .fetch_one(&db)
            .await
            .expect("count item3");
        assert_eq!(count, 0);

        // Verify relations are also gone
        let tag_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = ?")
                .bind(&item3.id)
                .fetch_one(&db)
                .await
                .expect("count tags");
        assert_eq!(tag_count, 0);
        let album_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM album_items WHERE media_id = ?")
                .bind(&item3.id)
                .fetch_one(&db)
                .await
                .expect("count albums");
        assert_eq!(album_count, 0);

        // item1 and item2 should remain
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_items")
            .fetch_one(&db)
            .await
            .expect("count remaining");
        assert_eq!(remaining, 2);

        fs::remove_dir_all(&root).ok();
    }
}

#[cfg(test)]
mod batch_export_tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "visto-gallery-batch-test-{}-{}",
            label,
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    async fn perf_db() -> SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory perf database");
        sqlx::query(
            "CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at INTEGER, width INTEGER, height INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, favorite INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, sha256 TEXT)",
        )
        .execute(&db)
        .await
        .expect("create perf table");
        db
    }

    /// Manual microbenchmark of the real media inspection and SQLite write
    /// paths. Set VISTOGALLERY_PERF_ROOT to benchmark a real media folder; without
    /// it, the test creates a generated 10,000-image fixture. Run with:
    /// `cargo test scan_performance_benchmark -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "manual synthetic performance benchmark"]
    async fn scan_performance_benchmark() {
        const BATCH: usize = 100;
        let supplied_root = std::env::var_os("VISTOGALLERY_PERF_ROOT").map(PathBuf::from);
        let generated = supplied_root.is_none();
        let root = supplied_root.unwrap_or_else(|| temp_dir("scan-perf"));
        if generated {
            const FILES: usize = 10_000;
            let seed = root.join("seed.png");
            image::RgbaImage::from_pixel(8, 8, image::Rgba([80, 120, 160, 255]))
                .save(&seed)
                .expect("write seed image");
            for index in 0..FILES {
                std::fs::copy(&seed, root.join(format!("image-{index:05}.png")))
                    .expect("generate synthetic image");
            }
            std::fs::remove_file(seed).ok();
            // Exercise large-file size handling without allocating gigabytes
            // on disk or needing a codec-specific video sample.
            let large_video = root.join("large-video.mp4");
            std::fs::File::create(&large_video)
                .and_then(|file| file.set_len(2 * 1024 * 1024 * 1024))
                .expect("create sparse 2 GiB video fixture");
        }
        assert!(root.is_dir(), "performance fixture directory must exist");

        let paths: Vec<PathBuf> = WalkDir::new(&root)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| {
                let ext = entry
                    .path()
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                is_media_file(&ext)
            })
            .map(|entry| entry.into_path())
            .collect();
        assert!(
            !paths.is_empty(),
            "fixture contains no supported media files"
        );
        let photo_count = paths
            .iter()
            .filter(|path| {
                let ext = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                kind_for_ext(&ext) == "photo"
            })
            .count();
        let video_count = paths
            .iter()
            .filter(|path| {
                let ext = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                kind_for_ext(&ext) == "video"
            })
            .count();
        let now = now_ms();

        let legacy_db = perf_db().await;
        let legacy_start = std::time::Instant::now();
        for path in &paths {
            if let Some(row) = inspect_media_file(path, now) {
                upsert_media_batch(&legacy_db, std::slice::from_ref(&row))
                    .await
                    .expect("legacy per-file upsert");
            }
        }
        let legacy_elapsed = legacy_start.elapsed();

        let batch_db = perf_db().await;
        let batch_start = std::time::Instant::now();
        for chunk in paths.chunks(BATCH) {
            let rows: Vec<_> = chunk
                .iter()
                .filter_map(|path| inspect_media_file(path, now))
                .collect();
            upsert_media_batch(&batch_db, &rows)
                .await
                .expect("batched upsert");
        }
        let batch_elapsed = batch_start.elapsed();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_items")
            .fetch_one(&batch_db)
            .await
            .expect("count imported media");
        assert_eq!(count, paths.len() as i64);
        if generated {
            let large_video_size: i64 = sqlx::query_scalar(
                "SELECT size FROM media_items WHERE path LIKE '%large-video.mp4'",
            )
            .fetch_one(&batch_db)
            .await
            .expect("read large video size");
            assert_eq!(large_video_size, 2 * 1024 * 1024 * 1024);
        }
        let label = if generated {
            "generated fixture"
        } else {
            "provided media folder"
        };
        #[cfg(debug_assertions)]
        println!(
            "Scan {label}: {} photos, {video_count} videos: per-file writes {:.2}s; batches of {BATCH}: {:.2}s; speedup {:.2}x",
            photo_count,
            legacy_elapsed.as_secs_f64(),
            batch_elapsed.as_secs_f64(),
            legacy_elapsed.as_secs_f64() / batch_elapsed.as_secs_f64()
        );

        legacy_db.close().await;
        batch_db.close().await;
        if generated {
            std::fs::remove_dir_all(root).ok();
        }
    }

    fn test_item(source: &Path) -> BatchExportItem {
        BatchExportItem {
            id: "item-1".to_string(),
            source_path: source.to_string_lossy().to_string(),
            index: 0,
            kind: Some("photo".to_string()),
            date: Some(1_710_000_000_000),
        }
    }

    fn test_request(
        items: Vec<BatchExportItem>,
        folder: &Path,
        format: &str,
    ) -> BatchExportRequest {
        BatchExportRequest {
            items,
            output_folder: folder.to_string_lossy().to_string(),
            pattern: "{name}_{number}".to_string(),
            format: format.to_string(),
            quality: 0.85,
            strip_metadata: true,
            max_dimension: Some(10),
        }
    }

    #[test]
    fn renders_tokens_and_replaces_extension() {
        let item = BatchExportItem {
            id: "1".to_string(),
            source_path: "/tmp/My Photo.JPG".to_string(),
            index: 4,
            kind: Some("photo".to_string()),
            date: Some(1_710_000_000_000),
        };

        assert_eq!(
            render_batch_filename(&item, "{name}_{number}", Some(1_710_000_000_000), "jpg"),
            "My Photo_005.jpg"
        );
        assert_eq!(
            render_batch_filename(&item, "{date}-{name}.png", Some(1_710_000_000_000), "jpg"),
            "2024-03-09-My Photo.jpg"
        );
        assert_eq!(
            render_batch_filename(&item, "original.jpg", None, "webp"),
            "original.webp"
        );
    }

    #[test]
    fn exports_a_resized_jpeg() {
        let folder = temp_dir("resize");
        let source = folder.join("photo.png");
        image::RgbaImage::from_pixel(20, 10, image::Rgba([120, 30, 40, 255]))
            .save(&source)
            .expect("write source image");

        let item = test_item(&source);
        let request = test_request(vec![item.clone()], &folder, "jpeg");
        let mut used = HashSet::new();
        let output = export_batch_item(&item, &request, &folder, 85, &mut used)
            .expect("export should succeed");

        assert!(output.exists(), "output file should exist");
        assert_eq!(output.file_name().unwrap(), "photo_001.jpg");
        assert_eq!(image::image_dimensions(&output).unwrap(), (10, 5));

        std::fs::remove_dir_all(&folder).ok();
    }

    #[test]
    fn avoids_overwriting_existing_files() {
        let folder = temp_dir("collision");
        let source = folder.join("photo.png");
        image::RgbaImage::from_pixel(8, 8, image::Rgba([20, 40, 60, 255]))
            .save(&source)
            .expect("write source image");

        let item = test_item(&source);
        let request = test_request(vec![item.clone()], &folder, "png");
        let first = export_batch_item(&item, &request, &folder, 85, &mut HashSet::new())
            .expect("first export");
        let second = export_batch_item(&item, &request, &folder, 85, &mut HashSet::new())
            .expect("second export");

        assert_eq!(first.file_name().unwrap(), "photo_001.png");
        assert_eq!(second.file_name().unwrap(), "photo_001-2.png");
        assert!(first.exists() && second.exists());

        std::fs::remove_dir_all(&folder).ok();
    }

    #[test]
    fn copies_untouched_source_format() {
        let folder = temp_dir("copy");
        let source = folder.join("clip.mp4");
        std::fs::write(&source, b"not a real video, but a real file").expect("write source");

        let mut item = test_item(&source);
        item.kind = Some("video".to_string());
        let mut request = test_request(vec![item.clone()], &folder, "source");
        request.max_dimension = None;
        request.strip_metadata = false;

        let mut used = HashSet::new();
        let output = export_batch_item(&item, &request, &folder, 85, &mut used)
            .expect("video should copy unchanged");

        assert_eq!(
            std::fs::read(&output).unwrap(),
            std::fs::read(&source).unwrap()
        );
        std::fs::remove_dir_all(&folder).ok();
    }
}

#[tauri::command]
pub async fn batch_export(
    app: tauri::AppHandle,
    request: BatchExportRequest,
) -> Result<BatchExportResult, String> {
    // A new run always starts un-cancelled.
    super::BATCH_CANCEL.store(false, Ordering::SeqCst);

    let total = request.items.len() as u32;
    if total == 0 {
        return Err("Select at least one item to export.".to_string());
    }

    let folder = PathBuf::from(request.output_folder.trim());
    if request.output_folder.trim().is_empty() {
        return Err("Choose an output folder first.".to_string());
    }
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("Could not create the output folder: {}", e))?;
    if !folder.is_dir() {
        return Err("The chosen output location is not a folder.".to_string());
    }

    // Decoding and encoding are CPU/disk bound; keep them off the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        let mut outputs: Vec<String> = Vec::new();
        let mut failed: Vec<BatchExportError> = Vec::new();
        let mut used_names: HashSet<String> = HashSet::new();
        let quality = (request.quality * 100.0).round().clamp(1.0, 100.0) as u8;
        let mut cancelled = false;

        for (position, item) in request.items.iter().enumerate() {
            if super::BATCH_CANCEL.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }

            let label = Path::new(&item.source_path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&item.source_path)
                .to_string();

            match export_batch_item(item, &request, &folder, quality, &mut used_names) {
                Ok(path) => outputs.push(path.to_string_lossy().to_string()),
                Err(error) => failed.push(BatchExportError {
                    item_id: item.id.clone(),
                    error,
                }),
            }

            let _ = app.emit(
                "batch-progress",
                BatchExportProgress {
                    current: position as u32 + 1,
                    total,
                    current_file: label,
                },
            );
        }

        let processed = (outputs.len() + failed.len()) as u32;
        let _ = app.emit(
            "batch-progress",
            BatchExportProgress {
                current: processed,
                total,
                current_file: String::new(),
            },
        );

        Ok(BatchExportResult {
            exported: outputs.len() as u32,
            failed,
            outputs,
            cancelled,
        })
    })
    .await
    .map_err(|e| format!("Batch export stopped unexpectedly: {}", e))?
}
