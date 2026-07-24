/**
 * Migration 10 — email → proposed task/event bridge.
 *
 * When a PERSONAL-inbox email is classified action/calendar, Claude extracts
 * a proposed task or event. Proposals are family-shared: either member can
 * accept (creating a real family_task / family_event tagged with the email
 * source) or dismiss. Business inboxes never produce proposals. Idempotent.
 */

export const MIGRATION_10_NAME = '10_family_proposals';

export const MIGRATION_10_SQL = `
CREATE TABLE IF NOT EXISTS family_proposals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            TEXT NOT NULL,              -- 'task' | 'event'
    payload         JSONB NOT NULL,             -- extracted fields (title, due_date, date, time, ...)
    triage_log_id   UUID REFERENCES email_triage_log(id) ON DELETE CASCADE,
    subject         TEXT,
    sender_email    TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'dismissed'
    created_task_id  UUID,
    created_event_id UUID,
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_family_proposals_status ON family_proposals(status, created_at DESC);

DO $$
BEGIN
    EXECUTE 'ALTER TABLE family_proposals ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'family_proposals' AND policyname = 'family_shared'
    ) THEN
        EXECUTE $p$
            CREATE POLICY family_shared ON family_proposals
            USING (current_user_id() IS NOT NULL)
            WITH CHECK (current_user_id() IS NOT NULL)
        $p$;
    END IF;
END$$;
`;
