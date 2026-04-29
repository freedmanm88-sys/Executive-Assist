-- Migration 04: seed gmail_accounts and user_credentials for Mark's 3 inboxes.
--
-- The user_credentials rows are placeholders — actual OAuth tokens live in
-- n8n's encrypted credential vault, not Postgres. We just need a row to
-- satisfy the FK on gmail_accounts.credential_id and to track which n8n
-- credential corresponds to which Gmail address (via extra.n8n_credential_name).
--
-- Run after applying 02_schema.sql and creating the user. Idempotent via
-- ON CONFLICT clauses so re-running won't double-seed.

SELECT set_user_context(
  (SELECT id FROM users WHERE email = 'mark@sophaxconsulting.com')::uuid
);

DO $$
DECLARE
  v_user_id           UUID;
  v_cred_personal_id  UUID;
  v_cred_business1_id UUID;
  v_cred_business2_id UUID;
BEGIN
  SELECT id INTO v_user_id
    FROM users
    WHERE email = 'mark@sophaxconsulting.com'
    LIMIT 1;

  -- user_credentials: 3 placeholder rows (one per Gmail account)
  INSERT INTO user_credentials (user_id, service, label, oauth_payload, extra)
  VALUES
    (v_user_id, 'gmail', 'personal',  '{"managed_by_n8n": true}'::jsonb, '{"n8n_credential_name": "Freedman.m88"}'::jsonb)
  ON CONFLICT (user_id, service, label) DO UPDATE SET extra = EXCLUDED.extra
  RETURNING id INTO v_cred_personal_id;

  INSERT INTO user_credentials (user_id, service, label, oauth_payload, extra)
  VALUES
    (v_user_id, 'gmail', 'business1', '{"managed_by_n8n": true}'::jsonb, '{"n8n_credential_name": "Sophax"}'::jsonb)
  ON CONFLICT (user_id, service, label) DO UPDATE SET extra = EXCLUDED.extra
  RETURNING id INTO v_cred_business1_id;

  INSERT INTO user_credentials (user_id, service, label, oauth_payload, extra)
  VALUES
    (v_user_id, 'gmail', 'business2', '{"managed_by_n8n": true}'::jsonb, '{"n8n_credential_name": "MarkStonefield"}'::jsonb)
  ON CONFLICT (user_id, service, label) DO UPDATE SET extra = EXCLUDED.extra
  RETURNING id INTO v_cred_business2_id;

  -- gmail_accounts: 3 rows linking a Gmail address to a user_credentials row
  INSERT INTO gmail_accounts (user_id, credential_id, label, address, triage_persona, active)
  VALUES
    (v_user_id, v_cred_personal_id,  'personal',  'freedman.m88@gmail.com',     'standard', TRUE),
    (v_user_id, v_cred_business1_id, 'business1', 'mark@sophaxconsulting.com',  'standard', TRUE),
    (v_user_id, v_cred_business2_id, 'business2', 'mark@stonefieldmortgage.ca', 'standard', TRUE)
  ON CONFLICT (user_id, address) DO UPDATE SET
    label          = EXCLUDED.label,
    triage_persona = EXCLUDED.triage_persona,
    active         = EXCLUDED.active;
END $$;

-- Verify
SELECT label, address, triage_persona, active, last_history_id
FROM gmail_accounts
ORDER BY label;
