-- Per-task checklists and subtasks. Plain ALTERs applied with foreign keys
-- disabled by the migration runner and checked before commit: existing rows
-- backfill via defaults, so no data rewrite is needed.
ALTER TABLE items ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]';
ALTER TABLE items ADD COLUMN parentId TEXT REFERENCES items(id);
CREATE INDEX items_parent ON items(parentId);
