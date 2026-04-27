# Phase 1 Deployment Guide

This is the build sheet. Follow it top to bottom and you'll have a working assistant in your Telegram in roughly a weekend.

## What Phase 1 ships

- Multi-tenant Postgres with RLS (you're user #1)
- Telegram bot answering you on phone + desktop
- Email triage for 3 Gmail accounts (Personal, Business1, Business2)
- Urgent classification with clock-based grouped nag
- Reply drafts via Telegram preview
- Auto-archive in dry-run mode (logs only, nothing moves)
- Daily 7am digest
- Feedback loop on every decision (✅/❌/✏️)
- `/rules` command to inspect what the assistant has learned
- `/admin` cluster observability (just you for now, partners later)

## Prerequisites checklist

Before you touch anything, gather:

1. **A Canadian VPS.** OVHcloud Beauharnois (Quebec) starter ~CAD $7/mo, or DigitalOcean Toronto Basic ~USD $6/mo. Ubuntu 22.04 or 24.04. 2GB RAM minimum, 4GB recommended.
2. **A domain name** pointed at the VPS (for HTTPS). Cheap one is fine. n8n needs HTTPS for Telegram webhooks.
3. **Anthropic API key** with billing enabled.
4. **Telegram account** on your phone.
5. **Three Gmail accounts** ready to authorize OAuth on.
6. **Google Cloud project** for OAuth credentials and Maps API key (free tier is plenty).
7. **Two QuickBooks Online subscriptions** with API access (Phase 4, not Phase 1 — but worth confirming you have them).

## Step 1: Install n8n + Postgres

SSH into the VPS.

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER
exit  # log back in for group membership
```

```bash
mkdir -p ~/assistant && cd ~/assistant
cat > .env <<EOF
POSTGRES_USER=assistant
POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')
POSTGRES_DB=assistant
N8N_DOMAIN=assistant.yourdomain.com
N8N_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '/+=')
TZ=America/Toronto
EOF
chmod 600 .env

cat > docker-compose.yml <<'EOF'
services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: always
    env_file: .env
    volumes:
      - ./pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"

  n8n:
    image: n8nio/n8n:latest
    restart: always
    env_file: .env
    environment:
      - N8N_HOST=${N8N_DOMAIN}
      - N8N_PROTOCOL=https
      - WEBHOOK_URL=https://${N8N_DOMAIN}/
      - GENERIC_TIMEZONE=${TZ}
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=postgres
      - DB_POSTGRESDB_DATABASE=${POSTGRES_DB}
      - DB_POSTGRESDB_USER=${POSTGRES_USER}
      - DB_POSTGRESDB_PASSWORD=${POSTGRES_PASSWORD}
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}
    ports:
      - "127.0.0.1:5678:5678"
    volumes:
      - ./n8n_data:/home/node/.n8n
    depends_on:
      - postgres

  caddy:
    image: caddy:2
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - ./caddy_data:/data
      - ./caddy_config:/config
    depends_on:
      - n8n
EOF

cat > Caddyfile <<EOF
${N8N_DOMAIN} {
    reverse_proxy n8n:5678
}
EOF

docker compose up -d
```

Wait 30 seconds, then point your domain's A record at the VPS IP. Caddy will fetch HTTPS automatically. Visit `https://assistant.yourdomain.com` and complete n8n's first-run owner setup.

## Step 2: Apply schema

```bash
docker compose exec -T postgres psql -U assistant -d assistant < 02_schema.sql
```

Edit the seed `INSERT INTO users` line in the schema before running, or update yourself afterward:

```bash
docker compose exec postgres psql -U assistant -d assistant -c \
  "UPDATE users SET email='you@example.com', full_name='Heath' WHERE email='REPLACE_ME@example.com'; SELECT id, email FROM users;"
```

Save your `user_id` UUID — you'll paste it into workflows.

## Step 3: Create your Telegram bot

