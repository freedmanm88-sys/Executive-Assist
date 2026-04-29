# Session Checkpoint — 2026-04-29 evening

**Status:** Paused mid Phase 1, deep into Workflow 3 (Email Triage) — Gmail OAuth fully wired, schema seeded, ready to draft the workflow JSON next session.

**Resume tomorrow at:** Build Workflow 3 (Email Triage for Gmail #1 / personal).

---

## Massive progress today

Started the day mid Phase 1 with just pgvector + n8n infrastructure. Ended with **Workflows 1, 2, 99 fully built, tested, and committed**, plus all 3 Gmail accounts wired through OAuth and seeded into the DB.

| Today's work | Status |
|---|---|
| Migration 03: bot_commands table | ✅ Applied |
| Workflow 1: Telegram Inbound Router (8 nodes, dynamic /help) | ✅ Built, active, tested all branches |
| Workflow 2: Chat Agent (Claude + tool use loop, 2 tools) | ✅ Built, end-to-end Telegram round trip verified |
| Wire W1 → W2 (default branch invokes Chat Agent) | ✅ Done |
| Workflow 99: Error Alerter (Telegram DM on any failure) | ✅ Built, ready to wire as default error workflow |
| n8n WebSocket fix (kill SSE flap) | ✅ Done via Dockerfile + env var |
| n8n attribution footer removed | ✅ `appendAttribution: false` on all Telegram nodes |
| Tightened Claude prompt (don't log on questions) | ✅ Updated W2 system prompt |
| Google Cloud OAuth (consent, scopes, client) | ✅ Done |
| 3 Gmail credentials in n8n vault | ✅ Saved (Freedman.m88, Sophax, MarkStonefield) |
| Migration 04: seed user_credentials + gmail_accounts | ✅ Applied (3 rows in gmail_accounts) |
| Git commit 070f3c0 + push | ✅ All pushed except migration 04 |

---

## Where the system stands

### Bot
`@jarvis_mork_bot` is fully functional. You can:
- `/help` → dynamic command list from `bot_commands` table
- `/today` `/urgent` `/rules` → "not built yet" placeholders
- `/admin` → admin placeholder (you're admin)
- Anything else → routes to Chat Agent (Workflow 2)
- Chat Agent has 2 tools: `create_habit`, `log_habit`. Tested both.

### Database
- pgvector running at `pgvector.railway.internal:5432`, DB `assistant`, user `assistant`
- Schema applied (33 tables) + RLS on every table
- 4 migrations applied: 02_schema, 03_bot_commands, 04_seed_gmail_accounts
- Seed user: Mark, UUID `591ebda6-7476-4dc6-8296-687eb4e13c57`, plan='unlimited', is_admin=TRUE
- Test data: 1 habit (`meditation`), 1 habit_log row, ~6 conversation rows, 5 bot_commands
- 3 gmail_accounts rows (personal/business1/business2) with placeholder user_credentials

### n8n
- Running on Railway at the host in `N8N_HOST` env var
- Custom Dockerfile (root user, baked `N8N_PUSH_BACKEND=websocket`)
- 4 active workflows: 01, 02, 99, ALL active
- Credentials in vault:
  - `Postgres - Executive Assistant`
  - `jarvis_mork_bot` (Telegram)
  - `ANTHROPIC_API`
  - `Freedman.m88`, `Sophax`, `MarkStonefield` (Gmail OAuth2)

### Repo
- Branch: `main`, all clean
- Last pushed commit: `070f3c0` (workflows 1+2+99 + migration 03 + Dockerfile)
- **Uncommitted as of pause:** `migrations/04_seed_gmail_accounts.sql` + this checkpoint
- Tomorrow: commit those + workflow 3 JSON when drafted

---

## Resume instructions for tomorrow

### Step 1 — Confirm state
```powershell
cd "C:\Users\freed\Claude Projects\Executive-Assist"
railway status   # should show: Executive Assistant, env=production, service=pgvector or n8n
git status       # should show only uncommitted = checkpoint + migration 04 (which we'll commit on resume)
```

### Step 2 — Verify infra still healthy
- Send `/help` to `@jarvis_mork_bot` → should reply with command list
- Send `Hello` → Chat Agent should respond

If either fails, debug before proceeding (most likely culprit: Railway free-plan idle restart, just hard-reload n8n editor and check executions).

### Step 3 — Build Workflow 3 (Email Triage)

The big lift. Architecture (per `03_DEPLOYMENT.md` lines 199-220):

```
[Schedule Trigger: every 5 min]
  ↓
[Get Personal Gmail Account]   -- Postgres: WHERE label='personal' AND active=TRUE
  ↓
[Set RLS Context]              -- using gmail_accounts.user_id
  ↓
[Gmail: List Recent Messages]  -- last hour, in:inbox, limit 20
  ↓
[Per message]:
  ├─ [Check email_triage_log]  -- skip if already triaged
  ├─ [Gmail: Get Message]      -- full headers + body
  ├─ [Build Claude Request]    -- with classify_email tool
  ├─ [Call Claude]
  ├─ [Parse Classification]
  ├─ [INSERT ai_decisions + email_triage_log]
  └─ [If urgent: Telegram alert + INSERT urgent_queue]
  ↓
[Update gmail_accounts.last_synced_at]
```

**Phase 1 MVP simplifications** (defer to Phase 2):
- ❌ No hard-rules engine (Phase 2)
- ❌ No sender_profiles lookup (Phase 2)
- ❌ No learned_preferences integration (Phase 2)
- ❌ No actual archive/label actions on Gmail (dry-run only — `would_archive=true` but `archived=false`)

**Tools for Claude classify call:**
```js
tools: [{
  name: 'classify_email',
  description: 'Classify an email and recommend action',
  input_schema: {
    type: 'object',
    properties: {
      classification:    { enum: ['urgent','action','reply_needed','fyi','newsletter','receipt','calendar','spam'] },
      urgency_score:     { type: 'integer', minimum: 0, maximum: 100 },
      reasoning:         { type: 'string' },
      suggested_action:  { enum: ['none','archive','label','reply','flag_for_review'] }
    },
    required: ['classification','urgency_score','reasoning','suggested_action']
  }
}],
tool_choice: { type: 'tool', name: 'classify_email' }
```

This forces Claude to return structured output. No second-call needed; the `classify_email` tool_use block IS the classification.

### Step 4 — Test Workflow 3 manually
- Don't activate immediately. Use a Manual Trigger node first to test.
- Run once → verify: ai_decisions has rows, email_triage_log has rows, no actual Gmail mutations.
- Send yourself a test email marked urgent → re-run → should fire Telegram alert.
- Once trusted, swap Manual Trigger for Schedule Trigger (5min) and activate.

### Step 5 — Duplicate Workflow 3 for business1 / business2
- n8n: open Workflow 3 → ⋯ → Duplicate
- Rename to `03b - Email Triage (Business1 / Sophax)`
- Change the Postgres "Get Gmail Account" query: `WHERE label='business1'`
- Change the Gmail node's credential: pick `Sophax`
- Save + activate. Repeat for business2 with `MarkStonefield`.

---

## Open decisions for tomorrow

1. **Cron interval** — 5min (per spec) or longer? 5min may be excessive for personal use. Recommend 15min initially, tune later.
2. **Volume limit per run** — default to 20 messages or pull all `newer_than:1h`? Start conservative.
3. **Urgent alert format** — single Telegram per urgent message, or one digest per run? Start with per-message; we already have a feedback loop in mind for "too many alerts."
4. **Archive action** — keep dry-run for at least 1 week before going live. Verify ai_decisions match reality first.

---

## Known gotchas & footguns

### 🚨 `railway redeploy` wipes pgvector volume
Use `railway restart`. ADR 0001.

### 🚨 Switch between `railway service` contexts is sticky
Earlier today I errored on `set_user_context does not exist` because the CLI was linked to n8n service, not pgvector. Always run `railway service` and pick before psql commands.

### 🚨 Gmail OAuth is in "Testing" mode in Google Cloud
Tokens expire weekly. n8n auto-refreshes via offline access scope, but if it ever fails, re-authorize from n8n's credential page.

### 🚨 Telegram trigger updates list
Set to `["message"]` only in W1's trigger. When we wire callback_query buttons (Workflow 6 feedback), add `"callback_query"` to the list.

### 🚨 n8n Postgres node returns 0 rows = "no data" → downstream stops
Workaround: `alwaysOutputData: true` on Postgres nodes that might legitimately return zero rows (Load History, Load Active Habits, Tool: log_habit).

### 🚨 Two parallel branches into one downstream node = node fires twice
Either chain them serially (cheaper) or use a Merge node (Append, 2 inputs) to consolidate.

### 🚨 n8n Telegram node adds "Powered by n8n" footer by default
Set `additionalFields.appendAttribution: false` on every Telegram Send node.

---

## Git status at pause

Last commit: `070f3c0 feat(phase-1): workflows 1+2+99, bot_commands migration, n8n WS push` (PUSHED)

**Uncommitted** (will commit at start of tomorrow OR right now if you want):
- `migrations/04_seed_gmail_accounts.sql`
- `docs/sessions/2026-04-29-evening-checkpoint.md` (this file)

To wrap and push:
```powershell
git add migrations/04_seed_gmail_accounts.sql docs/sessions/2026-04-29-evening-checkpoint.md
git commit -m "feat(phase-1): seed gmail_accounts + 2026-04-29 checkpoint"
git push
```

---

## What's left in Phase 1

| # | Task | Est |
|---|---|---|
| 1 | Build Workflow 3 (personal) + test | 1-2 hrs |
| 2 | Duplicate W3 for business1 + business2 | 30 min |
| 3 | Wire Workflow 99 as Error Workflow on W1, W2, W3 | 5 min |
| 4 | Workflows 4-8 (Urgent Nag, Daily Digest, Feedback Handler, Distillation, Admin) | 4-6 hrs |
| 5 | Expand Chat Agent tools (list_habits, create_reminder, create_task, etc.) | 2-3 hrs |
| 6 | End-to-end smoke test | 30 min |
| 7 | Write ADR for n8n custom Dockerfile decision (deferred) | 5 min |

Total remaining: ~10-15 hrs. Phase 1 wrap is in sight.
