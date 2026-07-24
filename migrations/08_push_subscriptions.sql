-- Migration 08 — web push subscriptions.
-- Canonical copy embedded in worker/src/migrations/08-push-subscriptions.ts; applied via POST /admin/migrate.

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint        TEXT NOT NULL UNIQUE,
    keys            JSONB NOT NULL,           -- { p256dh, auth }
    user_agent      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

DO $$
BEGIN
    EXECUTE 'ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'push_subscriptions' AND policyname = 'tenant_isolation'
    ) THEN
        EXECUTE $p$
            CREATE POLICY tenant_isolation ON push_subscriptions
            USING (user_id = current_user_id())
            WITH CHECK (user_id = current_user_id())
        $p$;
    END IF;
END$$;
