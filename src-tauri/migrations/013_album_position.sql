-- Explicit album order on the Albums screen.
--
-- The list used to be `ORDER BY created_at`, which made a custom order
-- impossible. Every existing album is backfilled in creation order so nothing
-- jumps on first run; `create_album` then appends after the last row.
ALTER TABLE albums ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

UPDATE albums
SET position = (
    SELECT rn
    FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
        FROM albums
    ) AS ordered
    WHERE ordered.id = albums.id
);
