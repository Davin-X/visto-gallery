-- Track whether the catalog should treat an item as animated content.
--
-- `kind` stays photo | video | raw (the 001 CHECK constraint is untouched):
-- this is an orthogonal property, not a new media kind.
--
-- v1 rule is extension-based and lives in Rust as `is_animated_extension`
-- (`src-tauri/src/commands/mod.rs`): only `.gif` sets the flag. Formats that
-- can be either still or animated (WebP, AVIF, APNG) stay 0 until real
-- multi-frame detection lands. Keep this UPDATE in sync with that helper.
ALTER TABLE media_items
ADD COLUMN is_animated INTEGER NOT NULL DEFAULT 0;

-- Backfill existing catalogs so a library indexed before this migration
-- behaves the same as one scanned after it. Idempotent by design.
UPDATE media_items
SET is_animated = 1
WHERE lower(extension) = 'gif'
  AND is_animated = 0;

-- Partial index: the animated view filters on `is_animated = 1`, and the vast
-- majority of rows are 0, so an index over the positives stays small.
CREATE INDEX IF NOT EXISTS idx_media_animated ON media_items (is_animated)
WHERE is_animated = 1;
