use super::*;

mod split_source_tests {
    use super::split_source_folder;
    use std::fs;

    #[test]
    fn lists_visible_subfolders_and_counts_loose_media() {
        let root = std::env::temp_dir().join(format!("visto-split-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("Trip")).unwrap();
        fs::create_dir_all(root.join("Album")).unwrap();
        fs::create_dir_all(root.join(".cache")).unwrap();
        fs::write(root.join("a.jpg"), b"x").unwrap();
        fs::write(root.join("b.MOV"), b"x").unwrap();
        fs::write(root.join("notes.txt"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("Trip"), root.join("Link")).unwrap();

        let split = split_source_folder(&root).unwrap();
        let names: Vec<_> = split
            .subfolders
            .iter()
            .map(|p| p.rsplit('/').next().unwrap().to_string())
            .collect();
        assert_eq!(names, ["Album", "Trip"]);
        assert_eq!(split.loose_media_count, 2);
        let _ = fs::remove_dir_all(&root);
    }
}

mod color_label_tests {
    use super::apply_color_label;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn label_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory db");
        sqlx::query(
            "CREATE TABLE media_items (id TEXT PRIMARY KEY, color_label TEXT, updated_at INTEGER)",
        )
        .execute(&db)
        .await
        .expect("create media_items");
        sqlx::query("INSERT INTO media_items (id, color_label) VALUES ('a', 'red')")
            .execute(&db)
            .await
            .expect("seed row");
        db
    }

    async fn stored(db: &sqlx::SqlitePool) -> Option<String> {
        sqlx::query_scalar("SELECT color_label FROM media_items WHERE id = 'a'")
            .fetch_one(db)
            .await
            .expect("read color label")
    }

    #[tokio::test]
    async fn clearing_writes_null_rather_than_leaving_the_old_label() {
        let db = label_db().await;
        assert_eq!(stored(&db).await.as_deref(), Some("red"));

        apply_color_label(&db, "a", None)
            .await
            .expect("clear label");

        assert_eq!(stored(&db).await, None, "clearing must store NULL");
    }

    #[tokio::test]
    async fn an_empty_string_clears_like_none() {
        let db = label_db().await;

        apply_color_label(&db, "a", Some(String::new()))
            .await
            .expect("clear with empty string");

        assert_eq!(stored(&db).await, None);
    }

    #[tokio::test]
    async fn setting_a_label_replaces_the_previous_one() {
        let db = label_db().await;

        apply_color_label(&db, "a", Some("blue".to_string()))
            .await
            .expect("set label");

        assert_eq!(stored(&db).await.as_deref(), Some("blue"));
    }
}

mod tag_tests {
    use super::apply_item_tags;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn tag_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory db");
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&db)
            .await
            .expect("enable foreign keys");
        sqlx::query(
            "CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, rating INTEGER, color_label TEXT)",
        )
        .execute(&db)
        .await
        .expect("create media_items");
        sqlx::query(
            "CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color_index INTEGER DEFAULT 0, created_at INTEGER NOT NULL)",
        )
        .execute(&db)
        .await
        .expect("create tags");
        sqlx::query(
            "CREATE TABLE media_tags (media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (media_id, tag_id))",
        )
        .execute(&db)
        .await
        .expect("create media_tags");
        db
    }

    #[tokio::test]
    async fn shared_tag_keeps_one_canonical_row() {
        let db = tag_db().await;
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("a")
            .bind("/tmp/a.jpg")
            .bind("a.jpg")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("b")
            .bind("/tmp/b.jpg")
            .bind("b.jpg")
            .execute(&db)
            .await
            .unwrap();

        apply_item_tags(&db, "a", &["Travel".to_string()])
            .await
            .expect("apply to a");
        apply_item_tags(&db, "b", &["Travel".to_string()])
            .await
            .expect("apply to b");

        let tag_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(tag_count, 1, "shared tag should not duplicate");

        let a_tags: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = 'a'")
                .fetch_one(&db)
                .await
                .unwrap();
        let b_tags: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = 'b'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(a_tags, 1);
        assert_eq!(b_tags, 1);
    }

    #[tokio::test]
    async fn applying_existing_tag_to_second_item_succeeds() {
        let db = tag_db().await;
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("a")
            .bind("/tmp/a.jpg")
            .bind("a.jpg")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("b")
            .bind("/tmp/b.jpg")
            .bind("b.jpg")
            .execute(&db)
            .await
            .unwrap();

        apply_item_tags(&db, "a", &["Travel".to_string(), "2024".to_string()])
            .await
            .unwrap();
        apply_item_tags(&db, "b", &["Travel".to_string()])
            .await
            .expect("existing tag on second item must succeed");

        let a_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = 'a'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(a_count, 2, "item a must keep both tags");
    }

