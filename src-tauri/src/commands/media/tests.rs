use super::*;

mod player_allowlist_tests {
    use super::{player_is_installed, ExternalPlayer};
    use std::fs;

    fn app_dir(root: &std::path::Path, name: &str) -> std::path::PathBuf {
        let app = root.join(name);
        fs::create_dir_all(&app).unwrap();
        app
    }

    fn player(path: &std::path::Path) -> ExternalPlayer {
        ExternalPlayer {
            name: "Allowed".to_string(),
            path: path.to_string_lossy().into_owned(),
        }
    }

    #[test]
    fn only_listed_players_are_accepted() {
        let root = std::env::temp_dir().join(format!("visto-player-{}", uuid::Uuid::new_v4()));
        let allowed = app_dir(&root, "Allowed.app");
        let other = app_dir(&root, "Other.app");
        let installed = vec![player(&allowed)];

        assert!(player_is_installed(&allowed.to_string_lossy(), &installed));
        assert!(!player_is_installed(&other.to_string_lossy(), &installed));
        assert!(!player_is_installed("/nonexistent/Evil.app", &installed));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_resolves_to_the_same_app() {
        let root = std::env::temp_dir().join(format!("visto-player-{}", uuid::Uuid::new_v4()));
        let allowed = app_dir(&root, "Allowed.app");
        let link = root.join("LooksAllowed.app");
        std::os::unix::fs::symlink(&allowed, &link).unwrap();
        let installed = vec![player(&allowed)];

        // A symlink back to the allowed app is the same app.
        assert!(player_is_installed(&link.to_string_lossy(), &installed));
        let _ = fs::remove_dir_all(&root);
    }
}

mod exif_text_tests {
    use super::{camera_name, clean_ascii_parts, parse_exif_datetime, parse_filename_timestamp};

    #[test]
    fn test_parse_filename_timestamp() {
        assert!(
            parse_filename_timestamp("2026-08-16_13-01-51_Devansh_Closeup_edited.jpg").is_some()
        );
        assert!(parse_filename_timestamp(
            "2026-08-30_00-45-52_Dev_Devansh_Birthday_Balloons_2_edited.jpg"
        )
        .is_some());
        assert!(parse_filename_timestamp("dji_2026-07-26_photo_0003_enhanced.jpg").is_some());
        assert!(parse_filename_timestamp("IMG_20260712_141840.jpg").is_some());
        assert_eq!(parse_filename_timestamp("unrelated_photo.jpg"), None);
        assert_eq!(parse_filename_timestamp("photo_2026_01.jpg"), None);
    }

    #[test]
    fn ascii_parts_lose_padding_and_empty_components() {
        assert_eq!(
            clean_ascii_parts(&[b"SONY\0".to_vec()]),
            Some("SONY".into())
        );
        let mut padded = vec![b"samsung".to_vec()];
        padded.extend(std::iter::repeat_n(Vec::new(), 24));
        assert_eq!(clean_ascii_parts(&padded), Some("samsung".into()));
        assert_eq!(clean_ascii_parts(&[b"  ".to_vec()]), None);
    }

    #[test]
    fn camera_name_avoids_repeating_the_make() {
        let name = |a: &str, b: &str| camera_name(Some(a.into()), Some(b.into()));
        assert_eq!(name("SONY", "DSC-RX10M3"), Some("SONY DSC-RX10M3".into()));
        assert_eq!(name("Canon", "Canon EOS R5"), Some("Canon EOS R5".into()));
        assert_eq!(
            camera_name(None, Some("AC006".into())),
            Some("AC006".into())
        );
    }

    #[test]
    fn exif_dates_parse_with_and_without_padding() {
        assert_eq!(
            parse_exif_datetime("2024:05:17 14:03:09"),
            Some(1_715_954_589_000)
        );
        assert_eq!(
            parse_exif_datetime("2024:05:17 14:03:09\0"),
            Some(1_715_954_589_000)
        );
        assert_eq!(parse_exif_datetime("0000:00:00 00:00:00"), None);
        assert_eq!(parse_exif_datetime("    :  :     :  :  "), None);
    }
}

mod export_source_tests {
    use super::validate_export_source;
    use crate::errors::ErrorCode;
    use std::fs;

