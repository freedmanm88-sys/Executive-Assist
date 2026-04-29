# Session Checkpoint — 2026-04-28 evening

**Status:** Paused mid Phase 1, prerequisites done, about to build Workflow 1.
**Resume tomorrow at:** Step 9d (run users-table UPDATE) → Step 9e (add Postgres credential to n8n) → Step 10 (build Workflow 1).

---

## Where we are

Phase 1 of the AI Personal Assistant deployment. Infrastructure is fully up. Bot is reachable. Tomorrow we start building actual workflows.

| Phase 1 step | Status |
|---|---|
| 1. Deploy pgvector image | ✅ Done |
| 2. Postgres env vars + volume | ✅ Done |
| 3. Schema applied (33 tables, RLS, holidays, seed user) | ✅ Done |
| 4. Verified RLS isolation | ✅ Done |
| 5. n8n service deployed (custom Dockerfile, runs as root) | ✅ Done |
| 6. n8n owner account + Community Plus license | ✅ Done |
| 7. Telegram bot `@jarvis_mork_bot` created | ✅ Done |
| 8. Bot privacy disabled + 5 slash commands configured | ✅ Done |
| 9a. Token saved to .env.local.txt | ✅ Done |
| 9b. chat_id retrieved via getUpdates | ✅ Done — `8572693842` |
| 9c. Telegram credential in n8n vault | ✅ Done |
| 9d. Anthropic credential in n8n vault | ✅ Done — named `ANTHROPIC_API` |
| **9e. Postgres credential in n8n vault** | 🔵 NEXT |
| **9f. UPDATE users table with token + chat_id** | 🔵 NEXT |
| 10. Build Workflow 1 (Telegram Inbound Router) | Pending |
| 11. Build Workflow 2 (Chat Agent) — 2 starter tools | Pending |
| 12. Round-trip test before adding more tools | Pending |
| 13. Workflow 3a (Email Triage, Gmail #1) | Pending |
| 14. Workflows 4–8 | Pending |
| 15. Duplicate 3 for Gmails #2 and #3 | Pending |
| 16. End-to-end smoke test | Pending |

---

## Critical info to keep handy

- **user_id UUID:** `591ebda6-7476-4dc6-8296-687eb4e13c57`
- **Telegram chat_id:** `8572693842`
- **Bot:** `@jarvis_mork_bot` (id: `8249781555`)
- **Repo:** `C:\Users\freed\Claude Projects\Executive-Assist`
- **Local secrets:** `.env.local.txt` (gitignored)
- **Railway project:** `Executive Assistant` (`2435ec7e-7fbe-4c3c-8291-194912cb8d3a`)
- **Services:** `pgvector` + `n8n` both green

### What's saved in `.env.local.txt`
```
ANTHROPIC_API
POSTGRES_PASSWORD
USER_ID
N8N_ENCRYPTION_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_BOT_USERNAME
TELEGRAM_CHAT_ID  ← add this if not already there: 8572693842
```

### n8n credentials saved in vault
- `Telegram - jarvis_mork_bot` (Telegram API)
- `ANTHROPIC_API` (Anthropic API)
- ❌ Postgres — **still missing, do tomorrow**

---

## Resume instructions for tomorrow

### Step 1 — Confirm session state
```powershell
cd "C:\Users\freed\Claude Projects\Executive-Assist"
railway status   # should show: Executive Assistant, environment=production
railway service  # pick pgvector
```

### Step 2 — Run the missed UPDATE
This wires the bot to the user. **Required** before Workflow 1 can look up the user from a Telegram message.

```powershell
@"
UPDATE users
   SET telegram_bot_token = '8249781555:AAFgdHoIfb3seuvcXQxTmL6h8qX7-LSFMZA',
       telegram_chat_id   = '8572693842'
 WHERE email = 'mark@sophaxconsulting.com';
SELECT id, email, telegram_chat_id, LEFT(telegram_bot_token, 12) || '...' AS token_preview FROM users;
"@ | railway ssh psql -U assistant -d assistant
```

Expect: `UPDATE 1`, then one row with `telegram_chat_id = 8572693842` and a 12-char token preview.

### Step 3 — Add Postgres credential to n8n
n8n UI → **Credentials** → **+ Add Credential** → **Postgres**:

| Field | Value |
|---|---|
| Host | `pgvector.railway.internal` |
| Database | `assistant` |
| User | `assistant` |
| Password | (from `.env.local.txt` → `POSTGRES_PASSWORD`) |
| Port | `5432` |
| SSL | **Disable** |
| Name | `Postgres - Executive Assistant` |

Save → expect green "Connection tested successfully".

### Step 4 — Build Workflow 1: Telegram Inbound Router

Per `03_DEPLOYMENT.md` lines 158–172:

```
[Telegram Trigger] → [Postgres: lookup user] → [Postgres: set RLS] → [Switch: route by command]
```

**Node 1 — Telegram Trigger**
- Credential: `Telegram - jarvis_mork_bot`
- Updates: `message`
- (n8n auto-registers a webhook with Telegram on save)

**Node 2 — Postgres (lookup user)**
- Credential: `Postgres - Executive Assistant`
- Operation: Execute Query
- Query:
  ```sql
  SELECT id, is_admin, plan FROM users WHERE telegram_chat_id = $1
  ```
- Parameters: `={{ $json.message.chat.id.toString() }}`

**Node 3 — Postgres (set RLS context)**
- Credential: `Postgres - Executive Assistant`
- Query:
  ```sql
  SELECT set_user_context($1::uuid)
  ```
- Parameters: `={{ $('Postgres').item.json.id }}` (refers to node 2's output)

**Node 4 — Switch (route by command)**
Routing rules (string starts with):
| Match | Route to |
|---|---|
| `/today` | Workflow 5 |
| `/urgent` | Workflow 6 |
| `/rules` | Workflow 7 |
| `/admin` AND `is_admin = true` | Workflow 8 |
| `/help` | reply with command reference |
| _default_ | Workflow 2 (Chat Agent) |

For now (Workflows 2–8 don't exist yet), the Switch's outputs can dead-end into a placeholder Telegram reply node like "got your message, workflows still being built". Just wire one path so we can test the trigger + lookup + RLS chain works.

### Step 5 — Test Workflow 1 in isolation
1. Save + activate Workflow 1
2. Send `/help` to `@jarvis_mork_bot`
3. Open n8n → Executions tab → expect a green run
4. Check each node's output:
   - Node 1: should show your `chat.id = 8572693842`
   - Node 2: should return `{ id: 591ebda6..., is_admin: true, plan: 'personal' }`
   - Node 3: should return one row with the UUID echoed back
   - Node 4: should hit the `/help` branch

If any node errors, **stop and debug before moving on**. Don't start Workflow 2 until Workflow 1's pipeline is reliable.

---

## Open decisions for tomorrow

1. **Should `/help` be hardcoded text or a Postgres lookup?** Recommend hardcoded for Phase 1 — it's static.
2. **Workflow 1's switch dead-ends** — pick one of: (a) wire a placeholder Telegram reply per branch, (b) only wire the `default` → Workflow 2 path and let other commands silently no-op until those workflows exist. Recommend (a) so the bot always responds.
3. **Workflow 2's first 2 tools** — per checkpoint and deployment doc: `create_habit`, `log_habit`. Confirm before building.

---

## What NOT to do

- ❌ `railway redeploy` on pgvector — wipes volume (ADR 0001)
- ❌ Print full bot token or N8N_ENCRYPTION_KEY into terminal (use `cls` if you do)
- ❌ Skip a workflow test before adding tools to it. Strict round-trip discipline.
- ❌ Build all 8 workflows in one go. Order matters; each is a checkpoint.

---

## Files unchanged today

No new files committed today. All changes were dashboard-side (n8n credentials, Telegram BotFather, getUpdates polling). Tomorrow's work will produce:
- Workflow 1 → eventually exported to `workflows/01-telegram-inbound-router.json`
- New ADR for the n8n Dockerfile fix (still pending — low priority)

---

## Things still in your todo list

- Save bot token + chat_id to users table (in progress — step 2 above)
- Add Postgres credential in n8n vault (step 3 above)
- Build Workflow 1 (step 4 above)
- Build Workflow 2 with `create_habit`, `log_habit`
- Test bot end-to-end on starter tools
- Expand Chat Agent tools incrementally
- Add Gmail OAuth credentials (3 accounts)
- Build Workflow 3 → 4–8 → duplicate 3 for Gmails #2/#3
- Write ADR for n8n custom Dockerfile decision
- Phase 1 end-to-end smoke test
- Export n8n workflows as JSON to repo