    #[tokio::test]
    async fn case_insensitive_dedup() {
        let db = tag_db().await;
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("a")
            .bind("/tmp/a.jpg")
            .bind("a.jpg")
            .execute(&db)
            .await
            .unwrap();

        apply_item_tags(&db, "a", &["Travel".to_string(), "travel".to_string()])
            .await
            .unwrap();

        let tag_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(tag_count, 1);
        let join_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = 'a'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(join_count, 1);
    }

    #[tokio::test]
    async fn failed_transaction_leaves_previous_tags_intact() {
        let db = tag_db().await;
        sqlx::query("INSERT INTO media_items (id, path, name) VALUES (?, ?, ?)")
            .bind("a")
            .bind("/tmp/a.jpg")
            .bind("a.jpg")
            .execute(&db)
            .await
            .unwrap();

        apply_item_tags(&db, "a", &["Keep".to_string()])
            .await
            .unwrap();

        let result = apply_item_tags(&db, "ghost", &["New".to_string()]).await;
        assert!(result.is_err(), "applying tags to a missing item must fail");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_tags WHERE media_id = 'a'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1, "original item's tags must survive the failed tx");
    }
}

mod pagination_tests {
    use super::{
        cursor_value, get_library_items_page, matching_ids, timeline_months, LibraryCursor,
    };
    use crate::{commands::LibraryFilterDTO, models::MediaItem};
    use sqlx::sqlite::SqlitePoolOptions;

