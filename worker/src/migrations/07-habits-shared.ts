/**
 * Migration 07 — habit sharing for family accountability.
 *
 * Adds habits.shared: a shared habit is visible (read-only) to the other
 * family member in the family app, so Mark and Ashley can see each other's
 * check-ins. Seeds the two habits Mark asked for ('Hit step goal',
 * '10-min exercise') for every family member. Idempotent.
 */

export const MIGRATION_07_NAME = '07_habits_shared';

export const MIGRATION_07_SQL = `
ALTER TABLE habits ADD COLUMN IF NOT EXISTS shared BOOLEAN DEFAULT FALSE;

INSERT INTO habits (user_id, name, description, cadence, target_per_week, shared)
SELECT u.id, h.name, h.description, 'daily', 7, TRUE
FROM users u
CROSS JOIN (VALUES
    ('Hit step goal',   'Daily steps target'),
    ('10-min exercise', 'At least ten minutes of movement')
) AS h(name, description)
WHERE u.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM habits e WHERE e.user_id = u.id AND e.name = h.name
  );
`;