1. On your phone, open Telegram, search `@BotFather`, hit Start.
2. Send `/newbot`. Pick a display name ("Heath's Assistant") and a username (must end in `bot`, e.g. `heath_assistant_bot`).
3. BotFather sends you a token. Save it.
4. Send `/setprivacy` to BotFather → your bot → `Disable` (so it sees all messages).
5. Send `/setcommands` to BotFather, paste:
   ```
   today - Show today's overview
   urgent - List unacknowledged urgent items
   rules - Show learned rules and preferences
   admin - Cluster observability (admin only)
   help - Command reference
   ```
6. In Postgres, save the bot token to your user:
   ```bash
   docker compose exec postgres psql -U assistant -d assistant -c \
     "UPDATE users SET telegram_bot_token='<TOKEN>' WHERE email='you@example.com';"
   ```
7. Open your new bot in Telegram, send any message. n8n won't respond yet — that's expected. We need the chat_id from this. Get it:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].message.chat.id'
   ```
8. Save it:
   ```bash
   docker compose exec postgres psql -U assistant -d assistant -c \
     "UPDATE users SET telegram_chat_id=<CHAT_ID> WHERE email='you@example.com';"
   ```

## Step 4: Create the workflows in n8n

Phase 1 has 8 workflows. Build them in this order. The patterns repeat — once you've built #1 and #2, the rest are mechanical.

### Workflow 1: Telegram Inbound Router

**Purpose:** receives every Telegram message, identifies user, sets RLS context, routes to chat agent or command handler.

Nodes:
1. **Telegram Trigger** (credential: your bot token) → on message
2. **Postgres** → `SELECT id, is_admin, plan FROM users WHERE telegram_chat_id = $1` with the chat_id from the trigger
3. **Postgres** → `SELECT set_user_context($1::uuid)` — establishes RLS for downstream nodes
4. **Switch** on message content:
   - Starts with `/today` → Workflow 5 (Today)
   - Starts with `/urgent` → Workflow 6 (Urgent List)
   - Starts with `/rules` → Workflow 7 (Rules Inspector)
   - Starts with `/admin` AND user is_admin → Workflow 8 (Admin Dashboard)
   - Starts with `/help` → reply with command reference
   - Default → Workflow 2 (Chat Agent)

### Workflow 2: Chat Agent

**Purpose:** the conversational brain. Handles arbitrary natural language, calls tools.

Pattern (same as v0 we sketched, now multi-tenant):
1. **Set user_id** in workflow data (from Workflow 1)
2. **Postgres** → load last 20 conversation rows for this user
3. **Postgres** → load active triage_rules and learned_preferences for relevant domains
4. **Code node** → assemble system prompt with user facts + rules + preferences
5. **HTTP Request** → Claude API with full tool list
6. **If** tool_use returned → dispatch to tool handlers (Switch node) → re-call Claude with tool results
7. **Postgres** → save user msg + assistant reply to `conversations`
8. **Telegram** → send response

Phase 1 tools the agent has:
- `create_habit`, `log_habit`, `list_habits`
- `create_reminder`, `list_reminders`, `cancel_reminder`
- `create_task`, `complete_task`, `list_tasks`
- `remember_birthday`, `list_upcoming_birthdays`
- `remember_fact`, `forget_fact`
- `add_triage_rule`, `list_triage_rules`, `remove_triage_rule`
- `add_sender_profile` (e.g. "treat sarah@x.com as VIP")
- `mark_decision_correct(decision_id)`, `mark_decision_wrong(decision_id, note)`, `adjust_decision(decision_id, correction)`
- `query_today` (calls v_today)

### Workflow 3: Email Triage (one per Gmail account, runs every 5 min)

For each of your 3 Gmail accounts, duplicate this workflow.

Pattern:
1. **Cron Trigger** → every 5 minutes
2. **Postgres** → `SELECT * FROM gmail_accounts WHERE label = 'personal' AND active = TRUE` (also get user_id)
3. **Set RLS context**
4. **Gmail node** → list messages since `last_history_id`
5. **Loop** over new messages:
   - **Postgres** → check if already in `email_triage_log` (idempotency)
   - **Postgres** → look up `triage_rules` for this user — match sender_email or domain
   - **If hard rule matches** → apply directly, log to `email_triage_log`, skip Claude
   - **Else** → load `sender_profiles` for this sender, load `learned_preferences` for `email_triage` domain
   - **HTTP Request** → Claude with email body + sender context + preferences
   - **Postgres** → INSERT into `ai_decisions` with the classification + reasoning
   - **Postgres** → INSERT into `email_triage_log` with `decision_id` link
   - **Gmail** → apply `AI/<classification>` label
   - **If classification = 'urgent'** → INSERT into `urgent_queue`, send immediate Telegram ping with action buttons
   - **If would be archived** → INSERT into `archive_decisions` with `executed=FALSE` (dry-run)
   - **If `auto_archive_enabled=TRUE`** → actually archive, set `executed=TRUE`
6. **Postgres** → update `gmail_accounts.last_history_id`

The Telegram ping for urgent items uses inline keyboard markup with callback buttons:
```
✅ Correct  ❌ Wrong  ✏️ Adjust  💤 Snooze 2h  📝 Draft Reply
```

Each button's callback_data encodes `decision_id` so Workflow 9 (Feedback Handler) knows what to update.

### Workflow 4: Urgent Nag Loop

**Purpose:** clock-based grouped reminders.

1. **Cron Trigger** → every 2 hours, `0 8,10,12,14,16,18,20 * * *` (Toronto time)
2. **Postgres** → for each user where current time is in their waking hours: `SELECT * FROM urgent_queue WHERE user_id=$1 AND acknowledged_at IS NULL`
3. **If non-empty** → format consolidated message, send via Telegram
4. **Postgres** → update `last_pinged_at`, increment `ping_count`

### Workflow 5: Daily Digest (7am)

1. **Cron Trigger** → `0 7 * * *` (per user's timezone — for now, single timezone)
2. For each user: assemble morning digest:
   - Today's calendar events (Phase 3, empty for now)
   - Open tasks
   - Birthdays today/tomorrow/this-week
   - Last 24h email summary by classification
   - List of dry-run-archived items with restore buttons
   - Habit status
3. Telegram send

### Workflow 6: Feedback Handler

**Purpose:** processes the ✅/❌/✏️ button taps and free-text corrections.

1. **Telegram Trigger** → on callback_query
2. Parse callback_data → `{decision_id, action}`
3. Set RLS context
4. Update `ai_decisions.feedback`, `feedback_at`, `feedback_note`
5. If action is `wrong` or `adjusted`:
   - Look at the decision domain
   - For unambiguous corrections (e.g. "this sender always urgent") → INSERT into `triage_rules`
   - For nuanced corrections → INSERT/UPDATE into `learned_preferences`
6. Telegram → confirm "Got it, I'll remember that."

### Workflow 7: Weekly Preference Distillation

**Purpose:** prevent preference bloat.

1. **Cron Trigger** → Sundays 2am
2. For each user, for each domain:
   - Load all `feedback != 'correct'` decisions from past 7 days
   - Load existing `learned_preferences`
   - Send to Claude: "given these corrections and existing preferences, produce ≤20 clean preferences for this domain"
   - Replace existing preferences for that domain with the distilled set
   - Log the distillation to `audit_log`

### Workflow 8: Admin Dashboard (`/admin`)

**Purpose:** cluster observability for you across all your users.

1. Triggered by `/admin` from a user with `is_admin=TRUE`
2. **Postgres** → query `v_admin_decision_quality` (cluster aggregate, last 7 days)
3. **Postgres** → query `v_admin_usage` (current month tokens, costs)
4. **Postgres** → top-10 most-corrected domains (worst correct_pct)
5. **Postgres** → error rate per workflow from `agent_actions`
6. Format as Telegram message with sub-commands:
   - `/admin users` — list users with last-active and decision counts
   - `/admin domain <name>` — drill into a specific domain's recent corrections (anonymized — only the corrections, never the underlying email content)
   - `/admin costs` — month-to-date spending across services

**Privacy guarantee:** admin views show *patterns*, never raw user content. The schema enforces this by exposing only the aggregate views. Even you, as admin, cannot SELECT from `email_triage_log` for another user — RLS blocks it.

## Step 5: Connect Gmail (×3)

For each of your three Gmail accounts:

1. In Google Cloud Console, create OAuth credentials, add `https://assistant.yourdomain.com/rest/oauth2-credential/callback` to authorized redirect URIs
2. In n8n: Credentials → New → Gmail OAuth2 → paste client ID/secret → connect → authorize
3. Run this SQL once per account, swapping label and address:
   ```sql
   SELECT set_user_context('<your-user-uuid>'::uuid);
   INSERT INTO user_credentials (user_id, service, label, oauth_payload)
   VALUES ('<your-user-uuid>', 'gmail', 'personal', '{}'::jsonb);
   INSERT INTO gmail_accounts (user_id, credential_id, label, address)
   SELECT '<your-user-uuid>', id, 'personal', 'you@gmail.com'
   FROM user_credentials WHERE user_id='<your-user-uuid>' AND service='gmail' AND label='personal';
   ```
