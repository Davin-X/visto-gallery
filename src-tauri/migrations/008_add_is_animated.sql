-- Track whether the catalog should treat an item as animated content.
--
-- `kind` stays photo | video | raw (the 001 CHECK constraint is untouched):
-- this is an orthogonal property, not a new media kind.
--
-- New rows are classified from container headers by
-- `media_animation::detect_animation` (GIF frames, WebP VP8X flags, PNG acTL,
-- AVIF/HEIF ftyp brands). This migration runs *before* that code can touch old
-- rows, so it seeds the flag from the filename (`.gif`) as a conservative
-- first guess; the `backfill_animation_flags` startup pass then refines every
-- candidate row with the real probe and always wins.
ALTER TABLE media_items
ADD COLUMN is_animated INTEGER NOT NULL DEFAULT 0;

-- Seed existing catalogs so a library indexed before this migration is not
-- left entirely at 0. Idempotent by design.
UPDATE media_items
SET is_animated = 1
WHERE lower(extension) = 'gif'
  AND is_animated = 0;

-- Partial index: the animated view filters on `is_animated = 1`, and the vast
-- majority of rows are 0, so an index over the positives stays small.
CREATE INDEX IF NOT EXISTS idx_media_animated ON media_items (is_animated)
WHERE is_animated = 1;
