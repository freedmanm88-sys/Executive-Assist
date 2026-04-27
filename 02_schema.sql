-- =============================================================
-- AI Personal Assistant — Multi-tenant Schema v1
-- Phase 1 ships with this schema. Later phases add tables, never alter.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";  -- for future embedding-based memory

-- =============================================================
-- TENANCY
-- =============================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE NOT NULL,
    full_name       TEXT,
    telegram_chat_id BIGINT UNIQUE,           -- routes inbound Telegram to user
    telegram_bot_token TEXT,                  -- per-user bot for Phase 1-4
    plan            TEXT NOT NULL DEFAULT 'beta',  -- 'beta', 'free', 'paid', 'unlimited'
    is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
    tax_region      TEXT NOT NULL DEFAULT 'CA-ON',  -- ISO 3166-2
    timezone        TEXT NOT NULL DEFAULT 'America/Toronto',
    home_address    TEXT,                     -- for mileage origin
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ              -- soft delete for PIPEDA right-to-deletion
);

-- Per-user configurable settings. Anything user-tunable lives here.
CREATE TABLE user_settings (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    quiet_hours_start TIME DEFAULT '22:00',
    quiet_hours_end TIME DEFAULT '07:00',
    digest_time     TIME DEFAULT '07:00',
    away_trigger    JSONB DEFAULT '{"evenings": true, "weekends": true, "business_dinner": true}'::jsonb,
    auto_archive_enabled BOOLEAN DEFAULT FALSE,  -- phase 1 stays false, dry-run only
    archive_dryrun  BOOLEAN DEFAULT TRUE,
    nag_interval_hours INT DEFAULT 2,
    settings        JSONB DEFAULT '{}'::jsonb    -- catch-all for future
);

-- People to inform when user is "away" (default: spouse)
CREATE TABLE away_invitees (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    relationship    TEXT,                     -- 'spouse', 'partner', 'assistant'
    auto_invite     BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_away_invitees_user ON away_invitees(user_id);

-- Workspaces: opt-in shared resources between trusted users
CREATE TABLE workspaces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    owner_id        UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE workspace_members (
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'member',  -- 'owner', 'admin', 'member'
    joined_at       TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workspace_resources (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    resource_type   TEXT NOT NULL,            -- 'gdrive_folder', 'category_set', 'vendor_list'
    resource_data   JSONB NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================
-- CREDENTIALS (encrypted, per-user)
-- Phase 1: minimal — just connections. Tokens encrypted by app code, not Postgres.
-- =============================================================

CREATE TABLE user_credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service         TEXT NOT NULL,            -- 'gmail', 'gcal', 'qbo', 'gdrive'
    label           TEXT NOT NULL,            -- 'personal', 'business1', 'business2'
    oauth_payload   JSONB NOT NULL,           -- encrypted at rest by app layer
    extra           JSONB DEFAULT '{}'::jsonb,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, service, label)
);
CREATE INDEX idx_user_credentials_lookup ON user_credentials(user_id, service);

-- =============================================================
-- BUSINESSES (per-user)
-- =============================================================

CREATE TABLE businesses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,            -- "Acme Corp", "Heath Consulting"
    qbo_credential_id UUID REFERENCES user_credentials(id),
    default_mileage_purpose TEXT DEFAULT 'Client meeting',
    cra_mileage_rate_cents INT DEFAULT 72,    -- 2026 CRA rate, first 5000km
    cra_mileage_rate_cents_excess INT DEFAULT 66,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_businesses_user ON businesses(user_id);

-- =============================================================
-- EMAIL ACCOUNTS (per-user, multiple per user)
-- =============================================================

CREATE TABLE gmail_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id   UUID NOT NULL REFERENCES user_credentials(id) ON DELETE CASCADE,
    label           TEXT NOT NULL,            -- 'personal', 'business1', 'business2'
    address         TEXT NOT NULL,
    associated_business_id UUID REFERENCES businesses(id),  -- nullable for personal
    triage_persona  TEXT NOT NULL DEFAULT 'standard',       -- per-account triage style
    last_synced_at  TIMESTAMPTZ,
    last_history_id BIGINT,                   -- Gmail history pointer
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, address)
);
CREATE INDEX idx_gmail_accounts_user ON gmail_accounts(user_id);

-- =============================================================
-- EMAIL TRIAGE
-- =============================================================