    fn staging() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("visto-export-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_file_inside_staging() {
        let dir = staging();
        let file = dir.join("a_edited.jpg");
        fs::write(&file, b"x").unwrap();
        assert!(validate_export_source(file.to_str().unwrap(), &dir).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_dotdot_escape_from_staging() {
        let dir = staging();
        let outside =
            std::env::temp_dir().join(format!("visto-outside-{}.jpg", uuid::Uuid::new_v4()));
        fs::write(&outside, b"secret").unwrap();
        let sneaky = dir.join("..").join(outside.file_name().unwrap());
        let error = validate_export_source(sneaky.to_str().unwrap(), &dir)
            .expect_err("escape should be rejected");
        assert_eq!(error.code, ErrorCode::PathNotAllowed);
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_pointing_outside_staging() {
        let dir = staging();
        let outside =
            std::env::temp_dir().join(format!("visto-outside-{}.jpg", uuid::Uuid::new_v4()));
        fs::write(&outside, b"secret").unwrap();
        let link = dir.join("link.jpg");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(validate_export_source(link.to_str().unwrap(), &dir).is_err());
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_nested_and_directory_paths() {
        let dir = staging();
        let nested = dir.join("sub");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("b.jpg"), b"x").unwrap();
        assert!(validate_export_source(nested.join("b.jpg").to_str().unwrap(), &dir).is_err());
        assert!(validate_export_source(nested.to_str().unwrap(), &dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}

mod exif_tests {
    use super::{
        compute_sha256, read_exif_bytes, rewrite_orientation_to_one, write_jpeg_with_exif,
    };
    use image::ImageEncoder;
    use image::RgbImage;

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "visto-exif-test-{}-{}.jpg",
            label,
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn read_exif_bytes_returns_none_for_plain_jpeg() {
        let path = temp_path("plain");
        let img = RgbImage::new(4, 4);
        let mut buf = Vec::new();
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
        enc.write_image(img.as_raw(), 4, 4, image::ExtendedColorType::Rgb8)
            .unwrap();
        std::fs::write(&path, &buf).unwrap();

        assert!(read_exif_bytes(&path).is_none());
        let _ = std::fs::remove_file(&path);
    }

    fn exif_with_orientation(orientation: u16) -> Vec<u8> {
        // "Exif\0\0" + little-endian TIFF header with one SHORT entry:
        // tag 0x0112 (Orientation), type 3 (SHORT), count 1, value `orientation`.
        let mut exif = b"Exif\0\0II*\0\x08\0\0\0".to_vec();
        exif.extend(&1u16.to_le_bytes()); // one entry
        exif.extend(&0x0112u16.to_le_bytes()); // tag
        exif.extend(&3u16.to_le_bytes()); // type SHORT
        exif.extend(&1u32.to_le_bytes()); // count
        exif.extend(&orientation.to_le_bytes()); // value cell
        exif.extend(&[0, 0]); // value cell padding
        exif
    }

    #[test]
    fn rewrite_orientation_to_one_sets_orientation_to_one() {
        let exif = exif_with_orientation(6);
        let out = rewrite_orientation_to_one(&exif).expect("valid payload");
        // Orientation value is at offset 14 + 8 = 22 (TIFF header 8 bytes, entry 12).
        let entry = 6 + 8 + 2;
        assert_eq!(&out[entry + 8..entry + 10], &[0x01, 0x00]);
        assert_eq!(out.len(), exif.len());
    }

    #[test]
    fn rewrite_orientation_to_one_preserves_unrelated_tags_and_length() {
        let mut exif = exif_with_orientation(8);
        // Add a second entry: tag 0x010F (Make), type ASCII, count 4, value "x86\0".
        exif.extend(&0x010Fu16.to_le_bytes());
        exif.extend(&2u16.to_le_bytes());
        exif.extend(&4u32.to_le_bytes());
        exif.extend(b"x86\0");
        let out = rewrite_orientation_to_one(&exif).expect("valid payload");
        assert_eq!(out.len(), exif.len());
        assert_eq!(&out[0..6], b"Exif\0\0");
    }

    #[test]
    fn rewrite_orientation_to_one_rejects_malformed_payloads() {
        assert!(rewrite_orientation_to_one(b"not-exif").is_none());
        assert!(rewrite_orientation_to_one(b"").is_none());
    }

    #[test]
    fn write_jpeg_with_exif_produces_decodable_jpeg() {
        let path = temp_path("out");
        let img = RgbImage::new(4, 4);
        // An APP1 payload: "Exif\0\0" + minimal TIFF header (II + 42 + offset 8).
        let exif: &[u8] = b"Exif\0\0II*\0\x08\0\0\0";
        let mut file = std::fs::File::create(&path).unwrap();
        write_jpeg_with_exif(&mut file, &img, 80, exif).unwrap();
        drop(file);

        // Must decode as a valid JPEG.
        let decoded = image::ImageReader::open(&path)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!(decoded.width(), 4);
        assert_eq!(decoded.height(), 4);

        // And the EXIF must be recoverable.
        let recovered = read_exif_bytes(&path).expect("exif should be recoverable");
        assert!(recovered.starts_with(b"Exif\0\0"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_jpeg_with_exif_has_single_app0_and_app1() {
        let path = temp_path("seg");
        let img = RgbImage::new(2, 2);
        let exif: &[u8] = b"Exif\0\0II*\0\x08\0\0\0";
        let mut file = std::fs::File::create(&path).unwrap();
        write_jpeg_with_exif(&mut file, &img, 80, exif).unwrap();
        drop(file);

        let data = std::fs::read(&path).unwrap();
        // Count APP0 and APP1 markers.
        let mut app0 = 0;
        let mut app1 = 0;
        let mut i = 2;
        while i + 1 < data.len() {
            if data[i] == 0xFF {
                match data[i + 1] {
                    0xE0 => app0 += 1,
                    0xE1 => app1 += 1,
                    0xDA => break, // SOS: rest is scan data
                    _ => {}
                }
            }
            i += 1;
        }
        assert_eq!(app0, 1, "APP0 (JFIF) must appear exactly once");
        assert_eq!(app1, 1, "APP1 (EXIF) must appear exactly once");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn compute_sha256_produces_deterministic_hex() {
        let path =
            std::env::temp_dir().join(format!("visto-sha256-test-{}.bin", uuid::Uuid::new_v4()));
        let contents = b"hello world";
        std::fs::write(&path, contents).unwrap();

        let hash = compute_sha256(&path).expect("sha256 should be computed");
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert_eq!(hash, expected);

        // Same file → same hash.
        let hash2 = compute_sha256(&path).expect("sha256 should be computed");
        assert_eq!(hash, hash2);

        // Different content → different hash.
        std::fs::write(&path, b"goodbye world").unwrap();
        let hash3 = compute_sha256(&path).expect("sha256 should be computed");
        assert_ne!(hash, hash3);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn compute_sha256_returns_none_for_missing_file() {
        let path = std::path::Path::new("/tmp/does-not-exist-xyz123.bin");
        assert!(compute_sha256(path).is_none());
    }
}

mod in_place_format_tests {
    use super::validate_in_place_format;

    #[test]
    fn writable_formats_pass() {
        for path in ["a.jpg", "b.JPEG", "c.png", "d.webp", "/photos/e.Jpg"] {
            assert!(validate_in_place_format(path).is_ok(), "{path} should pass");
        }
    }

    #[test]
    fn unsupported_formats_are_rejected_with_save_a_copy_guidance() {
        for path in [
            "a.heic",
            "b.HEIC",
            "c.tif",
            "d.tiff",
            "e.avif",
            "f.bmp",
            "/x/g.unknown",
        ] {
            let err = validate_in_place_format(path).expect_err("should be rejected");
            assert!(
                err.message.contains("Save a copy"),
                "error for {path} should mention Save a copy, got: {err}"
            );
        }
    }

    #[test]
    fn files_without_extension_are_rejected() {
        assert!(validate_in_place_format("no_extension").is_err());
    }
}

mod edit_backup_tests {
    use super::ensure_edit_backup_in_dir;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::path::PathBuf;

    async fn test_db() -> sqlx::SqlitePool {
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
        let dir = std::env::temp_dir().join(format!(
            "visto-edit-backup-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[tokio::test]
    async fn first_edit_journals_the_original_only_once() {
        let db = test_db().await;
        let dir = temp_dir("once");
        let source = dir.join("photo.jpg");
        std::fs::write(&source, b"original-bytes").unwrap();
        sqlx::query("INSERT INTO media_items (id, path) VALUES ('item-1', ?)")
            .bind(source.to_string_lossy().into_owned())
            .execute(&db)
            .await
            .unwrap();

        let backup_dir = dir.join("originals");
        let backup =
            ensure_edit_backup_in_dir(&db, &backup_dir, "item-1", source.to_str().unwrap())
                .await
                .expect("journal original");
        assert_eq!(std::fs::read(&backup).unwrap(), b"original-bytes");

        // A second edit must keep the true original, not the first edit.
        std::fs::write(&source, b"first-edit").unwrap();
        let reused =
            ensure_edit_backup_in_dir(&db, &backup_dir, "item-1", source.to_str().unwrap())
                .await
                .expect("reuse journal");
        assert_eq!(reused, backup);
        assert_eq!(std::fs::read(&backup).unwrap(), b"original-bytes");
    }

    #[tokio::test]
    async fn missing_journaled_original_fails_closed() {
        let db = test_db().await;
        let dir = temp_dir("missing");
        let source = dir.join("photo.jpg");
        std::fs::write(&source, b"edited-bytes").unwrap();
        sqlx::query("INSERT INTO media_items (id, path) VALUES ('item-2', ?)")
            .bind(source.to_string_lossy().into_owned())
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO edit_backups (media_id, original_path, backup_path, size, sha256, created_at) VALUES ('item-2', ?, ?, 1, NULL, 1)",
        )
        .bind(source.to_string_lossy().into_owned())
        .bind(dir.join("originals").join("missing.jpg").to_string_lossy().into_owned())
        .execute(&db)
        .await
        .unwrap();

        let error = ensure_edit_backup_in_dir(
            &db,
            &dir.join("originals"),
            "item-2",
            source.to_str().unwrap(),
        )
        .await
        .expect_err("missing original should fail closed");
        assert!(error.message.contains("missing"));
    }
}

mod in_place_edit_tests {
    use super::*;

    fn work_dir(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("visto-in-place-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create work dir");
        dir
    }

    fn request_for(source: &std::path::Path) -> RenderRequest {
        RenderRequest {
            source_path: source.to_string_lossy().into_owned(),
            media_id: Some("item-1".to_string()),
            edits: EditValues::default(),
            output_format: "in_place".to_string(),
            quality: 90.0,
            strip_metadata: false,
            crop: None,
        }
    }

    #[test]
    fn in_place_edit_keeps_mode_and_extended_attributes() {
        let dir = work_dir("metadata");
        let source = dir.join("photo.png");
        image::RgbaImage::from_pixel(16, 16, image::Rgba([12, 34, 56, 255]))
            .save(&source)
            .expect("write source image");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o640))
                .expect("set mode");
        }
        let tag = "com.visto-gallery.test";
        let xattr_supported = xattr::set(&source, tag, b"keep-me").is_ok();

        let backup = dir.join("journaled-original.png");
        std::fs::write(&backup, b"journal").expect("write backup placeholder");
        let result = render_edited_blocking(request_for(&source), Some(backup.clone()))
            .expect("in-place edit should succeed");

        assert_eq!(result.output_path, source.to_string_lossy());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&source).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o640, "in-place edit must keep the file mode");
        }
        if xattr_supported {
            assert_eq!(
                xattr::get(&source, tag).unwrap().as_deref(),
                Some(&b"keep-me"[..]),
                "in-place edit must keep Finder tags and other xattrs"
            );
        }

        // The replacement must not leave its temp sibling behind, and the
        // journaled original must not be touched.
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "journaled-original.png".to_string(),
                "photo.png".to_string()
            ],
            "only the file and its journal may remain"
        );
        assert_eq!(std::fs::read(&backup).unwrap(), b"journal");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn in_place_edit_requires_a_journaled_original() {
        let dir = work_dir("no-journal");
        let source = dir.join("photo.png");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]))
            .save(&source)
            .expect("write source image");

        let error = match render_edited_blocking(request_for(&source), None) {
            Ok(_) => panic!("in-place edits without a journal must fail closed"),
            Err(error) => error,
        };
        assert!(error.message.contains("journaled original"));

        let _ = std::fs::remove_dir_all(dir);
    }
}
