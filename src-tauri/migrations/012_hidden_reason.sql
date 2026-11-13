-- Why an item is hidden. NULL means "no reason recorded" (older rows, or rules
-- in the future that never write one). Today every app-driven hide is
-- 'manual'; the column exists so a rule engine can set its own reason later.
ALTER TABLE media_items ADD COLUMN hidden_reason TEXT;