CREATE TABLE email_triage_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gmail_account_id UUID NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
    gmail_message_id TEXT NOT NULL,
    gmail_thread_id TEXT,
    subject         TEXT,
    sender_email    TEXT,
    sender_name     TEXT,
    received_at     TIMESTAMPTZ NOT NULL,
    classification  TEXT NOT NULL,            -- 'urgent', 'action', 'reply_needed', 'fyi', 'newsletter', 'receipt', 'calendar', 'spam'
    reasoning       TEXT,                     -- one-sentence justification
    labels_applied  TEXT[],
    archived        BOOLEAN DEFAULT FALSE,    -- actually archived
    would_archive   BOOLEAN DEFAULT FALSE,    -- dry-run flag
    decision_id     UUID,                     -- → ai_decisions for feedback
    processed_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, gmail_message_id)
);
CREATE INDEX idx_triage_user_received ON email_triage_log(user_id, received_at DESC);
CREATE INDEX idx_triage_classification ON email_triage_log(user_id, classification, processed_at DESC);

CREATE TABLE urgent_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    triage_log_id   UUID NOT NULL REFERENCES email_triage_log(id) ON DELETE CASCADE,
    summary         TEXT NOT NULL,
    first_pinged_at TIMESTAMPTZ DEFAULT NOW(),
    last_pinged_at  TIMESTAMPTZ DEFAULT NOW(),
    ping_count      INT DEFAULT 1,
    acknowledged_at TIMESTAMPTZ,
    ack_method      TEXT                      -- 'button', 'reply', 'gmail_action', 'snooze'
);
CREATE INDEX idx_urgent_queue_active ON urgent_queue(user_id, acknowledged_at) WHERE acknowledged_at IS NULL;

CREATE TABLE archive_decisions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    triage_log_id   UUID NOT NULL REFERENCES email_triage_log(id) ON DELETE CASCADE,
    decided_at      TIMESTAMPTZ DEFAULT NOW(),
    executed        BOOLEAN DEFAULT FALSE,    -- TRUE when actually moved to archive
    reverted        BOOLEAN DEFAULT FALSE     -- TRUE if user pulled back to inbox
);

CREATE TABLE reply_drafts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    triage_log_id   UUID NOT NULL REFERENCES email_triage_log(id) ON DELETE CASCADE,
    draft_text      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending_review',  -- 'pending_review', 'approved', 'edited', 'discarded', 'in_gmail_drafts'
    gmail_draft_id  TEXT,                     -- once moved to Gmail Drafts
    user_edits      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    finalized_at    TIMESTAMPTZ
);

-- =============================================================
-- SENDERS (learned profile per user × sender)
-- =============================================================

CREATE TABLE sender_profiles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    display_name    TEXT,
    relationship    TEXT,                     -- 'spouse', 'family', 'client', 'vendor', 'newsletter', 'unknown'
    typical_urgency TEXT,                     -- learned: 'high', 'medium', 'low'
    never_archive   BOOLEAN DEFAULT FALSE,
    always_urgent   BOOLEAN DEFAULT FALSE,
    notes           TEXT,
    avg_reply_time_hours INT,                 -- for follow-up logic
    last_interaction_at TIMESTAMPTZ,
    interaction_count INT DEFAULT 0,
    UNIQUE (user_id, email)
);
CREATE INDEX idx_sender_profiles_user ON sender_profiles(user_id, email);

-- =============================================================
-- HABITS / REMINDERS / TASKS
-- =============================================================

CREATE TABLE habits (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    cadence         TEXT NOT NULL,
    target_per_week INT DEFAULT 7,
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_habits_user ON habits(user_id);

CREATE TABLE habit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    habit_id        UUID NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    completed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note            TEXT,
    source          TEXT DEFAULT 'telegram'
);
CREATE INDEX idx_habit_logs_user_time ON habit_logs(user_id, completed_at DESC);

CREATE TABLE reminders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text            TEXT NOT NULL,
    schedule        TEXT NOT NULL,
    schedule_type   TEXT NOT NULL,            -- 'cron', 'once', 'birthday', 'holiday'
    next_fire_at    TIMESTAMPTZ,
    last_fired_at   TIMESTAMPTZ,
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_reminders_user_next ON reminders(user_id, next_fire_at) WHERE active = TRUE;

CREATE TABLE tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    notes           TEXT,
    due_at          TIMESTAMPTZ,
    priority        INT DEFAULT 3,
    status          TEXT DEFAULT 'open',
    source          TEXT,                     -- 'manual', 'email:<msg_id>', 'voice', 'meeting:<id>'
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tasks_user_status ON tasks(user_id, status, due_at);

