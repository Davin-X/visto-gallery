-- Initial schema for VistoGallery
-- Creates all tables and indexes

-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Media items table
CREATE TABLE IF NOT EXISTS media_items (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    extension TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (
        kind IN ('photo', 'video', 'raw')
    ),
    size INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    captured_at INTEGER,
    width INTEGER,
    height INTEGER,
    camera TEXT,
    lens TEXT,
    exposure TEXT,
    iso INTEGER,
    latitude REAL,
    longitude REAL,
    sha256 TEXT,
    favorite INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0,
    import_session_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Indexes for media_items
CREATE INDEX IF NOT EXISTS idx_media_path ON media_items (path);

CREATE INDEX IF NOT EXISTS idx_media_captured ON media_items (captured_at);

CREATE INDEX IF NOT EXISTS idx_media_kind ON media_items (kind);

CREATE INDEX IF NOT EXISTS idx_media_favorite ON media_items (favorite);

CREATE INDEX IF NOT EXISTS idx_media_hidden ON media_items (hidden);

CREATE INDEX IF NOT EXISTS idx_media_sha256 ON media_items (sha256);

CREATE INDEX IF NOT EXISTS idx_media_session ON media_items (import_session_id);
-- Composite indexes for paginated sorting
CREATE INDEX IF NOT EXISTS idx_media_captured_id ON media_items (
    COALESCE(captured_at, modified_at) DESC,
    id
);

CREATE INDEX IF NOT EXISTS idx_media_modified_id ON media_items (modified_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_media_name_id ON media_items (name COLLATE NOCASE, id);

CREATE INDEX IF NOT EXISTS idx_media_size_id ON media_items (size, id);

CREATE INDEX IF NOT EXISTS idx_media_kind_id ON media_items (kind, id);

-- Albums table
CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color_index INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Tags table
CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color_index INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Media-Tags join table
CREATE TABLE IF NOT EXISTS media_tags (
    media_id TEXT NOT NULL REFERENCES media_items (id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (media_id, tag_id)
);

-- Album-Items join table
CREATE TABLE IF NOT EXISTS album_items (
    album_id TEXT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media_items (id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (album_id, media_id)
);

-- Relation table indexes for efficient hydration
CREATE INDEX IF NOT EXISTS idx_media_tags_media ON media_tags (media_id);

CREATE INDEX IF NOT EXISTS idx_album_items_media ON album_items (media_id);

-- Import sessions table
-- Library folders table
CREATE TABLE IF NOT EXISTS library_folders (
    path TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);