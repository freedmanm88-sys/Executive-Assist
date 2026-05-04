# Session Checkpoint — 2026-04-30 evening

**Status:** Paused mid Phase 1. Worker service deployed and email triage end-to-end verified on personal Gmail. Ready to activate + scale to business inboxes.

**Resume tomorrow at:** Activate W3a (toggle to Active so it polls automatically) → duplicate W3 for business1/business2 → wire W99 as error handler.

---

## What changed today (massive day)

**Architecture pivot.** n8n was too painful for the Workflow 3 email triage build (paired-item issues, multi-statement query weirdness, JSON edit roundtrips). Pivoted to a **hybrid architecture** mid-session:

- **n8n** = thin integration layer (Telegram webhook + Gmail polling + OAuth refresh)
- **`worker/` service** = brain (classification logic, DB writes, future cron jobs)

Now n8n's W3 is just `[Gmail Trigger] → [HTTP Request to worker]` — 2 nodes. All complexity moved to TypeScript code I can iterate on cleanly.

| Today's work | Status |
|---|---|
| Migrated 03a from full n8n logic to thin Gmail Trigger → worker forwarder | ✅ Done |
| Scaffolded `worker/` service (TS strict, Express, pg, Anthropic SDK) | ✅ Done |
| Deployed worker as new Railway service | ✅ `worker-production-5e83.up.railway.app` |
| Wired auth via X-Internal-Auth Header Auth credential in n8n | ✅ Done |
| Fixed n8n service crash via `N8N_PROXY_HOPS=1` (X-Forwarded-For storm) | ✅ Done |
| Rotated leaked Telegram bot token (revoke → DB → n8n cred → webhook re-bind) | ✅ Done |
| Wrote ADR 0002 documenting n8n custom Dockerfile decision | ✅ Done |
| Added migration 04 seeding gmail_accounts + user_credentials for 3 inboxes | ✅ Applied |
| Worker fixed twice for n8n Gmail Trigger output quirks (Simplify, internalDate ISO) | ✅ Live |
| End-to-end real classifications verified | ✅ 3 emails, all reasonable |

**Three real classifications captured tonight:**
- BMO marketing → `newsletter`, urgency 0
- Borrowell credit card promo → `newsletter`, urgency 0
- GitHub PR notification → `fyi`, urgency 5

---

## Where the system stands

### Architecture
```
                           [Telegram User]
                                  ↓
                    [Telegram Bot API webhook]
                                  ↓
                       [n8n W1: Telegram Trigger]
                                  ↓
                       [n8n W2: Chat Agent (Claude + tools)]
                                  ↓
                       [Telegram reply]


                  [Gmail (3 accounts, polled)]
                                  ↓
              [n8n W3a/b/c: Gmail Trigger per account]
                                  ↓
                        HTTP POST + X-Internal-Auth
                                  ↓
                  [worker /events/gmail]
                            ┌─────┴─────┐
                            ↓           ↓
              [Anthropic Claude]    [pgvector RLS-protected]
              (classify_email)      ai_decisions + email_triage_log
                            ↓
            (if urgent) → Telegram alert + urgent_queue
```

### Railway services
| Service | Status | Notes |
|---|---|---|
| pgvector | 🟢 Online | Postgres + pgvector ext, schema applied, 4 migrations applied |
| n8n | 🟢 Online | 4 workflows active (W1, W2, W99, **W3a not yet active**) |
| **worker** (new) | 🟢 Online | TS service, `/healthz` + `/events/gmail` endpoints |

### n8n workflows
| Workflow | Status |
|---|---|
| 01 - Telegram Inbound Router | ✅ Active |
| 02 - Chat Agent | ✅ Active (handles all Telegram chat via 2 tools: create_habit, log_habit) |
| 99 - Error Alerter | ✅ Active (but NOT yet wired as error workflow on W1/W2/W3) |
| **03a - Email Triage (Personal)** | 🔵 **NOT YET ACTIVE** — tested manually, ready to flip on |
| 03b - Email Triage (Business1) | ⚪ Not built — duplicate of 03a |
| 03c - Email Triage (Business2) | ⚪ Not built — duplicate of 03a |

### Worker service
- Location: `worker/` in repo
- Public: `https://worker-production-5e83.up.railway.app`
- Endpoints:
  - `GET /healthz` (no auth)
  - `POST /events/gmail` (X-Internal-Auth required)