CREATE TABLE birthdays (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    birth_month     INT NOT NULL,
    birth_day       INT NOT NULL,
    birth_year      INT,                      -- nullable
    relationship    TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_birthdays_user_date ON birthdays(user_id, birth_month, birth_day);

CREATE TABLE holidays (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region          TEXT NOT NULL,            -- 'CA-ON', 'CA-BC', 'US-NY', etc.
    name            TEXT NOT NULL,
    holiday_date    DATE NOT NULL,
    is_statutory    BOOLEAN DEFAULT TRUE,
    UNIQUE (region, name, holiday_date)
);
CREATE INDEX idx_holidays_region_date ON holidays(region, holiday_date);

-- Seed: Ontario stat holidays for 2026
INSERT INTO holidays (region, name, holiday_date) VALUES
    ('CA-ON', 'New Year''s Day', '2026-01-01'),
    ('CA-ON', 'Family Day', '2026-02-16'),
    ('CA-ON', 'Good Friday', '2026-04-03'),
    ('CA-ON', 'Victoria Day', '2026-05-18'),
    ('CA-ON', 'Canada Day', '2026-07-01'),
    ('CA-ON', 'Civic Holiday', '2026-08-03'),
    ('CA-ON', 'Labour Day', '2026-09-07'),
    ('CA-ON', 'Thanksgiving', '2026-10-12'),
    ('CA-ON', 'Christmas Day', '2026-12-25'),
    ('CA-ON', 'Boxing Day', '2026-12-28');  -- observed Mon since 25 is Fri

-- =============================================================
-- CALENDAR + MILEAGE (Phase 3)
-- =============================================================

CREATE TABLE calendar_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gcal_credential_id UUID REFERENCES user_credentials(id),
    gcal_event_id   TEXT,
    title           TEXT NOT NULL,
    location        TEXT,
    start_at        TIMESTAMPTZ NOT NULL,
    end_at          TIMESTAMPTZ,
    associated_business_id UUID REFERENCES businesses(id),
    is_business     BOOLEAN DEFAULT FALSE,
    mark_away       BOOLEAN DEFAULT FALSE,
    away_invitees_added BOOLEAN DEFAULT FALSE,
    source          TEXT,                     -- 'manual', 'email:<msg_id>', 'voice'
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_cal_events_user_time ON calendar_events(user_id, start_at);

CREATE TABLE mileage_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    calendar_event_id UUID REFERENCES calendar_events(id),
    travel_date     DATE NOT NULL,
    origin_address  TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    distance_km     NUMERIC(8,2) NOT NULL,
    purpose         TEXT NOT NULL,
    return_trip     BOOLEAN DEFAULT TRUE,
    rate_cents_per_km INT,
    deductible_cents INT,                     -- distance × rate
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_mileage_user_date ON mileage_log(user_id, travel_date DESC);

-- =============================================================
-- RECEIPTS + STATEMENTS (Phase 4)
-- =============================================================

CREATE TABLE receipts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_id     UUID REFERENCES businesses(id),  -- NULL = personal
    photo_path      TEXT,                     -- Google Drive link
    vendor          TEXT,
    receipt_date    DATE,
    subtotal_cents  INT,
    tax_cents       INT,
    total_cents     INT,
    currency        TEXT DEFAULT 'CAD',
    category        TEXT,
    qbo_synced      BOOLEAN DEFAULT FALSE,
    qbo_expense_id  TEXT,
    decision_id     UUID,                     -- → ai_decisions
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_receipts_user_date ON receipts(user_id, receipt_date DESC);
CREATE INDEX idx_receipts_business ON receipts(business_id) WHERE business_id IS NOT NULL;

CREATE TABLE statements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_type     TEXT NOT NULL,            -- 'credit_card', 'bank', 'other'
    account_label   TEXT,
    period_start    DATE,
    period_end      DATE,
    file_path       TEXT,                     -- original PDF/photo in Drive
    parsed_at       TIMESTAMPTZ,
    raw_parse       JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE statement_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    statement_id    UUID NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
    txn_date        DATE NOT NULL,
    description     TEXT,
    amount_cents    INT NOT NULL,
    category        TEXT,
    matched_receipt_id UUID REFERENCES receipts(id),
    flagged_business BOOLEAN DEFAULT FALSE,   -- "could be business expense"
    decision_id     UUID
);
CREATE INDEX idx_stmt_txns_user_date ON statement_transactions(user_id, txn_date DESC);

-- =============================================================
-- AI DECISIONS + FEEDBACK LOOP
-- =============================================================