    async fn page_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory page database");
        sqlx::query(
            "CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, captured_at INTEGER, width INTEGER, height INTEGER, camera TEXT, lens TEXT, exposure TEXT, iso INTEGER, latitude REAL, longitude REAL, sha256 TEXT, favorite INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, is_animated INTEGER NOT NULL DEFAULT 0, content_signature TEXT, import_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rating INTEGER, color_label TEXT)",
        )
        .execute(&db)
        .await
        .expect("create media table");
        sqlx::query(
            "CREATE TABLE library_folders (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL)",
        )
        .execute(&db)
        .await
        .expect("create library folders table");
        sqlx::query("CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create tags table");
        sqlx::query("CREATE TABLE media_tags (media_id TEXT NOT NULL, tag_id TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create media tags table");
        sqlx::query("CREATE TABLE album_items (media_id TEXT NOT NULL, album_id TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create album items table");
        db
    }

    #[test]
    fn cursor_captures_the_active_sort_value_and_stable_item_id() {
        let mut item = MediaItem::new(
            "/tmp/Example.JPG".to_string(),
            "Example.JPG".to_string(),
            "jpg".to_string(),
            crate::media_kind::MediaKind::Photo,
            42,
            100,
        );
        item.id = "stable-id".to_string();
        item.captured_at = Some(80);

        let cursor = LibraryCursor {
            value: cursor_value(&item, "capturedAt"),
            id: item.id.clone(),
        };
        let round_trip: LibraryCursor =
            serde_json::from_str(&serde_json::to_string(&cursor).expect("serialize cursor"))
                .expect("parse cursor");
        assert_eq!(round_trip.value.as_i64(), Some(80));
        assert_eq!(round_trip.id, "stable-id");

        assert_eq!(cursor_value(&item, "name").as_str(), Some("Example.JPG"));
        assert_eq!(cursor_value(&item, "size").as_i64(), Some(42));
        assert_eq!(cursor_value(&item, "modifiedAt").as_i64(), Some(100));
    }

    #[tokio::test]
    async fn keyset_pages_do_not_skip_equal_sort_values() {
        let db = page_db().await;
        for (id, captured_at) in [("c", 30_i64), ("a", 20), ("b", 20)] {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at) VALUES (?, ?, ?, 'jpg', 'photo', 1, 1, ?, 1, 1)")
                .bind(id)
                .bind(format!("/tmp/{id}.jpg"))
                .bind(format!("{id}.jpg"))
                .bind(captured_at)
                .execute(&db)
                .await
                .expect("insert media row");
        }

        let first = get_library_items_page(
            &db,
            LibraryFilterDTO {
                limit: Some(2),
                sort_by: Some("capturedAt".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("read first page");
        assert_eq!(
            first
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "a"]
        );
        assert!(first.has_more);
        assert_eq!(first.total_count, Some(3));

        let second = get_library_items_page(
            &db,
            LibraryFilterDTO {
                limit: Some(2),
                sort_by: Some("capturedAt".to_string()),
                cursor: first.next_cursor,
                ..Default::default()
            },
        )
        .await
        .expect("read second page");
        assert_eq!(
            second
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["b"]
        );
        assert!(!second.has_more);
        assert_eq!(second.total_count, None);
    }

    #[tokio::test]
    async fn timeline_months_count_every_matching_item_and_pick_newest_covers() {
        let db = page_db().await;
        // Mid-month instants, so the local-time fallback lands in the same
        // month in every time zone.
        let mar_10 = 1_741_608_000_000_i64; // 2025-03-10 12:00 UTC
        let mar_20 = 1_742_472_000_000_i64; // 2025-03-20 12:00 UTC
        let jan_15 = 1_736_942_400_000_i64; // 2025-01-15 12:00 UTC
                                            // (id, captured_at, modified_at, hidden, kind)
        let rows: [(&str, Option<i64>, i64, i32, &str); 8] = [
            ("m1", Some(mar_20), jan_15, 0, "photo"),
            ("m2", Some(mar_20 - 1), jan_15, 0, "photo"),
            ("m3", Some(mar_10), jan_15, 0, "photo"),
            ("m4", Some(mar_10 - 1), jan_15, 0, "video"),
            ("m5", None, mar_10 - 2, 0, "photo"),
            ("j1", None, jan_15, 0, "photo"),
            ("h1", Some(mar_20 + 1), jan_15, 1, "photo"),
            ("j2", Some(jan_15 - 1), mar_20, 0, "video"),
        ];
        for (id, captured_at, modified_at, hidden, kind) in rows {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, hidden) VALUES (?, ?, ?, 'jpg', ?, 1, ?, ?, 1, 1, ?)")
                .bind(id)
                .bind(format!("/tmp/{id}.jpg"))
                .bind(format!("{id}.jpg"))
                .bind(kind)
                .bind(modified_at)
                .bind(captured_at)
                .bind(hidden)
                .execute(&db)
                .await
                .expect("insert media row");
        }

        let months = timeline_months(
            &db,
            LibraryFilterDTO {
                // Paging fields must not shrink the Timeline.
                limit: Some(1),
                month: Some("2025-01".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("timeline months");
        let summary: Vec<(&str, i64)> = months.iter().map(|m| (m.key.as_str(), m.count)).collect();
        assert_eq!(
            summary,
            vec![("2025-03", 5), ("2025-01", 2)],
            "hidden items are left out"
        );
        assert_eq!(
            months[0].cover_ids,
            vec!["m1", "m2", "m3", "m4"],
            "newest four"
        );
        assert_eq!(months[1].cover_ids, vec!["j1", "j2"]);

        // Filters narrow the months exactly like the library view.
        let videos = timeline_months(
            &db,
            LibraryFilterDTO {
                kind: Some("video".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("video months");
        let summary: Vec<(&str, i64)> = videos.iter().map(|m| (m.key.as_str(), m.count)).collect();
        assert_eq!(summary, vec![("2025-03", 1), ("2025-01", 1)]);

        // Hidden is its own scope: months and whole-month selection there
        // must count hidden items only, never the visible library.
        let hidden_months = timeline_months(
            &db,
            LibraryFilterDTO {
                hidden: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("hidden months");
        let summary: Vec<(&str, i64)> = hidden_months
            .iter()
            .map(|m| (m.key.as_str(), m.count))
            .collect();
        assert_eq!(summary, vec![("2025-03", 1)]);

        let mut hidden_ids = matching_ids(
            &db,
            LibraryFilterDTO {
                hidden: Some(true),
                month: Some("2025-03".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("hidden month ids");
        hidden_ids.sort();
        assert_eq!(hidden_ids, vec!["h1"]);

        // Select all on a month: the month filter returns the whole month.
        let mut ids = matching_ids(
            &db,
            LibraryFilterDTO {
                month: Some("2025-03".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("month ids");
        ids.sort();
        assert_eq!(ids, vec!["m1", "m2", "m3", "m4", "m5"]);
    }

    #[tokio::test]
    async fn matching_ids_returns_exactly_the_filtered_rows() {
        let db = page_db().await;
        for (id, captured_at, hidden) in
            [("a", 30_i64, 0), ("b", 20, 0), ("c", 10, 0), ("d", 25, 1)]
        {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, hidden) VALUES (?, ?, ?, 'jpg', 'photo', ?, ?, ?, 1, 1, ?)")
                .bind(id)
                .bind(format!("/tmp/{id}.jpg"))
                .bind(format!("{id}.jpg"))
                .bind(1_i64)
                .bind(1_i64)
                .bind(captured_at)
                .bind(hidden)
                .execute(&db)
                .await
                .expect("insert media row");
        }

        let ids = matching_ids(&db, LibraryFilterDTO::default())
            .await
            .unwrap();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string(), "c".to_string()]);

        // Hidden rows are excluded by default, matching the library view.
        let ids_all = matching_ids(
            &db,
            LibraryFilterDTO {
                hidden: Some(true),
                ..LibraryFilterDTO::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(ids_all, vec!["d".to_string()]);
    }
}

/// Benchmarks the scanner's backend stages without opening the user's catalog.
#[tokio::test]
#[ignore = "manual real-media benchmark"]
async fn real_library_scan_benchmark() {
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    let scratch_path = std::env::temp_dir().join(format!("visto-scan-perf-{}", Uuid::new_v4()));
    std::fs::create_dir(&scratch_path).expect("create an isolated benchmark directory");
    let scratch = Scratch(scratch_path);
    let fixture = if let Some(root) = std::env::var_os("VISTOGALLERY_PERF_ROOT") {
        PathBuf::from(root)
    } else {
        let fixture = scratch.0.join("fixtures");
        std::fs::create_dir(&fixture).expect("create screenshot fixture directory");
        let screenshots = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/screenshots");
        for entry in std::fs::read_dir(screenshots).expect("list screenshot fixtures") {
            let entry = entry.expect("read screenshot entry");
            if entry.path().extension().is_some_and(|ext| ext == "jpg") {
                std::fs::copy(entry.path(), fixture.join(entry.file_name()))
                    .expect("copy screenshot fixture");
            }
        }
        fixture
    }
    .canonicalize()
    .expect("resolve the media fixture folder");
    assert!(fixture.is_dir(), "the fixture must be a directory");
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(scratch.0.join("catalog.db"))
                .create_if_missing(true)
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Wal),
        )
        .await
        .expect("open the benchmark catalog");
    sqlx::migrate!("./migrations")
        .run(&db)
        .await
        .expect("migrate the benchmark catalog");

    let cancel = AtomicBool::new(false);
    for (label, force, expect_writes) in [
        ("cold catalog scan", false, true),
        ("unchanged scan", false, false),
        ("forced rescan", true, true),
    ] {
        let started = Instant::now();
        let catalog = catalog_rows_under_root(&db, fixture.to_str().expect("UTF-8 fixture path"))
            .await
            .expect("read the source catalog rows");
        let known = catalog
            .into_iter()
            .map(|row| (row.path, (row.size, row.modified_at)))
            .collect();
        // The benchmark supplies no temp-file sweep. Its source folder is read-only.
        let (paths, walk_error) = collect_media_paths(&fixture, &cancel, None);
        assert!(walk_error.is_none(), "fixture walk failed: {walk_error:?}");
        assert!(!paths.is_empty(), "fixture has no supported media files");

        let now = now_ms();
        let mut inspected = 0;
        for chunk in paths.chunks(100) {
            let scanned = inspect_scan_chunk(chunk, &known, force, now, &cancel);
            inspected += scanned.batch.len();
            upsert_media_batch(&db, &scanned.batch)
                .await
                .expect("write scanned rows");
        }
        let elapsed = started.elapsed();
        assert_eq!(inspected, if expect_writes { paths.len() } else { 0 });
        println!(
            "{label}: {} files, {inspected} inspected and written, {:.2} ms",
            paths.len(),
            elapsed.as_secs_f64() * 1000.0
        );
    }

    let items: Vec<(String, String, i64, String)> =
        sqlx::query_as("SELECT id, path, size, kind FROM media_items ORDER BY path")
            .fetch_all(&db)
            .await
            .expect("get indexed thumbnail sources");
    let started = Instant::now();
    let mut generated = 0;
    for (id, source, size, kind) in &items {
        let target = scratch.0.join(format!("{id}.jpg"));
        if generate_cached_thumbnail(source, &target, 256, *size, 78, kind).is_ok() {
            generated += 1;
        }
    }
    let elapsed = started.elapsed();
    assert!(generated > 0, "fixture generated no thumbnails");
    println!(
        "cold 256 px thumbnails: {generated}/{} generated, {:.2} ms",
        items.len(),
        elapsed.as_secs_f64() * 1000.0
    );
    db.close().await;
}
