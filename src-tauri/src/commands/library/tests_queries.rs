use super::*;

mod filter_and_scale_tests {
    use super::get_library_items_page;
    use crate::commands::{load_album_overviews, LibraryFilterDTO};
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn filter_db() -> SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory filter database");
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
        sqlx::query("CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color_index INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0)")
            .execute(&db)
            .await
            .expect("create albums table");
        sqlx::query("CREATE TABLE album_items (album_id TEXT NOT NULL, media_id TEXT NOT NULL, added_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .expect("create album items table");
        db
    }

    async fn insert_item(
        db: &SqlitePool,
        id: &str,
        kind: &str,
        captured_at: Option<i64>,
        modified_at: i64,
        rating: Option<i64>,
    ) {
        sqlx::query(
            "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, rating) VALUES (?, ?, ?, 'jpg', ?, 1, ?, ?, 1, 1, ?)",
        )
        .bind(id)
        .bind(format!("/tmp/{id}.jpg"))
        .bind(format!("{id}.jpg"))
        .bind(kind)
        .bind(modified_at)
        .bind(captured_at)
        .bind(rating)
        .execute(db)
        .await
        .expect("insert media row");
    }

    async fn set_hidden(db: &SqlitePool, id: &str) {
        sqlx::query("UPDATE media_items SET hidden = 1 WHERE id = ?")
            .bind(id)
            .execute(db)
            .await
            .expect("hide row");
    }