CREATE TABLE ai_decisions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain          TEXT NOT NULL,            -- 'email_triage', 'urgency', 'receipt_category', 'reply_draft', 'event_extract', 'statement_categorize'
    decision        JSONB NOT NULL,           -- what was picked
    reasoning       TEXT,                     -- one-sentence justification
    inputs          JSONB,                    -- snapshot
    model           TEXT,                     -- 'claude-opus-4-7' etc
    prompt_version  TEXT,                     -- for A/B-ish iteration
    feedback        TEXT,                     -- 'correct', 'wrong', 'adjusted', NULL
    feedback_note   TEXT,
    feedback_at     TIMESTAMPTZ,
    related_table   TEXT,                     -- 'email_triage_log', 'receipts'...
    related_id      UUID,
    learns          BOOLEAN DEFAULT TRUE,     -- whether this domain feeds the rule generator
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_ai_decisions_user_domain ON ai_decisions(user_id, domain, created_at DESC);
CREATE INDEX idx_ai_decisions_feedback_pending ON ai_decisions(user_id, created_at DESC) WHERE feedback IS NULL;

-- Hard rules (Level 1) — checked BEFORE Claude is called
CREATE TABLE triage_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain          TEXT NOT NULL,
    pattern_type    TEXT NOT NULL,            -- 'sender_email', 'sender_domain', 'subject_contains', 'body_contains', 'vendor_match'
    pattern_value   TEXT NOT NULL,
    action          TEXT NOT NULL,            -- 'always_urgent', 'never_archive', 'always_archive', 'category:Meals', 'route:business1'
    source_decision_id UUID REFERENCES ai_decisions(id),
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_triage_rules_user_domain ON triage_rules(user_id, domain) WHERE active = TRUE;

-- Soft preferences (Level 2/3) — injected into prompts
CREATE TABLE learned_preferences (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain          TEXT NOT NULL,
    preference      TEXT NOT NULL,
    confidence      FLOAT DEFAULT 0.5,
    derived_from_count INT DEFAULT 1,
    last_reinforced TIMESTAMPTZ DEFAULT NOW(),
    active          BOOLEAN DEFAULT TRUE
);
CREATE INDEX idx_learned_prefs_user_domain ON learned_preferences(user_id, domain) WHERE active = TRUE;

-- =============================================================
-- CONVERSATION + AGENT STATE
-- =============================================================

CREATE TABLE conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,            -- 'user', 'assistant', 'tool'
    content         TEXT NOT NULL,
    tool_calls      JSONB,
    related_decision_id UUID REFERENCES ai_decisions(id),  -- if this msg references a decision (for feedback)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_conversations_user_time ON conversations(user_id, created_at DESC);

CREATE TABLE agent_actions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool_name       TEXT NOT NULL,
    input           JSONB NOT NULL,
    output          JSONB,
    success         BOOLEAN,
    error           TEXT,
    duration_ms     INT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_agent_actions_user_time ON agent_actions(user_id, created_at DESC);

-- =============================================================
-- USAGE METERS (for plan enforcement and observability)
-- =============================================================

CREATE TABLE usage_meters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_month    DATE NOT NULL,            -- first day of month
    metric          TEXT NOT NULL,            -- 'claude_input_tokens', 'claude_output_tokens', 'maps_calls', 'whisper_seconds'
    quantity        BIGINT DEFAULT 0,
    cost_cents      INT DEFAULT 0,
    UNIQUE (user_id, period_month, metric)
);
CREATE INDEX idx_usage_user_period ON usage_meters(user_id, period_month);

-- =============================================================
-- AUDIT LOG (PIPEDA / compliance)
-- =============================================================

CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id),  -- nullable: system events
    actor_id        UUID REFERENCES users(id),  -- who DID it (admin or user themself)
    event_type      TEXT NOT NULL,
    event_data      JSONB,
    ip_address      INET,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_user_time ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_actor_time ON audit_log(actor_id, created_at DESC);

-- =============================================================
-- FUTURE SCOPE (empty tables, schema reserved)
-- =============================================================

-- Phase 6+: meeting transcripts and call notes
CREATE TABLE meetings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT,
    occurred_at     TIMESTAMPTZ,
    audio_path      TEXT,
    transcript      TEXT,
    summary         TEXT,
    action_items    JSONB,
    source          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================
-- VIEWS
-- =============================================================

