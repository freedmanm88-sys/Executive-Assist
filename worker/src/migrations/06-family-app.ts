/**
 * Migration 06 — Family App tables + Ashley user.
 *
 * Embedded as a string because the Docker build only copies src/ (no repo-root
 * migrations/ in the image). A copy lives at migrations/06_family_app.sql for
 * the record. Applied via POST /admin/migrate (idempotent — safe to re-run).
 *
 * Family tables are SHARED between family members, so their RLS policy only
 * requires that *a* valid user context is set (any family member sees all
 * family data), unlike the per-user tenant_isolation policy on personal tables.
 */

export const MIGRATION_06_NAME = '06_family_app';

export const MIGRATION_06_SQL = `
-- Ashley (user #2). Mark already exists (looked up by USER_ID at runtime).
INSERT INTO users (email, full_name, plan, is_admin, tax_region, timezone)
VALUES ('awronzberg@gmail.com', 'Ashley', 'unlimited', FALSE, 'CA-ON', 'America/Toronto')
ON CONFLICT (email) DO NOTHING;

INSERT INTO user_settings (user_id)
SELECT id FROM users WHERE email = 'awronzberg@gmail.com'
ON CONFLICT DO NOTHING;

-- Shared family tasks (distinct from per-user tasks table)
CREATE TABLE IF NOT EXISTS family_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    notes           TEXT,
    assigned_to     UUID REFERENCES users(id),      -- NULL = anyone
    due_at          TIMESTAMPTZ,
    priority        INT DEFAULT 3,                  -- 1 high, 3 normal, 5 low
    status          TEXT NOT NULL DEFAULT 'open',   -- 'open', 'done'
    created_by      UUID NOT NULL REFERENCES users(id),
    completed_at    TIMESTAMPTZ,
    completed_by    UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_family_tasks_status ON family_tasks(status, due_at);

-- Shared lists (grocery, shopping, packing, ...)
CREATE TABLE IF NOT EXISTS family_lists (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    kind            TEXT NOT NULL DEFAULT 'shopping',  -- 'shopping', 'todo', 'custom'
    created_by      UUID REFERENCES users(id),
    archived        BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS family_list_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id         UUID NOT NULL REFERENCES family_lists(id) ON DELETE CASCADE,
    text            TEXT NOT NULL,
    note            TEXT,
    done            BOOLEAN DEFAULT FALSE,
    done_by         UUID REFERENCES users(id),
    done_at         TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_family_list_items_list ON family_list_items(list_id, done, created_at);

-- Per-item discussion threads ("do we need the big bag?")
CREATE TABLE IF NOT EXISTS family_item_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id         UUID NOT NULL REFERENCES family_list_items(id) ON DELETE CASCADE,
    author_id       UUID NOT NULL REFERENCES users(id),
    body            TEXT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_family_item_comments_item ON family_item_comments(item_id, created_at);

-- Family calendar events created in the app (Google Calendar feeds are merged
-- read-only at the app layer via secret ICS URLs; those are not stored here)
CREATE TABLE IF NOT EXISTS family_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    location        TEXT,
    notes           TEXT,
    start_at        TIMESTAMPTZ NOT NULL,
    end_at          TIMESTAMPTZ,
    all_day         BOOLEAN DEFAULT FALSE,
    created_by      UUID REFERENCES users(id),
    source          TEXT DEFAULT 'manual',      -- 'manual', 'email:<msg_id>' later
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_family_events_start ON family_events(start_at);

-- Key-value settings for the family app (ICS feed URLs, etc.)
CREATE TABLE IF NOT EXISTS family_settings (
    key             TEXT PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: shared-family policy — any valid user context can read/write
DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            'family_tasks','family_lists','family_list_items',
            'family_item_comments','family_events','family_settings'
        ])
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'family_shared'
        ) THEN
            EXECUTE format($p$
                CREATE POLICY family_shared ON %I
                USING (current_user_id() IS NOT NULL)
                WITH CHECK (current_user_id() IS NOT NULL)
            $p$, t);
        END IF;
    END LOOP;
END$$;

-- Seed the two starter lists
INSERT INTO family_lists (name, kind) VALUES ('Grocery', 'shopping') ON CONFLICT (name) DO NOTHING;
INSERT INTO family_lists (name, kind) VALUES ('Shopping', 'shopping') ON CONFLICT (name) DO NOTHING;
`;
