use super::*;

mod trash_validation_tests {
    use super::{catalog_paths_by_id, validate_trash_path};
    use crate::errors::ErrorCode;
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("visto-trash-test-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn write_file(path: &Path) {
        std::fs::write(path, b"data").expect("write file");
    }

    fn cataloged(paths: &[&Path]) -> HashSet<String> {
        paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn cataloged_file_is_allowed_even_outside_roots() {
        let dir = temp_dir("cataloged");
        let file = dir.join("a.jpg");
        write_file(&file);
        let registered = vec!["/some/other/root".to_string()];

        assert!(
            validate_trash_path(file.to_str().unwrap(), &cataloged(&[&file]), &registered).is_ok()
        );
    }

    #[test]
    fn uncataloged_file_inside_registered_root_is_allowed() {
        let dir = temp_dir("inside-root");
        let file = dir.join("a.jpg");
        write_file(&file);
        let registered = vec![dir.to_string_lossy().into_owned()];

        assert!(validate_trash_path(file.to_str().unwrap(), &HashSet::new(), &registered).is_ok());
    }

    #[test]
    fn uncataloged_file_outside_registered_root_is_rejected() {
        let root = temp_dir("root");
        let outside = temp_dir("outside");
        let file = outside.join("a.jpg");
        write_file(&file);
        let registered = vec![root.to_string_lossy().into_owned()];

        let error = validate_trash_path(file.to_str().unwrap(), &HashSet::new(), &registered)
            .expect_err("outside root should be rejected");
        assert_eq!(error.code, ErrorCode::PathNotAllowed);
        assert!(error.message.contains("outside registered library folders"));
    }

    #[test]
    fn missing_file_is_reported_as_not_found() {
        let dir = temp_dir("missing");
        let file = dir.join("gone.jpg");
        let error = validate_trash_path(file.to_str().unwrap(), &HashSet::new(), &[])
            .expect_err("missing file should be rejected");
        assert_eq!(error.code, ErrorCode::NotFound);
    }

    #[test]
    fn symlink_is_reported_as_invalid_input() {
        let dir = temp_dir("symlink");
        let file = dir.join("a.jpg");
        write_file(&file);
        let link = dir.join("link.jpg");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let error = validate_trash_path(link.to_str().unwrap(), &HashSet::new(), &[])
            .expect_err("symlink should be rejected");
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn path_traversal_cannot_escape_a_root() {
        let root = temp_dir("traversal-root");
        let outside = temp_dir("traversal-outside");
        let file = outside.join("a.jpg");
        write_file(&file);
        let registered = vec![root.to_string_lossy().into_owned()];
        let escaped = root
            .join("..")
            .join(outside.file_name().unwrap())
            .join("a.jpg");

        assert!(
            validate_trash_path(escaped.to_str().unwrap(), &HashSet::new(), &registered).is_err()
        );
    }

    #[test]
    fn missing_file_is_rejected() {
        let dir = temp_dir("missing");
        let file = dir.join("gone.jpg");

        let error = validate_trash_path(file.to_str().unwrap(), &HashSet::new(), &[])
            .expect_err("missing file should be rejected");
        assert!(error.message.contains("no longer exists"));
    }

    #[test]
    fn symlinks_are_rejected() {
        let dir = temp_dir("symlink");
        let target = dir.join("target.jpg");
        write_file(&target);
        let link = dir.join("link.jpg");
        std::os::unix::fs::symlink(&target, &link).expect("create symlink");
        let registered = vec![dir.to_string_lossy().into_owned()];

        let error = validate_trash_path(link.to_str().unwrap(), &HashSet::new(), &registered)
            .expect_err("symlink should be rejected");
        assert!(error.message.contains("symbolic link"));
    }

    #[test]
    fn directories_are_rejected() {
        let dir = temp_dir("directories");
        let registered = vec![dir.to_string_lossy().into_owned()];

        let error = validate_trash_path(dir.to_str().unwrap(), &HashSet::new(), &registered)
            .expect_err("directory should be rejected");
        assert!(error.message.contains("Only regular files"));
    }

    #[tokio::test]
    async fn catalog_lookup_resolves_ids_and_drops_unknown_ids() {
        use sqlx::sqlite::SqlitePoolOptions;

        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create media_items");
        sqlx::query(
            "INSERT INTO media_items (id, path) VALUES ('a', '/tmp/a.jpg'), ('b', '/tmp/b.jpg')",
        )
        .execute(&db)
        .await
        .expect("insert rows");

        let resolved = catalog_paths_by_id(&db, &["b".to_string(), "missing".to_string()])
            .await
            .expect("resolve ids");

        assert_eq!(resolved.get("b").map(String::as_str), Some("/tmp/b.jpg"));
        assert!(!resolved.contains_key("missing"));
        assert_eq!(resolved.len(), 1);
    }
}

mod trash_restore_tests {
    use super::{
        list_trash_entries, restore_from_trash, select_trash_match, trash_dirs_for,
        TrashRestoreItem,
    };
    use std::path::{Path, PathBuf};

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "visto-trash-restore-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn roots(home: &Path) -> Vec<String> {
        vec![home.to_string_lossy().into_owned()]
    }

    fn request(path: &Path, size: Option<i64>) -> TrashRestoreItem {
        let name = path
            .file_name()
            .expect("target file name")
            .to_string_lossy()
            .into_owned();
        TrashRestoreItem {
            path: path.to_string_lossy().into_owned(),
            name,
            size,
        }
    }

    #[test]
    fn select_trash_match_prefers_the_exact_name_and_size() {
        let trash = temp_dir("match-exact");
        let small = trash.join("photo.jpg");
        let big = trash.join("photo.jpg.moved");
        std::fs::write(&small, b"small").unwrap();
        std::fs::write(&big, b"big content here").unwrap();

        let entries = list_trash_entries(&trash);
        let matched = select_trash_match(&entries, "photo.jpg", Some(5));
        match matched {
            Some(entry) => assert_eq!(entry.path, small, "exact name and size must win"),
            None => panic!("exact name and size must win"),
        }
    }

    #[test]
    fn select_trash_match_accepts_sizeless_unique_name() {
        let trash = temp_dir("match-sizeless");
        let only = trash.join("only.jpg");
        std::fs::write(&only, b"data").unwrap();

        let entries = list_trash_entries(&trash);
        assert!(select_trash_match(&entries, "only.jpg", None).is_some());
    }

    #[test]
    fn select_trash_match_refuses_ambiguous_sizeless_requests() {
        let entries = vec![
            super::TrashEntry {
                path: PathBuf::from("/trash/photo.jpg"),
                size: 10,
            },
            super::TrashEntry {
                path: PathBuf::from("/trash/photo.jpg"),
                size: 20,
            },
        ];
        assert!(select_trash_match(&entries, "photo.jpg", None).is_none());
        assert_eq!(
            select_trash_match(&entries, "photo.jpg", Some(20)).map(|entry| entry.size),
            Some(20),
            "a size that matches disambiguates the pair"
        );
    }

    #[test]
    fn select_trash_match_rejects_size_mismatch_and_missing_name() {
        let trash = temp_dir("match-mismatch");
        let entry = trash.join("photo.jpg");
        std::fs::write(&entry, b"12345").unwrap();

        let entries = list_trash_entries(&trash);
        assert!(select_trash_match(&entries, "photo.jpg", Some(6)).is_none());
        assert!(select_trash_match(&entries, "other.jpg", Some(5)).is_none());
    }

    #[test]
    fn restore_from_trash_moves_the_file_back_home() {
        let trash = temp_dir("restore-move");
        let home = temp_dir("restore-home");
        let trashed = trash.join("vacation.jpg");
        std::fs::write(&trashed, b"image bytes").unwrap();
        let target = home.join("vacation.jpg");

        let result = restore_from_trash(
            &|_: &Path| vec![trash.clone()],
            &roots(&home),
            &[request(&target, Some(11))],
        );
        assert_eq!(result.restored, vec![target.to_string_lossy().into_owned()]);
        assert!(result.failed.is_empty());
        assert_eq!(std::fs::read(&target).unwrap(), b"image bytes");
        assert!(
            !trashed.exists(),
            "the trash entry must be gone after a restore"
        );
    }

    #[test]
    fn restore_from_trash_reports_missing_files() {
        let trash = temp_dir("restore-missing");
        let home = temp_dir("restore-missing-home");
        let target = home.join("gone.jpg");

        let result = restore_from_trash(
            &|_: &Path| vec![trash.clone()],
            &roots(&home),
            &[request(&target, None)],
        );
        assert!(result.restored.is_empty());
        assert_eq!(result.failed.len(), 1);
    }

    #[test]
    fn restore_from_trash_never_overwrites_an_existing_file() {
        let trash = temp_dir("restore-exists");
        let home = temp_dir("restore-exists-home");
        let trashed = trash.join("keep.jpg");
        std::fs::write(&trashed, b"trashed bytes").unwrap();
        let target = home.join("keep.jpg");
        std::fs::write(&target, b"keep me").unwrap();

        let result = restore_from_trash(
            &|_: &Path| vec![trash.clone()],
            &roots(&home),
            &[request(&target, Some(13))],
        );
        assert_eq!(
            result.restored.len(),
            1,
            "already-present file counts as restored"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"keep me");
        assert!(trashed.exists(), "the trash entry is left untouched");
    }

    /// macOS keeps a trashed file on its own volume, in `.Trashes/<uid>`.
    /// Undo for a duplicate on an external drive must look there too.
    #[test]
    fn restore_from_trash_finds_files_in_a_volume_trash() {
        let user_trash = temp_dir("restore-user-trash");
        let volume_trash = temp_dir("restore-volume-trash");
        let home = temp_dir("restore-volume-home");
        let trashed = volume_trash.join("usb.jpg");
        std::fs::write(&trashed, b"usb bytes").unwrap();
        let target = home.join("usb.jpg");

        let result = restore_from_trash(
            &|_: &Path| vec![user_trash.clone(), volume_trash.clone()],
            &roots(&home),
            &[request(&target, Some(9))],
        );
        assert_eq!(result.restored, vec![target.to_string_lossy().into_owned()]);
        assert_eq!(std::fs::read(&target).unwrap(), b"usb bytes");
    }

    #[test]
    fn restore_from_trash_refuses_targets_outside_library_sources() {
        let trash = temp_dir("restore-outside-trash");
        let home = temp_dir("restore-outside-root");
        let elsewhere = temp_dir("restore-outside-elsewhere");
        let trashed = trash.join("note.jpg");
        std::fs::write(&trashed, b"bytes").unwrap();
        let target = elsewhere.join("note.jpg");

        let result = restore_from_trash(
            &|_: &Path| vec![trash.clone()],
            &roots(&home),
            &[request(&target, None)],
        );
        assert!(result.restored.is_empty());
        assert_eq!(result.failed.len(), 1);
        assert!(trashed.exists(), "the Trash entry stays where it is");
        assert!(!target.exists());
    }

    #[test]
    fn restore_from_trash_refuses_a_name_that_differs_from_the_target() {
        let trash = temp_dir("restore-rename-trash");
        let home = temp_dir("restore-rename-home");
        std::fs::write(trash.join("photo.jpg"), b"bytes").unwrap();
        let target = home.join("launch-agent.plist");

        let result = restore_from_trash(
            &|_: &Path| vec![trash.clone()],
            &roots(&home),
            &[TrashRestoreItem {
                path: target.to_string_lossy().into_owned(),
                name: "photo.jpg".to_string(),
                size: None,
            }],
        );
        assert!(result.restored.is_empty());
        assert!(!target.exists());
    }

    #[test]
    fn trash_dirs_include_the_volume_trash_for_external_drives() {
        let external = trash_dirs_for(Path::new("/Volumes/USB Drive/Photos/a.jpg"));
        assert!(external
            .iter()
            .any(|dir| dir.starts_with("/Volumes/USB Drive/.Trashes/")));
        let internal = trash_dirs_for(Path::new("/Users/someone/Pictures/a.jpg"));
        assert!(internal.iter().all(|dir| !dir.starts_with("/Volumes")));
    }

    #[test]
    fn restore_from_trash_refuses_names_with_separators() {
        let trash = temp_dir("restore-traversal");
        let home = temp_dir("restore-traversal-home");
        let target = home.join("nested").join("photo.jpg");

        let result = restore_from_trash(
            &|_: &Path| vec![trash.clone()],
            &roots(&home),
            &[TrashRestoreItem {
                path: target.to_string_lossy().into_owned(),
                name: "../photo.jpg".to_string(),
                size: None,
            }],
        );
        assert!(result.restored.is_empty());
        assert_eq!(result.failed.len(), 1);
    }
}

mod trash_flow_tests {
    use super::{
        execute_trash, remove_edit_backup_files, resolve_trash_targets, TrashSink,
        EDIT_ORIGINALS_DIR,
    };
    use crate::commands::CancelGroup;
    use crate::errors::CommandError;
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    async fn test_db() -> sqlx::SqlitePool {
        use sqlx::sqlite::SqlitePoolOptions;

        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory database");
        sqlx::query("CREATE TABLE media_items (id TEXT PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&db)
            .await
            .expect("create media_items");
        sqlx::query(
            "CREATE TABLE edit_backups (media_id TEXT PRIMARY KEY, original_path TEXT NOT NULL, backup_path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT, created_at INTEGER NOT NULL)",
        )
        .execute(&db)
        .await
        .expect("create edit_backups");
        db
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("visto-trash-flow-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn write_file(path: &Path) {
        std::fs::write(path, b"data").expect("write file");
    }

    async fn insert_item(db: &sqlx::SqlitePool, id: &str, path: &Path) {
        sqlx::query("INSERT INTO media_items (id, path) VALUES (?, ?)")
            .bind(id)
            .bind(path.to_string_lossy().into_owned())
            .execute(db)
            .await
            .expect("insert media item");
    }

    async fn catalog_ids(db: &sqlx::SqlitePool) -> Vec<String> {
        sqlx::query_scalar("SELECT id FROM media_items ORDER BY id")
            .fetch_all(db)
            .await
            .expect("read catalog")
    }

    /// Records trashed paths; rejects individual paths to exercise
    /// partial-failure reporting.
    #[derive(Default)]
    struct FakeTrash {
        fail_paths: HashSet<String>,
        moved: Mutex<Vec<String>>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl FakeTrash {
        fn moved(&self) -> Vec<String> {
            self.moved.lock().unwrap().clone()
        }

        fn calls(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl TrashSink for FakeTrash {
        fn delete_all(&self, paths: &[String]) -> Result<(), CommandError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // If any path in the batch is a known failure, the whole batch
            // fails (mirrors a single osascript call failing partway).
            if paths.iter().any(|p| self.fail_paths.contains(p)) {
                return Err(CommandError::internal("permission denied".to_string()));
            }
            self.moved.lock().unwrap().extend(paths.iter().cloned());
            Ok(())
        }
    }

    /// Regression guard for the duplicate-delete bug: the renderer only sends
    /// ids, so a copy that is not in the currently loaded library page must
    /// still resolve to its real path and become a trash target.
    #[tokio::test]
    async fn resolves_a_duplicate_that_is_not_in_the_loaded_page() {
        let db = test_db().await;
        let dir = temp_dir("resolve");
        let copy = dir.join("copy.jpg");
        write_file(&copy);
        insert_item(&db, "copy", &copy).await;

        let (targets, failed) = resolve_trash_targets(&db, vec!["copy".to_string()], &[])
            .await
            .expect("resolve targets");

        assert!(failed.is_empty(), "unexpected failures: {failed:?}");
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].0, "copy");
        assert_eq!(targets[0].1, copy.to_string_lossy().into_owned());
    }

    #[tokio::test]
    async fn unresolved_and_unreadable_ids_are_reported_without_targets() {
        let db = test_db().await;
        let dir = temp_dir("bad-ids");
        let missing = dir.join("gone.jpg");
        insert_item(&db, "missing", &missing).await;

        let (targets, failed) =
            resolve_trash_targets(&db, vec!["ghost".to_string(), "missing".to_string()], &[])
                .await
                .expect("resolve targets");

        assert!(targets.is_empty());
        let ids: Vec<&str> = failed.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["ghost", "missing"]);
        assert!(failed[0].error.contains("no longer in the catalog"));
        assert!(failed[1].error.contains("no longer exists"));
    }

    #[tokio::test]
    async fn symlinked_catalog_rows_are_rejected() {
        let db = test_db().await;
        let dir = temp_dir("symlink");
        let target = dir.join("target.jpg");
        write_file(&target);
        let link = dir.join("link.jpg");
        std::os::unix::fs::symlink(&target, &link).expect("create symlink");
        insert_item(&db, "linked", &link).await;

        let (targets, failed) = resolve_trash_targets(&db, vec!["linked".to_string()], &[])
            .await
            .expect("resolve targets");

        assert!(targets.is_empty());
        assert_eq!(failed.len(), 1);
        assert!(failed[0].error.contains("symbolic link"));
    }

    #[tokio::test]
    async fn duplicate_ids_are_collapsed_preserving_order() {
        let db = test_db().await;
        let dir = temp_dir("dedupe");
        let a = dir.join("a.jpg");
        let b = dir.join("b.jpg");
        write_file(&a);
        write_file(&b);
        insert_item(&db, "a", &a).await;
        insert_item(&db, "b", &b).await;

        let (targets, failed) = resolve_trash_targets(
            &db,
            vec![
                "b".to_string(),
                "a".to_string(),
                "b".to_string(),
                String::new(),
            ],
            &[],
        )
        .await
        .expect("resolve targets");

        assert!(failed.is_empty());
        let ids: Vec<&str> = targets.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }

    /// Full flow: trash the files, delete only the trashed catalog rows, and
    /// remove journaled originals that belonged to them.
    #[test]
    fn edit_backup_cleanup_only_touches_the_originals_folder() {
        let dir = temp_dir("backup-guard");
        let originals = dir.join(EDIT_ORIGINALS_DIR);
        std::fs::create_dir_all(&originals).expect("create originals dir");
        let journaled = originals.join("x.jpg");
        let elsewhere = dir.join("photo.jpg");
        write_file(&journaled);
        write_file(&elsewhere);

        remove_edit_backup_files(&[
            journaled.to_string_lossy().into_owned(),
            elsewhere.to_string_lossy().into_owned(),
        ]);

        assert!(!journaled.exists(), "journaled original is removed");
        assert!(
            elsewhere.exists(),
            "a path outside edit-originals is never deleted"
        );
    }

    #[tokio::test]
    async fn successful_trash_removes_rows_and_edit_backups() {
        let db = test_db().await;
        let dir = temp_dir("success");
        let a = dir.join("a.jpg");
        let b = dir.join("b.jpg");
        let keep = dir.join("keep.jpg");
        write_file(&a);
        write_file(&b);
        write_file(&keep);
        insert_item(&db, "a", &a).await;
        insert_item(&db, "b", &b).await;
        insert_item(&db, "keep", &keep).await;

        let originals = dir.join(EDIT_ORIGINALS_DIR);
        std::fs::create_dir_all(&originals).expect("create originals dir");
        let backup = originals.join("a-original.jpg");
        write_file(&backup);
        sqlx::query(
            "INSERT INTO edit_backups (media_id, original_path, backup_path, size, sha256, created_at) VALUES ('a', ?, ?, 4, NULL, 1)",
        )
        .bind(a.to_string_lossy().into_owned())
        .bind(backup.to_string_lossy().into_owned())
        .execute(&db)
        .await
        .expect("insert edit backup");

        let fake = Arc::new(FakeTrash::default());
        let sink: Arc<dyn TrashSink> = fake.clone();
        let group = CancelGroup::default();
        let cancel = group.start();
        let outcome = execute_trash(
            &db,
            vec![
                ("a".to_string(), a.to_string_lossy().into_owned()),
                ("b".to_string(), b.to_string_lossy().into_owned()),
            ],
            sink,
            &cancel,
            |_, _, _| {},
        )
        .await
        .expect("trash targets");

        assert_eq!(outcome.trashed, vec!["a".to_string(), "b".to_string()]);
        assert!(outcome.failed.is_empty());
        assert_eq!(
            fake.moved(),
            vec![
                a.to_string_lossy().into_owned(),
                b.to_string_lossy().into_owned()
            ]
        );
        // Only the trashed rows are gone; unrelated items survive.
        assert_eq!(catalog_ids(&db).await, vec!["keep"]);
        // The journaled original was cleaned up.
        assert!(!backup.exists(), "edit backup should be removed");
    }

    /// Per-file failures are reported and leave failed rows in the catalog
    /// for a retry.
    #[tokio::test]
    async fn partial_failures_keep_their_rows_and_report_ids() {
        let db = test_db().await;
        let dir = temp_dir("partial");
        let good = dir.join("good.jpg");
        let bad = dir.join("bad.jpg");
        write_file(&good);
        write_file(&bad);
        insert_item(&db, "good", &good).await;
        insert_item(&db, "bad", &bad).await;

        let fake = Arc::new(FakeTrash {
            fail_paths: HashSet::from([bad.to_string_lossy().into_owned()]),
            ..FakeTrash::default()
        });
        let sink: Arc<dyn TrashSink> = fake.clone();
        let group = CancelGroup::default();
        let cancel = group.start();
        let outcome = execute_trash(
            &db,
            vec![
                ("good".to_string(), good.to_string_lossy().into_owned()),
                ("bad".to_string(), bad.to_string_lossy().into_owned()),
            ],
            sink,
            &cancel,
            |_, _, _| {},
        )
        .await
        .expect("trash targets");

        assert_eq!(outcome.trashed, vec!["good".to_string()]);
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].id, "bad");
        assert!(outcome.failed[0].error.contains("permission denied"));
        assert_eq!(catalog_ids(&db).await, vec!["bad"]);
    }

