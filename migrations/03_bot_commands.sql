-- Migration 03: bot_commands table
-- Stores Telegram slash commands per user; powers dynamic /help and (future) BotFather sync.
-- Source of truth for "what commands does this user's bot expose?"

CREATE TABLE bot_commands (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command         TEXT NOT NULL,       -- e.g. '/today'  (always include leading slash)
  description     TEXT NOT NULL,       -- short help line, also pushed to BotFather
  workflow_name   TEXT,                -- informational, e.g. '05-daily-digest'
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,  -- controls /help visibility + bot routing
  admin_only      BOOLEAN NOT NULL DEFAULT FALSE,
  display_order   INT NOT NULL DEFAULT 100,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, command)
);

ALTER TABLE bot_commands ENABLE ROW LEVEL SECURITY;

CREATE POLICY bot_commands_user_isolation ON bot_commands
  FOR ALL TO PUBLIC
  USING       (user_id = current_user_id())
  WITH CHECK  (user_id = current_user_id());

CREATE INDEX idx_bot_commands_user_enabled
  ON bot_commands (user_id, enabled, display_order);

-- Touch updated_at on UPDATE
CREATE OR REPLACE FUNCTION bot_commands_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;

CREATE TRIGGER trg_bot_commands_updated_at
  BEFORE UPDATE ON bot_commands
  FOR EACH ROW EXECUTE FUNCTION bot_commands_touch_updated_at();

-- Seed for Mark (UUID 591ebda6-7476-4dc6-8296-687eb4e13c57)
-- Only /help enabled at start; toggle the rest as workflows ship.
INSERT INTO bot_commands (user_id, command, description, workflow_name, admin_only, display_order, enabled) VALUES
  ('591ebda6-7476-4dc6-8296-687eb4e13c57', '/today',  'today''s plan',          '05-daily-digest',     FALSE, 10, FALSE),
  ('591ebda6-7476-4dc6-8296-687eb4e13c57', '/urgent', 'urgent items needing action', '06-feedback-handler', FALSE, 20, FALSE),
  ('591ebda6-7476-4dc6-8296-687eb4e13c57', '/rules',  'your active triage rules',     null,                  FALSE, 30, FALSE),
  ('591ebda6-7476-4dc6-8296-687eb4e13c57', '/admin',  'admin dashboard',              '08-admin-dashboard',  TRUE,  40, FALSE),
  ('591ebda6-7476-4dc6-8296-687eb4e13c57', '/help',   'show this menu',               null,                  FALSE, 99, TRUE);
