-- Migration: Rating and color label columns
-- Adds per-item rating (0-5 stars) and color label (red/yellow/green/blue/purple)
-- for culling workflows. Both are nullable: NULL = unrated/unlabeled.

ALTER TABLE media_items ADD COLUMN rating INTEGER CHECK (rating >= 0 AND rating <= 5);
ALTER TABLE media_items ADD COLUMN color_label TEXT CHECK (color_label IN ('red', 'yellow', 'green', 'blue', 'purple'));

-- Indexes for fast filtering by rating and color label
CREATE INDEX IF NOT EXISTS idx_media_rating ON media_items (rating);
CREATE INDEX IF NOT EXISTS idx_media_color_label ON media_items (color_label);

-- Composite index for rating-based smart album queries
CREATE INDEX IF NOT EXISTS idx_media_rating_captured ON media_items (rating DESC, captured_at DESC);