4. Duplicate Workflow 3 three times, point each at the right credential + gmail_accounts row.

For Phase 1, the actual OAuth tokens live in n8n's credential vault, not in `user_credentials.oauth_payload`. The DB row is metadata only. When we move to multi-user (Phase 5), we migrate token storage out of n8n into encrypted DB rows.

## Step 6: Test the loop end-to-end

1. Send a Telegram message to your bot: "Start tracking strength workouts, target 4x per week"
   - Should respond confirming creation, ask if you want a reminder
2. Send: "Logged my workout"
   - Should confirm
3. Have someone send an email to one of your three Gmail accounts
   - Within 5 min you get a Telegram ping with classification + buttons
   - Tap ✅ if it's right, ❌ if wrong
4. Check Postgres:
   ```sql
   SELECT set_user_context('<your-user-uuid>'::uuid);
   SELECT domain, decision, reasoning, feedback FROM ai_decisions ORDER BY created_at DESC LIMIT 10;
   SELECT * FROM v_today;
   ```

## Cost projection (single user, Phase 1)

- VPS: CAD $7/mo
- Domain: ~CAD $15/year
- Claude API: ~CAD $10/mo (heavier on email-triage workflows)
- Google APIs: free tier
- **Total: ~CAD $20/mo**

When you onboard partners, costs scale roughly linearly with email volume. Budget CAD $15-25/mo per user for Claude API.

