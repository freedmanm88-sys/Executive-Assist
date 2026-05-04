-- Migration 05: digest_runs table.
-- Tracks every time the worker runs a digest (daily summary, weekly distillation).
-- UNIQUE (user_id, digest_type, period_start) prevents duplicate digests if cron fires
-- twice within the same window.

CREATE TABLE digest_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_type         TEXT NOT NULL,            -- 'daily', 'weekly_distillation', etc.
  fired_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_start        TIMESTAMPTZ NOT NULL,
  period_end          TIMESTAMPTZ NOT NULL,
  summary             TEXT NOT NULL,
  metrics             JSONB,                    -- raw stats for posterity
  telegram_message_id BIGINT,                   -- if delivered, returned by sendMessage
  UNIQUE (user_id, digest_type, period_start)
);

ALTER TABLE digest_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY digest_runs_user_isolation ON digest_runs
  FOR ALL TO PUBLIC
  USING       (user_id = current_user_id())
  WITH CHECK  (user_id = current_user_id());

CREATE INDEX idx_digest_runs_user_period
  ON digest_runs(user_id, digest_type, period_start DESC);