CREATE OR REPLACE VIEW v_today AS
SELECT
    u.id AS user_id,
    (SELECT COUNT(*) FROM urgent_queue uq WHERE uq.user_id = u.id AND uq.acknowledged_at IS NULL) AS urgent_pending,
    (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id AND t.status = 'open' AND (t.due_at IS NULL OR t.due_at::date <= CURRENT_DATE)) AS tasks_due,
    (SELECT COUNT(*) FROM calendar_events ce WHERE ce.user_id = u.id AND ce.start_at::date = CURRENT_DATE) AS events_today,
    (SELECT COUNT(*) FROM birthdays b WHERE b.user_id = u.id AND b.birth_month = EXTRACT(MONTH FROM CURRENT_DATE) AND b.birth_day = EXTRACT(DAY FROM CURRENT_DATE)) AS birthdays_today
FROM users u WHERE u.deleted_at IS NULL;

-- Cluster admin view: aggregate decision quality
CREATE OR REPLACE VIEW v_admin_decision_quality AS
SELECT
    domain,
    DATE_TRUNC('day', created_at) AS day,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE feedback = 'correct') AS correct,
    COUNT(*) FILTER (WHERE feedback = 'wrong') AS wrong,
    COUNT(*) FILTER (WHERE feedback = 'adjusted') AS adjusted,
    COUNT(*) FILTER (WHERE feedback IS NULL) AS no_feedback,
    ROUND(100.0 * COUNT(*) FILTER (WHERE feedback = 'correct') / NULLIF(COUNT(*) FILTER (WHERE feedback IS NOT NULL), 0), 1) AS correct_pct
FROM ai_decisions
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY domain, DATE_TRUNC('day', created_at);

CREATE OR REPLACE VIEW v_admin_usage AS
SELECT
    period_month,
    metric,
    SUM(quantity) AS total_quantity,
    SUM(cost_cents) AS total_cost_cents,
    COUNT(DISTINCT user_id) AS users_active
FROM usage_meters
GROUP BY period_month, metric;

-- =============================================================
-- ROW-LEVEL SECURITY
-- =============================================================

-- Helper: set per-connection user context. n8n sets this at the start of each workflow.
CREATE OR REPLACE FUNCTION set_user_context(p_user_id UUID) RETURNS VOID AS $$
BEGIN
    PERFORM set_config('app.current_user_id', p_user_id::text, false);
    PERFORM set_config('app.is_admin',
        COALESCE((SELECT is_admin::text FROM users WHERE id = p_user_id), 'false'),
        false);
END;
$$ LANGUAGE plpgsql;

-- Helper to read context
CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_user_id', true), '')::UUID;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION current_is_admin() RETURNS BOOLEAN AS $$
BEGIN
    RETURN COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false);
EXCEPTION WHEN OTHERS THEN
    RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

-- Apply RLS to every per-user table
DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            'user_settings','away_invitees','user_credentials','businesses',
            'gmail_accounts','email_triage_log','urgent_queue','archive_decisions',
            'reply_drafts','sender_profiles','habits','habit_logs','reminders',
            'tasks','birthdays','calendar_events','mileage_log','receipts',
            'statements','statement_transactions','ai_decisions','triage_rules',
            'learned_preferences','conversations','agent_actions','usage_meters',
            'meetings'
        ])
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation ON %I
            USING (user_id = current_user_id())
            WITH CHECK (user_id = current_user_id())
        $p$, t);
    END LOOP;
END$$;

-- Admin-readable views: admin can SEE aggregates but NOT individual rows of others
-- (We grant SELECT on the views, but the views aggregate so no individual data leaks)
GRANT SELECT ON v_admin_decision_quality TO PUBLIC;
GRANT SELECT ON v_admin_usage TO PUBLIC;

-- =============================================================
-- SEED: bootstrap admin user (you)
-- Replace email + telegram_chat_id at deploy time
-- =============================================================
INSERT INTO users (email, full_name, plan, is_admin, tax_region, timezone)
VALUES ('REPLACE_ME@example.com', 'Heath', 'unlimited', TRUE, 'CA-ON', 'America/Toronto')
ON CONFLICT (email) DO NOTHING;

INSERT INTO user_settings (user_id)
SELECT id FROM users WHERE email = 'REPLACE_ME@example.com'
ON CONFLICT DO NOTHING;

-- Seed common preferences
INSERT INTO learned_preferences (user_id, domain, preference, confidence)
SELECT id, 'email_triage', 'User prefers concise summaries, not full email reproduction', 1.0
FROM users WHERE email = 'REPLACE_ME@example.com';

INSERT INTO learned_preferences (user_id, domain, preference, confidence)
SELECT id, 'urgency', 'Err on the side of NOT flagging urgent. Over-pinging is worse than missing one.', 1.0
FROM users WHERE email = 'REPLACE_ME@example.com';
