-- Migration 09 — task/item source + category.
-- Canonical copy embedded in worker/src/migrations/09-task-meta.ts; applied via POST /admin/migrate.

ALTER TABLE family_tasks      ADD COLUMN IF NOT EXISTS source   TEXT DEFAULT 'manual';
ALTER TABLE family_tasks      ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE family_list_items ADD COLUMN IF NOT EXISTS source   TEXT DEFAULT 'manual';

INSERT INTO family_settings (key, value)
VALUES ('task_categories', '["Family","Kids","Logan","Jackson","Errands","Home"]'::jsonb)
ON CONFLICT (key) DO NOTHING;
