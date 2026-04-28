# Session Checkpoint — 2026-04-27 evening

**Status:** Paused mid Phase 1, just before n8n service deploy.
**Resume tomorrow at:** Step 8a (generate N8N_ENCRYPTION_KEY, then create n8n service in Railway).

---

## Where we are

Phase 1 of the AI Personal Assistant deployment. Postgres half is done; n8n half is next.

| Phase 1 step | Status |
|---|---|
| 1. Deploy pgvector image | ✅ Done |
| 2. Set Postgres env vars | ✅ Done |
| 3. Attach persistent volume `/var/lib/postgresql/data` | ✅ Done |
| 4. Verify volume persistence | ✅ Done |
| 5. Apply 02_schema.sql (636 lines) | ✅ Done — ~33 tables, RLS policies, seed user, holidays |
| 6. Replace seed user with real values | ✅ Done |
| 7. Verify RLS isolation works | ✅ Done — counts return 0, no permission errors |
| **8. Deploy n8n service** | 🔵 NEXT |
| 9. Configure n8n env vars (DB ref + encryption key + tz) | Pending |
| 10. Attach n8n volume + region | Pending |
| 11. Generate Railway public domain + wire N8N_HOST | Pending |
| 12. Complete n8n first-run owner setup | Pending |
| 13. Telegram bot via BotFather | Pending |
| 14. Build 8 workflows (incrementally) | Pending |
| 15. Connect 3 Gmail accounts | Pending |
| 16. End-to-end smoke test | Pending |

---

## What's running in Railway

**Project:** `Executive Assistant` (ID `2435ec7e-7fbe-4c3c-8291-194912cb8d3a`)
**Environment:** `production`
**Region:** US East (Virginia) — Canadian regions require Pro plan, deferred until Phase 5

**Service: pgvector**
- Image: `pgvector/pgvector:pg16`
- Internal hostname: `pgvector.railway.internal`
- Volume: `pgvector-volume` mounted at `/var/lib/postgresql/data`, 5GB allocated
- Env vars set:
  - `POSTGRES_USER` = `assistant`
  - `POSTGRES_PASSWORD` = (in .env.local.txt, rotated)
  - `POSTGRES_DB` = `assistant`
  - `PGDATA` = `/var/lib/postgresql/data/pgdata`
- Status: green, schema applied, seed user landed
- Public networking: NOT enabled (private only — good)

---

## Critical info to keep handy

- **user_id UUID:** `591ebda6-7476-4dc6-8296-687eb4e13c57`
- **Repo:** `C:\Users\freed\Claude Projects\Executive-Assist`
- **GitHub:** `freedmanm88-sys/Executive-Assist`
- **Local secrets file:** `.env.local.txt` (gitignored — DO NOT commit)
- **CLI auth:** `railway login` already done; project + service `pgvector` linked

---

## Decisions made (tracked here, formal ADRs to follow)

1. **Railway over VPS** — user already familiar, Canadian region available on Pro (defer), faster time-to-Phase-1
2. **US East region** — Canada region requires Pro plan; PIPEDA doesn't apply to user's own personal data, can migrate before Phase 5 (partner onboarding)
3. **Railway-generated domain** instead of custom domain — fine for Phase 1 personal use; switch when partners join
4. **Skip service rename** (`pgvector` instead of `postgres`) — cosmetic only; n8n will connect via `pgvector.railway.internal`
5. **`pgvector/pgvector:pg16` image** — schema requires `vector` extension; standard Railway Postgres template doesn't ship it

---

## Gotchas discovered (read before tomorrow)

### 🚨 `railway redeploy` wipes the volume on Postgres
Manual `railway redeploy` triggers fresh `initdb` — wipes all data despite volume being attached.
**Workaround:** Use `railway restart` for any DB bounce. Env var changes already trigger restart automatically (not redeploy), so safe.
ADR: `docs/decisions/0001-railway-redeploy-wipes-volume.md`

### Quoting hell with `railway ssh psql -c "..."`
PowerShell strips outer quotes, bash inside container chokes on parens/semicolons.
**Workaround:** Pipe via stdin instead:
```powershell
"SQL HERE;" | railway ssh psql -U assistant -d assistant
# or for files:
Get-Content schema.sql | railway ssh psql -U assistant -d assistant -v ON_ERROR_STOP=1
# or PowerShell here-string for multi-line:
@"
UPDATE ...;
SELECT ...;
"@ | railway ssh psql -U assistant -d assistant
```

### psql output paged via `less` traps you
Set `\pset pager off` inside psql, or `PAGER=` outside.

