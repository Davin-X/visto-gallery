-- Documentation-only follow-up to 008.
--
-- 008 seeds `is_animated` from the filename (`.gif`) because it runs before any
-- Rust code can look at file contents. That seed is only a first guess, and it
-- is deliberately left in place: SQLite migrations are immutable once applied,
-- and rewriting 008's comments after the fact broke existing catalogs with a
-- checksum mismatch.
--
-- The real classification is `media_animation::detect_animation`, which reads
-- container headers (GIF block walk, WebP VP8X flag, PNG acTL, AVIF/HEIF ftyp
-- brands). It runs at ingest for new rows and in the one-time
-- `backfill_animation_flags` startup pass for existing rows, which always wins
-- over the filename seed. A static `.gif` becomes 0 there, and animated
-- WebP/APNG/AVIF become 1.
--
-- This migration carries no schema change; the INSERT below only records the
-- flag row the Rust pass looks for, so the intent is visible in the catalog's
-- own migration history.
INSERT
OR IGNORE INTO _migration_flags (name, completed_at)
VALUES ('backfill_animation_flags', 0);