    #[tokio::test]
    async fn unspecified_hidden_excludes_hidden_items_from_items_and_count() {
        let db = filter_db().await;
        insert_item(&db, "shown", "photo", Some(1), 1, None).await;
        insert_item(&db, "secret", "photo", Some(2), 2, None).await;
        set_hidden(&db, "secret").await;

        let page = get_library_items_page(
            &db,
            LibraryFilterDTO {
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .expect("read default page");

        let ids: Vec<&str> = page.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["shown"]);
        assert_eq!(page.total_count, Some(1));
    }

    #[tokio::test]
    async fn hidden_true_counts_the_hidden_items_it_returns() {
        let db = filter_db().await;
        insert_item(&db, "shown", "photo", Some(1), 1, None).await;
        insert_item(&db, "secret", "photo", Some(2), 2, None).await;
        set_hidden(&db, "secret").await;

        let page = get_library_items_page(
            &db,
            LibraryFilterDTO {
                hidden: Some(true),
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .expect("read hidden page");

        let ids: Vec<&str> = page.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, ["secret"]);
        assert_eq!(page.total_count, Some(1));
    }

    #[tokio::test]
    async fn tag_filter_matches_any_of_the_given_tags() {
        let db = filter_db().await;
        insert_item(&db, "beach", "photo", Some(3), 3, None).await;
        insert_item(&db, "party", "photo", Some(2), 2, None).await;
        insert_item(&db, "plain", "photo", Some(1), 1, None).await;
        for (id, name) in [("t-travel", "travel"), ("t-family", "family")] {
            sqlx::query("INSERT INTO tags (id, name) VALUES (?, ?)")
                .bind(id)
                .bind(name)
                .execute(&db)
                .await
                .expect("insert tag");
        }
        for (media, tag) in [("beach", "t-travel"), ("party", "t-family")] {
            sqlx::query("INSERT INTO media_tags (media_id, tag_id) VALUES (?, ?)")
                .bind(media)
                .bind(tag)
                .execute(&db)
                .await
                .expect("tag item");
        }

        for (tags, tag_match, expected) in [
            (vec!["travel"], None, vec!["beach"]),
            (vec!["travel", "family"], None, vec!["beach", "party"]),
            // Tags are unique ignoring case, so a typed name matches either way…
            (vec!["TRAVEL"], None, vec!["beach"]),
            // …and two spellings of one tag do not demand a second tag.
            (vec!["Travel", "travel"], Some("all"), vec!["beach"]),
        ] {
            let page = get_library_items_page(
                &db,
                LibraryFilterDTO {
                    tags: Some(tags.iter().map(|t| t.to_string()).collect()),
                    tag_match: tag_match.map(str::to_string),
                    limit: Some(10),
                    ..Default::default()
                },
            )
            .await
            .expect("tag filter query must be valid SQL");
            let mut ids: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
            ids.sort();
            assert_eq!(ids, expected);
            assert_eq!(page.total_count, Some(expected.len() as i64));
        }
    }

    #[tokio::test]
    async fn extension_filter_normalises_a_direct_caller_value() {
        let db = filter_db().await;
        insert_item(&db, "a", "photo", Some(1), 1, None).await;
        insert_item(&db, "b", "photo", Some(2), 2, None).await;

        for extension in [".JPG", " jpg ", "jpg"] {
            let page = get_library_items_page(
                &db,
                LibraryFilterDTO {
                    extension: Some(extension.to_string()),
                    limit: Some(10),
                    ..Default::default()
                },
            )
            .await
            .expect("extension filter query must be valid SQL");
            assert_eq!(page.total_count, Some(2), "extension {extension:?}");
        }

        let none = get_library_items_page(
            &db,
            LibraryFilterDTO {
                extension: Some("png".to_string()),
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .expect("extension filter query must be valid SQL");
        assert_eq!(none.total_count, Some(0));
    }

    #[tokio::test]
    async fn search_treats_percent_and_underscore_literally() {
        let db = filter_db().await;
        insert_item(&db, "IMG_0001", "photo", Some(1), 1, None).await;
        insert_item(&db, "IMGX0002", "photo", Some(2), 2, None).await;
        insert_item(&db, "sale-100%", "photo", Some(3), 3, None).await;
        insert_item(&db, "sale-1000", "photo", Some(4), 4, None).await;

        let search = |query: &str| {
            let db = db.clone();
            let query = query.to_string();
            async move {
                let page = get_library_items_page(
                    &db,
                    LibraryFilterDTO {
                        query: Some(query),
                        limit: Some(10),
                        ..Default::default()
                    },
                )
                .await
                .expect("search");
                let mut ids: Vec<String> = page.items.into_iter().map(|i| i.id).collect();
                ids.sort();
                ids
            }
        };

        assert_eq!(search("IMG_").await, ["IMG_0001"]);
        assert_eq!(search("100%").await, ["sale-100%"]);
        assert_eq!(search("_").await, ["IMG_0001"]);
    }

    #[tokio::test]
    async fn search_only_looks_at_paths_inside_a_library_folder() {
        let db = filter_db().await;
        sqlx::query("INSERT INTO library_folders (path, added_at) VALUES ('/Users/dev/Photos', 1)")
            .execute(&db)
            .await
            .expect("insert library folder");
        for (id, path) in [
            ("trip", "/Users/dev/Photos/2024/trip.jpg"),
            ("outside", "/Users/dev/Documents/outside.jpg"),
        ] {
            sqlx::query(
                "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES (?, ?, ?, 'jpg', 'photo', 1, 1, 1, 1)",
            )
            .bind(id)
            .bind(path)
            .bind(format!("{id}.jpg"))
            .execute(&db)
            .await
            .expect("insert media row");
        }

        let search = |query: &str| {
            let db = db.clone();
            let query = query.to_string();
            async move {
                let page = get_library_items_page(
                    &db,
                    LibraryFilterDTO {
                        query: Some(query),
                        limit: Some(10),
                        ..Default::default()
                    },
                )
                .await
                .expect("search");
                let mut ids: Vec<String> = page.items.into_iter().map(|i| i.id).collect();
                ids.sort();
                ids
            }
        };

        // The shared `/Users/dev` prefix is not part of any searchable path.
        assert_eq!(search("dev").await, Vec::<String>::new());
        // Folders inside a library folder stay searchable.
        assert_eq!(search("2024").await, ["trip"]);
        // A file imported on its own has no root: the folder it sits in is
        // searchable, the folders above it are not.
        assert_eq!(search("Documents").await, ["outside"]);
        assert_eq!(search("Users").await, Vec::<String>::new());
    }

    #[tokio::test]
    async fn date_range_is_inclusive_and_falls_back_to_modified_at() {
        let db = filter_db().await;
        insert_item(&db, "captured", "photo", Some(100), 1, None).await;
        insert_item(&db, "fallback", "photo", None, 100, None).await;
        insert_item(&db, "outside", "photo", Some(101), 1, None).await;

        let page = get_library_items_page(
            &db,
            LibraryFilterDTO {
                date_from: Some(100),
                date_to: Some(100),
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .expect("read date range");

        let mut ids: Vec<&str> = page.items.iter().map(|item| item.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["captured", "fallback"]);
        assert_eq!(page.total_count, Some(2));
    }

    #[tokio::test]
    async fn date_range_composes_with_kind_and_rating() {
        let db = filter_db().await;
        insert_item(&db, "photo-5", "photo", Some(200), 1, Some(5)).await;
        insert_item(&db, "photo-2", "photo", Some(200), 1, Some(2)).await;
        insert_item(&db, "raw-5", "raw", Some(200), 1, Some(5)).await;
        insert_item(&db, "photo-old", "photo", Some(100), 1, Some(5)).await;

        let page = get_library_items_page(
            &db,
            LibraryFilterDTO {
                kind: Some("photo".to_string()),
                rating: Some(3),
                date_from: Some(150),
                date_to: Some(250),
                limit: Some(10),
                ..Default::default()
            },
        )
        .await
        .expect("read composed filter");

        assert_eq!(
            page.items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["photo-5"]
        );
    }

    #[tokio::test]
    async fn shared_album_covers_are_not_consumed_by_the_first_album() {
        let db = filter_db().await;
        insert_item(&db, "cover-a", "photo", Some(3), 3, None).await;
        insert_item(&db, "cover-b", "photo", Some(2), 2, None).await;
        insert_item(&db, "cover-c", "photo", Some(1), 1, None).await;
        sqlx::query(
            "INSERT INTO albums (id, name, created_at, updated_at) VALUES \
             ('first', 'First', 1, 1), ('second', 'Second', 2, 2)",
        )
        .execute(&db)
        .await
        .expect("insert albums");

        // The same photos cover both albums. The first album must not take
        // them out of the shared lookup used by the rest.
        for album in ["first", "second"] {
            for id in ["cover-a", "cover-b", "cover-c"] {
                sqlx::query(
                    "INSERT INTO album_items (album_id, media_id, added_at) VALUES (?, ?, 1)",
                )
                .bind(album)
                .bind(id)
                .execute(&db)
                .await
                .expect("insert album item");
            }
        }

        let overview = load_album_overviews(&db).await.expect("album overview");
        assert_eq!(overview.len(), 2);
        for album in &overview {
            assert_eq!(
                album.cover_items.len(),
                3,
                "album {} lost shared cover items",
                album.id
            );
        }
    }

    /// Not part of the default suite; run with:
    /// `cargo test ten_thousand_item_page_and_album_overview -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "10k-item benchmark; run explicitly and record the output"]
    async fn ten_thousand_item_page_and_album_overview_are_bounded() {
        let db = filter_db().await;
        sqlx::query("INSERT INTO albums (id, name, created_at, updated_at) VALUES ('album', 'Everything', 1, 1)")
            .execute(&db)
            .await
            .expect("insert album");
        let mut tx = db.begin().await.expect("begin seed transaction");
        for index in 0..10_000_i64 {
            sqlx::query(
                "INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, captured_at, created_at, updated_at, rating) VALUES (?, ?, ?, 'jpg', 'photo', ?, ?, ?, 1, 1, ?)",
            )
            .bind(format!("m{index}"))
            .bind(format!("/tmp/m{index}.jpg"))
            .bind(format!("m{index}.jpg"))
            .bind(index)
            .bind(1_700_000_000_000_i64 + index)
            .bind(1_700_000_000_000_i64 + index)
            .bind(index % 6)
            .execute(&mut *tx)
            .await
            .expect("seed media row");
            sqlx::query(
                "INSERT INTO album_items (album_id, media_id, added_at) VALUES ('album', ?, 1)",
            )
            .bind(format!("m{index}"))
            .execute(&mut *tx)
            .await
            .expect("seed album row");
        }
        tx.commit().await.expect("commit seed transaction");

        let first_page_started = std::time::Instant::now();
        let first = get_library_items_page(
            &db,
            LibraryFilterDTO {
                limit: Some(250),
                ..Default::default()
            },
        )
        .await
        .expect("first page");
        let first_page_ms = first_page_started.elapsed().as_millis();

        let overview_started = std::time::Instant::now();
        let overview = load_album_overviews(&db).await.expect("album overview");
        let overview_ms = overview_started.elapsed().as_millis();

        eprintln!(
            "10k benchmark: first-page items={} total={} page={}ms; album-overviews={} covers={} total={}ms",
            first.items.len(),
            first.total_count.unwrap_or_default(),
            first_page_ms,
            overview.len(),
            overview.first().map(|album| album.cover_items.len()).unwrap_or(0),
            overview_ms,
        );
        assert_eq!(first.items.len(), 250);
        assert_eq!(first.total_count, Some(10_000));
        assert_eq!(overview.len(), 1);
        assert_eq!(overview[0].item_count, 10_000);
        assert!(overview[0].cover_items.len() <= 4);
    }
}

mod scan_chunk_tests {
    use super::{collect_media_paths, file_modified_at, inspect_scan_chunk};
    use std::collections::HashMap;
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn tree() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("visto-scan-chunk-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("a.jpg"), b"not really a jpeg").unwrap();
        fs::write(root.join("nested/b.PNG"), b"not really a png").unwrap();
        fs::write(root.join("notes.txt"), b"skip me").unwrap();
        root
    }

    #[test]
    fn walk_keeps_only_media_extensions() {
        let root = tree();
        let (mut paths, error) = collect_media_paths(&root, &AtomicBool::new(false), None);
        paths.sort();
        assert!(error.is_none());
        assert_eq!(paths, vec![root.join("a.jpg"), root.join("nested/b.PNG")]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_sweeps_stale_export_temps_only_when_asked() {
        let root = tree();
        let stale = root.join(format!("a.tmp-{}", uuid::Uuid::new_v4()));
        let fresh = root.join(format!("b.tmp-{}", uuid::Uuid::new_v4()));
        fs::write(&stale, b"partial").unwrap();
        fs::write(&fresh, b"in progress").unwrap();
        let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
        std::fs::set_times(&stale, std::fs::FileTimes::new().set_modified(old)).unwrap();

        // Imports pass None: nothing is removed.
        collect_media_paths(&root, &AtomicBool::new(false), None);
        assert!(stale.exists());

        // Scans pass a grace period: the old temp goes, the fresh one stays,
        // and media discovery is unchanged.
        let (mut paths, _) = collect_media_paths(
            &root,
            &AtomicBool::new(false),
            Some(std::time::Duration::from_secs(300)),
        );
        paths.sort();
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert_eq!(paths, vec![root.join("a.jpg"), root.join("nested/b.PNG")]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_stops_when_cancelled() {
        let root = tree();
        let (paths, _) = collect_media_paths(&root, &AtomicBool::new(true), None);
        assert!(paths.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unchanged_files_are_counted_but_not_reinspected() {
        let root = tree();
        let a = root.join("a.jpg");
        let meta = fs::metadata(&a).unwrap();
        let known = HashMap::from([(
            a.to_string_lossy().into_owned(),
            (meta.len() as i64, file_modified_at(&meta)),
        )]);
        let chunk = inspect_scan_chunk(
            std::slice::from_ref(&a),
            &known,
            false,
            0,
            &AtomicBool::new(false),
        );
        assert_eq!(chunk.completed, 1);
        assert_eq!(chunk.discovered, 1);
        assert_eq!(chunk.size, meta.len() as i64);
        assert!(chunk.batch.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_files_are_completed_but_not_discovered() {
        let root = tree();
        let gone = root.join("gone.jpg");
        let chunk = inspect_scan_chunk(&[gone], &HashMap::new(), false, 0, &AtomicBool::new(false));
        assert_eq!(chunk.completed, 1);
        assert_eq!(chunk.discovered, 0);
        let _ = fs::remove_dir_all(&root);
    }
}

mod sort_index_tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row;

    async fn plan_for(sql: &str) -> String {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory catalog");
        sqlx::migrate!("./migrations")
            .run(&db)
            .await
            .expect("run migrations");
        // The plan wrapper only prefixes a query this test wrote.
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")))
            .bind(0i32)
            .bind(201i64)
            .fetch_all(&db)
            .await
            .expect("explain query");
        rows.iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The default page (`get_library_items_page` with no sort) must walk the
    /// sort index instead of sorting the whole table for every page.
    #[tokio::test]
    async fn default_library_sort_uses_index_without_temp_sort() {
        let plan = plan_for(
            "SELECT * FROM media_items WHERE 1=1 AND hidden = ? \
             ORDER BY COALESCE(captured_at, modified_at) DESC, id ASC LIMIT ?",
        )
        .await;
        assert!(plan.contains("idx_media_hidden_sort_date_id"), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    }
}

mod remove_library_folder_tests {
    use super::remove_library_folder_inner;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn seeded_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        db
    }

    async fn seed_folder_and_rows(db: &sqlx::SqlitePool, root: &str, count: usize) {
        sqlx::query("INSERT INTO library_folders (path, added_at) VALUES (?, 1)")
            .bind(root)
            .execute(db)
            .await
            .unwrap();
        for i in 0..count {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES (?, ?, 'a.jpg', 'jpg', 'photo', 1, 1, 1, 1)")
                .bind(format!("id-{i}"))
                .bind(format!("{root}/inner/{i}.jpg"))
                .execute(db)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn missing_files_drop_rows_and_forget_the_folder() {
        let db = seeded_db().await;
        let root = "/visto-does-not-exist-b3-test";
        seed_folder_and_rows(&db, root, 2).await;
        // Files do not exist: rows drop and the folder is forgotten.
        let dropped = remove_library_folder_inner(&db, root, true).await.unwrap();
        assert_eq!(dropped, 2);
        let rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM media_items WHERE path LIKE '/visto-does-not-exist-b3-test/%'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(rows, 0);
        let folders: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM library_folders WHERE path = ?")
                .bind(root)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(folders, 0);
    }

    #[tokio::test]
    async fn rerun_is_idempotent() {
        let db = seeded_db().await;
        let root = "/visto-does-not-exist-b3-retry";
        seed_folder_and_rows(&db, root, 2).await;
        assert_eq!(
            remove_library_folder_inner(&db, root, true).await.unwrap(),
            2
        );
        // Folder is forgotten, so a retry refuses cleanly instead of
        // silently succeeding again.
        let err = remove_library_folder_inner(&db, root, true)
            .await
            .unwrap_err();
        assert_eq!(err.code, crate::errors::ErrorCode::PathNotAllowed);
    }
}

mod library_folders_tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use std::fs;

    #[tokio::test]
    async fn registered_but_missing_root_is_listed_as_unavailable() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory catalog");
        sqlx::migrate!("./migrations")
            .run(&db)
            .await
            .expect("run migrations");

        let existing = std::env::temp_dir().join(format!("visto-src-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&existing).expect("create existing source");
        let missing = std::env::temp_dir().join(format!("visto-missing-{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&missing);

        for path in [&existing, &missing] {
            sqlx::query("INSERT INTO library_folders (path, added_at) VALUES (?, 0)")
                .bind(path.to_string_lossy().as_ref())
                .execute(&db)
                .await
                .expect("insert library folder");
        }

        let folders = super::get_library_folders_inner(&db)
            .await
            .expect("list folders");
        let existing_path = existing.to_string_lossy().to_string();
        let missing_path = missing.to_string_lossy().to_string();

        let existing_row = folders
            .iter()
            .find(|f| f.path == existing_path)
            .expect("existing");
        let missing_row = folders
            .iter()
            .find(|f| f.path == missing_path)
            .expect("missing");

        assert!(
            existing_row.available,
            "existing source should be available"
        );
        assert!(!missing_row.available, "deleted source should be missing");
        assert_eq!(missing_row.item_count, 0);

        let _ = fs::remove_dir_all(&existing);
    }
}

mod library_stats_tests {
    use super::library_stats;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn total_size_includes_animated_items() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        for (id, ext, kind, size, animated) in [
            ("still", "jpg", "photo", 100, 0),
            ("loop", "gif", "photo", 40, 1),
            ("clip", "mp4", "video", 1000, 0),
        ] {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at, is_animated) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?)")
                .bind(id)
                .bind(format!("/lib/{id}.{ext}"))
                .bind(format!("{id}.{ext}"))
                .bind(ext)
                .bind(kind)
                .bind(size)
                .bind(animated)
                .execute(&db)
                .await
                .unwrap();
        }

        let stats = library_stats(&db).await.unwrap();
        assert_eq!((stats.photos, stats.animations, stats.videos), (1, 1, 1));
        assert_eq!(stats.photo_size, 100);
        assert_eq!(stats.animations_size, 40);
        assert_eq!(stats.total_size, 1140);
    }

    /// The Hidden screen's chips count every hidden item by kind, and the
    /// library's own counts leave hidden items out.
    #[tokio::test]
    async fn hidden_scope_counts_only_hidden_items_by_kind() {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        for (id, ext, kind, size, hidden) in [
            ("shown", "jpg", "photo", 10, 0),
            ("p1", "jpg", "photo", 20, 1),
            ("p2", "heic", "photo", 30, 1),
            ("v1", "mp4", "video", 500, 1),
            ("r1", "cr2", "raw", 70, 1),
        ] {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at, hidden) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?)")
                .bind(id)
                .bind(format!("/lib/{id}.{ext}"))
                .bind(format!("{id}.{ext}"))
                .bind(ext)
                .bind(kind)
                .bind(size)
                .bind(hidden)
                .execute(&db)
                .await
                .unwrap();
        }

        let hidden = super::library_stats_scoped(&db, true).await.unwrap();
        assert_eq!((hidden.photos, hidden.videos, hidden.raws), (2, 1, 1));
        assert_eq!(hidden.total_size, 620);
        assert_eq!(hidden.hidden, 4);

        let visible = library_stats(&db).await.unwrap();
        assert_eq!((visible.photos, visible.videos, visible.raws), (1, 0, 0));
        assert_eq!(visible.hidden, 4);
    }
}

mod items_by_ids_tests {
    use super::items_by_ids;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn db_with_items(count: usize) -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        for i in 0..count {
            sqlx::query("INSERT INTO media_items (id, path, name, extension, kind, size, modified_at, created_at, updated_at) VALUES (?, ?, ?, 'jpg', 'photo', 1, 1, 1, 1)")
                .bind(format!("id-{i}"))
                .bind(format!("/lib/{i}.jpg"))
                .bind(format!("{i}.jpg"))
                .execute(&db)
                .await
                .unwrap();
        }
        db
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[tokio::test]
    async fn returns_items_in_request_order_and_skips_unknown_ids() {
        let db = db_with_items(3).await;
        let items = items_by_ids(&db, &ids(&["id-2", "gone", "id-0", "id-2"]))
            .await
            .unwrap();
        let got: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(got, vec!["id-2", "id-0"]);
    }

    #[tokio::test]
    async fn looks_up_more_ids_than_one_statement_can_bind() {
        let db = db_with_items(1200).await;
        let wanted: Vec<String> = (0..1200).map(|i| format!("id-{i}")).collect();
        let items = items_by_ids(&db, &wanted).await.unwrap();
        assert_eq!(items.len(), 1200);
        assert_eq!(items[1199].id, "id-1199");
    }

    #[tokio::test]
    async fn empty_request_returns_nothing() {
        let db = db_with_items(1).await;
        assert!(items_by_ids(&db, &[]).await.unwrap().is_empty());
    }
}
