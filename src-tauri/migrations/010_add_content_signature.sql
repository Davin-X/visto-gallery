-- Fingerprint of a file's bytes (size + sampled head and tail), recorded when
-- the file is imported or re-inspected.
--
-- A move or rename changes the path and therefore the path-derived id. The scan
-- uses this fingerprint to recognise the same file at its new path and re-point
-- the existing row instead of pruning it and importing a duplicate, so albums,
-- tags, ratings and the favourite flag survive the move.
--
-- Nullable on purpose: rows imported before this migration have no fingerprint
-- until their file is inspected again, and an unreadable file never gets one.
ALTER TABLE media_items ADD COLUMN content_signature TEXT;

CREATE INDEX IF NOT EXISTS idx_media_items_content_signature
    ON media_items(content_signature);