- TS strict mode, Express, pg, Anthropic SDK with prompt caching

### Database state (Phase 1, single user)
- 1 user (Mark, UUID `591ebda6-7476-4dc6-8296-687eb4e13c57`, plan='unlimited', is_admin=TRUE)
- 1 habit row (meditation, daily, target 7/wk)
- ~6 conversation rows from Chat Agent testing
- 5 bot_commands rows (only `/help` enabled)
- 3 gmail_accounts rows (personal/business1/business2)
- 3 email_triage_log rows from tonight's tests (BMO, Borrowell, GitHub)

### Credentials (n8n vault)
- `Postgres - Executive Assistant`
- `jarvis_mork_bot` (Telegram, **rotated token**)
- `ANTHROPIC_API`
- `Freedman.m88`, `Sophax`, `MarkStonefield` (Gmail OAuth2 — 3 inboxes)
- `Worker Internal Auth` (Header Auth, X-Internal-Auth → INTERNAL_AUTH_TOKEN)

### Repo state
- Branch: `main`, all clean
- Last 4 commits:
  - `882d3f7` fix(worker): convert Gmail internalDate (epoch ms) to ISO timestamp
  - `fcf7354` fix(worker): handle n8n Gmail Trigger Simplify=true output
  - `ba7ade6` docs(adr): n8n Dockerfile decision; snapshot W3a draft
  - `a28dec4` feat(worker): scaffold TS service for email triage
- All pushed to GitHub

---

## Resume instructions for tomorrow

### Step 1 — Confirm system still healthy
```powershell
cd "C:\Users\freed\Claude Projects\Executive-Assist"
railway status                                # confirm linked
Invoke-RestMethod "https://worker-production-5e83.up.railway.app/healthz"  # uptime should be small unless service slept
```

Send `/help` to `@jarvis_mork_bot` → should reply with command list. Send `Hello` → Chat Agent responds.

### Step 2 — Activate W3a (1 click)
n8n → `03a - Email Triage (Personal)` → toggle **Active** (top right). From this moment, new emails to `freedman.m88@gmail.com` get classified within ~1 min. Watch n8n's Executions tab for first 5-10 fires.

After 30 min of activity, check the DB:
```powershell
railway service pgvector
@"
SELECT set_user_context('591ebda6-7476-4dc6-8296-687eb4e13c57'::uuid);
SELECT
  etl.subject,
  etl.sender_email,
  etl.classification,
  (d.decision->>'urgency_score')::int AS urgency_score,
  etl.processed_at
FROM email_triage_log etl
JOIN ai_decisions d ON etl.decision_id = d.id
ORDER BY etl.processed_at DESC LIMIT 20;
"@ | railway ssh psql -U assistant -d assistant
```

If classifications look good, proceed to Step 3. If Claude is misclassifying patterns, tune the system prompt in `worker/src/classifiers/email-triage.ts` and push.

### Step 3 — Duplicate W3 for business1 + business2
n8n → `03a - Email Triage (Personal)` → ⋯ → **Duplicate** → rename to `03b - Email Triage (Business1 / Sophax)`:

1. **New Email** node → re-pick `Sophax` from the Gmail credential dropdown
2. **POST → Worker** node → edit the JSON body expression. Change `'personal'` to `'business1'`:
   ```js
   ={{ JSON.stringify({ gmail_account_label: 'business1', message: $json }) }}
   ```
3. Save → toggle **Active**

Repeat exactly the same for `03c - Email Triage (Business2 / Stonefield)` with credential `MarkStonefield` and label `'business2'`.

### Step 4 — Wire W99 as error workflow
For each of W1, W2, W3a, W3b, W3c:
- Open the workflow → ⋯ → **Settings** → **Error Workflow** dropdown → pick `99 - Error Alerter` → Save

5 minutes total. After this, any failure in any workflow lands in your Telegram with a formatted error + execution link.

### Step 5 — Close GitHub security alert
GitHub → Security tab → Telegram Bot Token alert → **Close as: Revoked** (the dead token in commits is harmless now).

### Step 6 (optional) — Tune the classifier
Watch tomorrow's classifications for a day or two. If Claude is consistently off in some pattern (e.g. labelling a specific sender wrong), edit `worker/src/classifiers/email-triage.ts` system prompt and push. Railway auto-redeploys.

---

## Phase 2 work (after W3 stable)

In rough priority order:

