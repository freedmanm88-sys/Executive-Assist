-- Migration 07 — habit sharing + seed accountability habits.
-- Canonical copy embedded in worker/src/migrations/07-habits-shared.ts; applied via POST /admin/migrate.

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
