-- Cleanup screen state.
--
-- `cleanup_ignored` is the "Never clean" list. It is keyed by the cleanup id
-- (a stable rule key, or `projects:`/`downloads:` plus an absolute path), so
-- an ignored row is refused at scan time and again at clean time. If this
-- table cannot be read, the backend refuses to scan or clean (fail closed).
CREATE TABLE IF NOT EXISTS cleanup_ignored (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- One row per cleanup run, newest kept. `moved_bytes` is what went to the
-- Trash, not what the disk gained: space returns when the Trash is emptied.
CREATE TABLE IF NOT EXISTS cleanup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finished_at INTEGER NOT NULL,
    removed_items INTEGER NOT NULL,
    moved_bytes INTEGER NOT NULL,
    failed_items INTEGER NOT NULL
);
