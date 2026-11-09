-- Index the default library sort.
--
-- Every library page filters on `hidden` and, by default, orders by the
-- capture date with the modification time as fallback, then by id. No index
-- matched `COALESCE(captured_at, modified_at)`, so each page scanned the whole
-- table and sorted it in a temporary B-tree. SQLite uses an expression index
-- when the query repeats the expression exactly, so this one serves the
-- default sort (and its keyset cursor) without a sort step.
CREATE INDEX IF NOT EXISTS idx_media_hidden_sort_date_id
    ON media_items (hidden, COALESCE(captured_at, modified_at) DESC, id);
