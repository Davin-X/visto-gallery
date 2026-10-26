-- Migration: Clean up settings
-- Remove stale vault_* keys, obsolete privacy toggles, and migrate thumbnail default

-- Remove stale vault_* keys
DELETE FROM settings WHERE key GLOB 'vault_*';

-- Remove obsolete privacy toggles that never controlled runtime behavior
DELETE FROM settings
WHERE
    key IN (
        'strip_gps_on_export',
        'strip_all_metadata_on_export',
        'allow_network_requests',
        'send_crash_reports'
    );

-- Migrate thumbnail_size default from 'medium' to 'small'
-- Only runs once (guarded by thumbnail_size_default_migrated flag)
UPDATE settings
SET
    value = 'small'
WHERE
    key = 'thumbnail_size'
    AND value = 'medium'
    AND NOT EXISTS (
        SELECT 1
        FROM settings
        WHERE
            key = 'thumbnail_size_default_migrated'
    );

-- Mark migration as complete
INSERT
OR IGNORE INTO settings (key, value)
VALUES (
        'thumbnail_size_default_migrated',
        '1'
    );