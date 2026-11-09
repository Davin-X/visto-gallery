-- Journal the original bytes of a file before its first in-place edit.
-- Keyed by media id (not path) so a rename or catalog restore keeps the
-- backup reachable, and so a second edit can never overwrite the true
-- original.
CREATE TABLE IF NOT EXISTS edit_backups (
    media_id TEXT PRIMARY KEY REFERENCES media_items (id) ON DELETE CASCADE,
    original_path TEXT NOT NULL,
    backup_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT,
    created_at INTEGER NOT NULL
);
