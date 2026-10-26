-- Migration: Backfill dimensions for photos
-- Only touches rows where width is 0 or NULL.
-- Note: This migration uses the image crate which runs in Rust, not pure SQL.
-- This file serves as documentation; the actual logic runs in Rust after migrations.

-- The actual backfill is performed in Rust code after migrations run,
-- because it requires the image crate to read file dimensions.
-- See Database::migrate() in db/mod.rs for the implementation.

-- This migration file exists to document the version and ensure
-- the backfill only runs once per database.
CREATE TABLE IF NOT EXISTS _migration_flags (
    name TEXT PRIMARY KEY,
    completed_at INTEGER NOT NULL
);

INSERT
OR IGNORE INTO _migration_flags (name, completed_at)
VALUES ('backfill_dimensions', 0);