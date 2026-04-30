# Executive Assistant — Worker Service

The brain. n8n is the integration layer (Telegram + Gmail webhooks/triggers, OAuth);
this service handles all business logic — classification, decision writing, alerts,
crons.

## Architecture

```
[Telegram User]   [Gmail]
       ↓             ↓ (polled by n8n)
[Telegram Bot API]   [n8n Gmail Trigger]
       ↓                     ↓
[n8n Telegram Trigger]   [n8n HTTP Request → POST /events/gmail]
       ↓
[n8n HTTP Request → POST /events/telegram (Phase 2)]
                     ↓
              ┌─ this service ─┐
              │  classify      │
              │  decide        │
              │  persist       │
              │  alert         │
              └────────────────┘
                     ↓
              Postgres (pgvector.railway.internal)
              Telegram Bot API (outbound)
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/healthz`        | none | Railway healthcheck |
| POST | `/events/gmail`   | `X-Internal-Auth` | Receive new Gmail message from n8n, classify, persist, alert |

Future:
- `POST /events/telegram` — chat agent (currently in n8n W2)
- `POST /events/feedback` — Telegram callback_query → ai_decisions feedback

## Local development

```bash
cd worker
cp .env.example .env
# fill in DATABASE_URL, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, INTERNAL_AUTH_TOKEN
npm install
npm run dev
```

Server boots on `http://localhost:8080`. Send test events:

```powershell
$auth = (Get-Content .env | Where-Object { $_ -match "^INTERNAL_AUTH_TOKEN" }).Split("=", 2)[1].Trim()

curl -X POST http://localhost:8080/events/gmail `
  -H "X-Internal-Auth: $auth" `
  -H "Content-Type: application/json" `
  -d '{"gmail_account_label":"personal","message":{"id":"test123","threadId":"t1","payload":{"headers":[{"name":"Subject","value":"Test"},{"name":"From","value":"x@example.com"}]}}}'
```

## Deployment to Railway

1. **Push to GitHub** (the worker lives in the same monorepo as n8n + schema)
2. In Railway → existing `Executive Assistant` project → **+ New Service** → **GitHub Repo** → pick `freedmanm88-sys/Executive-Assist`
3. **Settings → Build**:
   - Root Directory: `/worker`
   - Builder: Dockerfile
4. **Settings → Variables** — copy from `.env.example`:
   - `DATABASE_URL` — use service reference: `postgresql://${{pgvector.POSTGRES_USER}}:${{pgvector.POSTGRES_PASSWORD}}@pgvector.railway.internal:5432/${{pgvector.POSTGRES_DB}}`
   - `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `USER_ID`, `TELEGRAM_CHAT_ID` — from `.env.local.txt`
   - `INTERNAL_AUTH_TOKEN` — generate with `openssl rand -base64 32`
   - `NODE_ENV=production`
5. **Settings → Networking → Generate Domain**
6. Note the public URL — n8n's HTTP Request node will POST to `https://<worker-host>/events/gmail`

## Wire n8n to call this service

Slim down each `03* - Email Triage` workflow to just:

```
[Gmail Trigger] → [HTTP Request: POST /events/gmail with X-Internal-Auth header]
```

Body to send:
```js
{
  "gmail_account_label": "personal",  // hardcoded per workflow (personal/business1/business2)
  "message": {{ $json }}
}
```

Reply from worker contains `classification`, `urgency_score`, `is_urgent`, `triage_id` —
n8n can ignore or log it.

## Stack

- Node 20, TypeScript strict mode, ESM
- Express 4, zod for request validation
- pg (postgres driver), with `set_user_context` per-connection RLS helper
- @anthropic-ai/sdk with prompt caching (system prompt + tools)

## What's NOT here

- Gmail API access (n8n handles polling + OAuth refresh)
- Cron jobs (Phase 2 — daily digest, urgent nag, weekly distillation)
- Chat agent (still in n8n W2 — move here in Phase 2 if desired)