## What to do once Phase 1 is stable for ~1 week

Move to Phase 2 (reminders + habits + birthdays — already partially built into Phase 1 via the chat agent's tools, just needs the cron-driven dispatcher).

Then Phase 3 (calendar + mileage), Phase 4 (receipts + QBO), Phase 5 (real onboarding flow for partners).

## Things that will go wrong and how to recover

- **Telegram messages stop coming through** → Caddy probably renewed and dropped the webhook. In n8n, deactivate + reactivate the Telegram trigger workflow.
- **Email triage misclassifying constantly** → check `learned_preferences` for that user/domain. The first 2 weeks should be label-only (no auto-archiving) precisely because you're calibrating.
- **Costs spiking** → check `usage_meters`. If Claude calls per email are high, your prompt is probably too long. Trim sender profile context to top 3 facts, not full history.
- **Schema migration mistake** → `pgdata` is just a directory, snapshot before any schema change. `tar czf pgdata.bak.tar.gz pgdata/`.

## Phase 1 done. Now what?

Use it for a week. Correct it relentlessly. Then we add Phase 2.

The single most valuable thing you can do for the product is *use it like a customer would* — not like a developer testing it. Send it your real emails. Trust its judgments. When it's wrong, hit ❌. The corrections compound. By week 4 it'll feel like a different product than week 1.
