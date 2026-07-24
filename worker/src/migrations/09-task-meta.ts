/**
 * Migration 09 — task/item provenance + categories.
 *
 * - source: where a row came from ('manual', 'assistant', later 'email:<id>')
 *   so the app can show provenance badges (Mark's ask).
 * - category on family_tasks: user-editable taxonomy (Family, Kids, Logan,
 *   Jackson, ...). The category list itself lives in family_settings
 *   'task_categories' so it's editable in the app without schema changes.
 * Idempotent.
 */

export const MIGRATION_09_NAME = '09_task_meta';

export const MIGRATION_09_SQL = `
ALTER TABLE family_tasks      ADD COLUMN IF NOT EXISTS source   TEXT DEFAULT 'manual';
ALTER TABLE family_tasks      ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE family_list_items ADD COLUMN IF NOT EXISTS source   TEXT DEFAULT 'manual';

INSERT INTO family_settings (key, value)
VALUES ('task_categories', '["Family","Kids","Logan","Jackson","Errands","Home"]'::jsonb)
ON CONFLICT (key) DO NOTHING;
`;
