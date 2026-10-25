-- Migration: Migrate vault concept to hidden flag
-- The old "vault" was a UI label with a separate `in_vault` flag and an
-- unused `vault_items` table. Fold any existing flag into `hidden`, then
-- remove the dead schema so there is only one hiding concept.

-- Check if in_vault column exists and migrate
-- SQLite doesn't support IF EXISTS for ALTER TABLE, so we use a workaround

-- First, update hidden flag where in_vault was set
UPDATE media_items SET hidden = 1 WHERE in_vault = 1;

-- Drop the vault index if it exists
DROP INDEX IF EXISTS idx_media_vault;

-- Drop the in_vault column (SQLite supports this since 3.35.0)
-- If this fails on older SQLite, the migration will fail visibly
ALTER TABLE media_items DROP COLUMN in_vault;

-- Drop the unused vault_items table
DROP TABLE IF EXISTS vault_items;