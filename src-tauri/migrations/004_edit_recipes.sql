-- Migration: Edit recipes table
-- Persists per-item edit values, crop, and undo/redo history in SQLite
-- instead of localStorage, so edits survive across sessions and can be
-- copied between items.

CREATE TABLE IF NOT EXISTS edit_recipes (
    media_id TEXT PRIMARY KEY REFERENCES media_items (id) ON DELETE CASCADE,
    edits TEXT NOT NULL,        -- JSON EditValues
    crop TEXT,                  -- JSON CropState (nullable)
    history TEXT NOT NULL,      -- JSON EditValues[]
    history_index INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Index for fast lookup by media_id (already covered by PRIMARY KEY)
-- Index for batch operations (none needed beyond PK)

-- Edit presets (copy/paste recipes that can be applied to any item)
CREATE TABLE IF NOT EXISTS edit_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    edits TEXT NOT NULL,        -- JSON EditValues
    crop TEXT,                  -- JSON CropState (nullable)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Index for listing presets by name (fast alphabetical)
CREATE INDEX IF NOT EXISTS idx_edit_presets_name ON edit_presets (name);
