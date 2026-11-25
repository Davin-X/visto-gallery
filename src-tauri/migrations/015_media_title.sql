-- Optional human-readable title for media items, synced with XMP sidecars (dc:title).
ALTER TABLE media_items ADD COLUMN title TEXT;