### First schema apply errored on `users already exists`
Mystery — table existed before our wipe. Resolved by `DROP SCHEMA public CASCADE` + reapply. Cause unknown; nothing of value lost.

---

## Files modified

| File | State | Notes |
|---|---|---|
| `.gitignore` | ✅ Created (untracked) | Catches `.env*`, `*.txt`, node_modules, pgdata, etc. **Should be committed.** |
| `.env.local.txt` | ✅ Gitignored | Holds POSTGRES_PASSWORD (rotated), ANTHROPIC_API key, USER_ID. NEVER commit. |
| `docs/sessions/2026-04-27-evening-checkpoint.md` | This file | Session continuity per Hook 4 |
| `docs/decisions/0001-railway-redeploy-wipes-volume.md` | New | ADR documenting the redeploy gotcha |
| `workflows/README.md` | New (placeholder) | Where workflow JSON exports will go |

**Pre-tomorrow git hygiene:** `.gitignore` should be committed before any other files. Without it, accidents happen.

---

## Resume instructions for tomorrow

### First action
```powershell
cd "C:\Users\freed\Claude Projects\Executive-Assist"
railway status   # confirm still linked: project=Executive Assistant, service=pgvector
```

### Step 8a — generate n8n encryption key
```powershell
openssl rand -base64 32
```
Add to `.env.local.txt`:
```
N8N_ENCRYPTION_KEY: <the value>
```
**Critical:** if this key is ever lost, every credential stored in n8n (Gmail OAuth, Telegram tokens) becomes unreadable. No recovery — must re-OAuth everything.

### Step 8b — create n8n service in Railway dashboard
1. **+ Create** → **Docker Image**
2. Image: `n8nio/n8n:latest` (pinning vs latest is open decision — see below)
3. Service name: `n8n`
4. Click Deploy (will fail health check — expected, no env vars yet)

### Step 8c — env vars (the full block)
After service tile appears, link CLI:
```powershell
railway service   # pick n8n
```
Then add via Variables tab in dashboard (or `railway variables --set "K=V"`):

```
# Database — uses Railway service references to pgvector
DB_TYPE=postgresdb
DB_POSTGRESDB_HOST=pgvector.railway.internal
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=${{pgvector.POSTGRES_DB}}
DB_POSTGRESDB_USER=${{pgvector.POSTGRES_USER}}
DB_POSTGRESDB_PASSWORD=${{pgvector.POSTGRES_PASSWORD}}

# n8n core
N8N_ENCRYPTION_KEY=<paste from .env.local.txt>
GENERIC_TIMEZONE=America/Toronto
TZ=America/Toronto
N8N_PORT=5678
PORT=5678

# Set after generating Railway domain (Step 8e):
# N8N_HOST=<railway-generated-host>
# N8N_PROTOCOL=https
# WEBHOOK_URL=https://<railway-generated-host>/
```

### Step 8d — region + volume
- Settings → Scale → Region → US East (match pgvector)
- `railway volume add --mount-path /home/node/.n8n` (after `railway service` linked to n8n)

### Step 8e — generate public domain, then complete the env vars
- Service → Networking → **Generate Domain**
- Railway returns something like `n8n-production-abc1.up.railway.app`
- Add `N8N_HOST`, `N8N_PROTOCOL=https`, `WEBHOOK_URL=https://<host>/` to Variables
- `railway restart` (NOT redeploy)
- Browser to `https://<host>/` → n8n's first-run owner setup screen

### Step 8 acceptance criteria
- n8n loads at the public URL over HTTPS
- First-run owner account created (email + password — save to `.env.local.txt`)
- Inside n8n's UI, Settings → check it shows database is connected to Postgres
- After `railway restart`, n8n login still works (volume persists encryption key)

---

## Open decisions to make tomorrow

1. **Pin n8n version vs `:latest`?** Recommend pinning to current stable. Check `https://hub.docker.com/r/n8nio/n8n/tags` for latest stable, then use that exact tag.
2. **n8n owner setup credentials** — pick an email (your sophax address?) and a strong password. Save both to `.env.local.txt`.
3. **Whether to commit `.gitignore` first thing** — recommended yes. Then optionally commit the docs additions in this checkpoint.

---

## After Step 8 finishes (preview of next sessions)

- Step 9: Telegram bot via BotFather, save token + chat_id to users table (PowerShell here-string UPDATE pattern)
- Step 10–12: Build Workflow 1 (Telegram Inbound Router) and Workflow 2 (Chat Agent) with only 2 starter tools (`create_habit`, `log_habit`). Test the round trip before adding more tools.
- Step 13+: Email triage for Gmail #1 only, then expand.

The deployment doc's Step 4 lists all 8 workflows in build order. Don't try to build all 8 at once.