    /// One file that cannot be moved must not cost a Finder call per file in
    /// its batch: the batch is split until the bad file is isolated.
    #[tokio::test]
    async fn one_bad_file_is_isolated_by_splitting_not_per_file_retries() {
        let db = test_db().await;
        let dir = temp_dir("split");
        let mut targets = Vec::new();
        for index in 0..super::TRASH_BATCH {
            let id = format!("item-{index:03}");
            let path = dir.join(format!("{id}.jpg"));
            write_file(&path);
            insert_item(&db, &id, &path).await;
            targets.push((id, path.to_string_lossy().into_owned()));
        }
        let bad = targets[137].1.clone();
        let fake = Arc::new(FakeTrash {
            fail_paths: HashSet::from([bad]),
            ..FakeTrash::default()
        });
        let sink: Arc<dyn TrashSink> = fake.clone();
        let group = CancelGroup::default();
        let cancel = group.start();

        let outcome = execute_trash(&db, targets.clone(), sink, &cancel, |_, _, _| {})
            .await
            .expect("trash targets");

        assert_eq!(outcome.trashed.len(), super::TRASH_BATCH - 1);
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].id, "item-137");
        assert_eq!(outcome.failed[0].code, crate::errors::ErrorCode::Io);
        // The original batch, then two calls per halving level down to one
        // file: far below one call per file (200).
        assert!(
            fake.calls() <= 1 + 2 * 8,
            "expected a handful of Finder calls, got {}",
            fake.calls()
        );
        // Order is preserved for everything that moved.
        let expected: Vec<String> = targets
            .iter()
            .map(|(id, _)| id.clone())
            .filter(|id| id != "item-137")
            .collect();
        assert_eq!(outcome.trashed, expected);
    }

    /// A panicking sink makes `spawn_blocking` return a JoinError. Every id in
    /// that chunk must be reported, otherwise the rows stay in the catalog
    /// while the UI believes nothing happened to them.
    struct PanickingTrash;

    impl TrashSink for PanickingTrash {
        fn delete_all(&self, _paths: &[String]) -> Result<(), CommandError> {
            panic!("trash backend panicked");
        }
    }

    #[tokio::test]
    async fn a_panicking_trash_reports_every_id_in_the_chunk() {
        let db = test_db().await;
        let dir = temp_dir("panic");
        let mut targets = Vec::new();
        for name in ["a", "b", "c"] {
            let path = dir.join(format!("{name}.jpg"));
            write_file(&path);
            insert_item(&db, name, &path).await;
            targets.push((name.to_string(), path.to_string_lossy().into_owned()));
        }

        let sink: Arc<dyn TrashSink> = Arc::new(PanickingTrash);
        let group = CancelGroup::default();
        let cancel = group.start();
        let outcome = execute_trash(&db, targets, sink, &cancel, |_, _, _| {})
            .await
            .expect("trash targets");

        assert!(outcome.trashed.is_empty());
        let ids: Vec<&str> = outcome.failed.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"], "every id must be reported");
        assert!(outcome.failed[0].error.contains("Trash task failed"));
        // Nothing was reported as trashed, so every row must still be there.
        assert_eq!(catalog_ids(&db).await, vec!["a", "b", "c"]);
    }

    /// The files are already in the Trash when the catalog update runs, so a
    /// failure there is a warning, not a failed delete.
    #[tokio::test]
    async fn a_catalog_failure_is_a_warning_not_a_failed_delete() {
        let db = test_db().await;
        let dir = temp_dir("catalog");
        let a = dir.join("a.jpg");
        write_file(&a);
        insert_item(&db, "a", &a).await;
        sqlx::query("DROP TABLE edit_backups")
            .execute(&db)
            .await
            .expect("drop edit_backups");

        let sink: Arc<dyn TrashSink> = Arc::new(FakeTrash::default());
        let group = CancelGroup::default();
        let cancel = group.start();
        let outcome = execute_trash(
            &db,
            vec![("a".to_string(), a.to_string_lossy().into_owned())],
            sink,
            &cancel,
            |_, _, _| {},
        )
        .await
        .expect("a catalog failure must not fail the delete");

        assert_eq!(outcome.trashed, vec!["a".to_string()]);
        let warning = outcome.catalog_error.expect("catalog warning expected");
        assert!(
            warning.contains("could not"),
            "warning should explain the failure: {warning}"
        );
    }

    /// Cancel must stop a trash run between batches — and only that run.
    #[tokio::test]
    async fn cancelling_a_trash_run_stops_between_batches_and_spares_other_runs() {
        let db = test_db().await;
        let dir = temp_dir("cancel");
        let group = Arc::new(CancelGroup::default());

        // One more target than a batch crosses the batch boundary exactly once.
        let mut targets = Vec::new();
        for index in 0..=super::TRASH_BATCH {
            let id = format!("item-{index:03}");
            let path = dir.join(format!("{id}.jpg"));
            write_file(&path);
            insert_item(&db, &id, &path).await;
            targets.push((id, path.to_string_lossy().into_owned()));
        }

        let fake = Arc::new(FakeTrash::default());
        let sink: Arc<dyn TrashSink> = fake.clone();
        let cancel = group.start();
        // `execute_trash`'s progress callback is `Fn`, so count with an atomic.
        let batches = std::sync::atomic::AtomicUsize::new(0);
        let outcome = execute_trash(&db, targets.clone(), sink, &cancel, |_, _, current| {
            // The final summary call passes no current file; only count batches.
            if current.is_some() {
                batches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // Cancel after the first batch has been handed to Finder.
                group.cancel_all();
            }
        })
        .await
        .expect("trash targets");

        assert_eq!(
            batches.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the cancel is seen before the second batch"
        );
        assert_eq!(outcome.trashed.len(), super::TRASH_BATCH);
        assert_eq!(
            fake.moved().len(),
            super::TRASH_BATCH,
            "the cancelled batch must never reach the trash backend"
        );
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(
            outcome.failed[0].id,
            format!("item-{:03}", super::TRASH_BATCH)
        );
        assert_eq!(outcome.failed[0].code, crate::errors::ErrorCode::Cancelled);

        // A run that starts after the cancel owns a fresh flag and completes.
        let after = group.start();
        assert!(!after.is_cancelled());
        let extra = dir.join("after.jpg");
        write_file(&extra);
        insert_item(&db, "after", &extra).await;
        let second_fake = Arc::new(FakeTrash::default());
        let outcome = execute_trash(
            &db,
            vec![("after".to_string(), extra.to_string_lossy().into_owned())],
            second_fake.clone(),
            &after,
            |_, _, _| {},
        )
        .await
        .expect("second trash run");

        assert_eq!(outcome.trashed, vec!["after".to_string()]);
        assert_eq!(second_fake.moved().len(), 1);
        assert!(outcome.failed.is_empty());
    }

    /// The fallback decision depends on this classifier: only a refused
    /// Automation permission means no file has moved yet.
    #[cfg(target_os = "macos")]
    #[test]
    fn apple_events_denials_are_recognised() {
        use super::is_apple_events_denied;

        assert!(is_apple_events_denied(
            "execution error: Not authorized to send Apple events to Finder. (-1743)"
        ));
        assert!(is_apple_events_denied(
            "0:67: execution error: Finder got an error: Not allowed to send Apple events to Finder. (-1743)"
        ));
        assert!(is_apple_events_denied("osascript: error -1743"));
        // A missing file must keep its error so the per-file retry can report
        // the real reason instead of silently re-trashing the batch.
        assert!(!is_apple_events_denied(
            "execution error: Finder got an error: Can’t get POSIX file \"/tmp/gone.jpg\". (-1728)"
        ));
    }
}