1. **Cron jobs in worker:**
   - Daily Digest (8 AM Toronto): summary of yesterday's triaged emails + habit progress + reminders due today
   - Urgent Nag (every 2 hr during waking hours): if `urgent_queue` has unacknowledged items, ping Telegram
   - Weekly Distillation (Sunday night): Claude reads last week's `ai_decisions.feedback` rows, proposes new triage_rules + learned_preferences

2. **Feedback handler:**
   - Telegram callback_query → `worker /events/feedback` → updates `ai_decisions.feedback`
   - Add ✅/❌/✏️ inline buttons to urgent email alerts

3. **Move Chat Agent to worker (optional but consistent):**
   - W1 becomes thin: Telegram Trigger → POST to worker
   - Chat agent logic moves to `worker/src/handlers/telegram-event.ts`
   - Tool dispatch becomes regular TS code (no Switch+Postgres node hellscape)

4. **Live archive actions** (no longer dry-run):
   - Worker calls Gmail API directly via OAuth tokens (need to OAuth in worker too)
   - Or: worker writes "queued_action" rows that an n8n action workflow reads and executes
   - Set `archived = TRUE` only after Gmail confirms

---

## Open decisions to revisit

1. **n8n Cron interval for Gmail Trigger** — community plan locks polling at ~1 min. Fine. Watch volume on the 3 inboxes; if too many Claude calls per day, cap by upping the polling interval explicitly when it's user-configurable.
2. **Claude model** — currently `claude-sonnet-4-5-20250929`. Could try newer 4.6/4.7 once API IDs confirmed; might trade up for chat agent (more nuanced) and stay on cheap for triage (volume).
3. **`worker/src/classifiers/email-triage.ts`** prompt — review accuracy after a few days of live data. Specifically watch: borderline newsletter-vs-fyi, and human-to-human work email handling.
4. **Whether to keep n8n W2 in n8n or move it** — works fine in n8n. Move only if we want full programmatic control of chat agent for new tools.

---

## Critical gotchas (re-read tomorrow)

### 🚨 `railway redeploy` wipes pgvector volume
ADR 0001. Use `restart`. (Worker redeploys are safe — no volume.)

### 🚨 `railway service` is sticky
Always `railway service pgvector` before psql, `railway service Worker` before logs/vars on worker.

### 🚨 Don't paste secrets into committed files
Use `<TOKEN_FROM_ENV_LOCAL>` placeholders. We had one Telegram token leak that we already rotated; don't repeat.

### 🚨 n8n Gmail Trigger "Simplify" toggle
Default ON, gives flat `From`/`Subject`/`text` top-level fields. Worker handles both shapes now. If Simplify gets toggled OFF, worker still works (falls back to payload.headers).

### 🚨 RLS context on every Postgres node in n8n
n8n uses connection pooling; `set_user_context()` doesn't carry across nodes. Either prepend it to every multi-statement query, OR move the work to the worker (which uses `withUserContext()` properly per-request).

### 🚨 Worker auth header is shared secret
INTERNAL_AUTH_TOKEN in `.env.local.txt` matches the one set on Railway Worker service AND the n8n Header Auth credential. If you ever rotate it, all three must update.

---

## Files modified today

| File | Change |
|---|---|
| `Dockerfile` | Already had `N8N_PUSH_BACKEND=websocket` from yesterday |
| `migrations/04_seed_gmail_accounts.sql` | New (committed yesterday) |
| `docs/decisions/0002-n8n-custom-dockerfile-root.md` | New ADR |
| `workflows/03a-email-triage-personal.json` | Replaced with thin 2-node version |
| `worker/**` (entire dir) | New service: ~12 files, TS strict, Express, pg, Anthropic SDK |

All pushed to `main`.

---

## What's left in Phase 1

| # | Task | Est |
|---|---|---|
| 1 | Activate W3a (1 click) | 10 sec |
| 2 | Duplicate W3 for business1 + business2 | 10 min |
| 3 | Wire W99 as error workflow on all 5 workflows | 5 min |
| 4 | Close GitHub security alert | 1 min |
| 5 | Watch classifications for a day, tune prompt if needed | passive |
| 6 | Phase 2 work — crons, feedback, expanded chat tools | 1-2 days focused |

Total remaining for "Phase 1 ready to live with": ~20 minutes of clicking + 1 day of passive observation.

Bot is officially useful from tomorrow when W3a activates. 🎉
