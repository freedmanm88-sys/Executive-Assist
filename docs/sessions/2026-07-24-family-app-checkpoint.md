# Session Checkpoint — 2026-07-24 — Family App v1 built

**Status:** `family-app/` (Next.js 16 PWA "Freedman HQ") built and verified end-to-end against the live worker. Worker gained the `/family/*` API + migration 06 (applied to PROD). **Blocked on Mark:** `vercel login` to deploy the app.

---

## What was built

### Worker (deployed on Railway, migration 06 applied)
- `/family/*` API router: tasks, lists + items + per-item comment threads, events, triage feed, feedback, settings, users. Auth: `X-Internal-Auth` + `X-Family-User` (validated member id → RLS context).
- `feedback-core.ts` — shared feedback logic (recordFeedback / ack urgent / Claude parse), reused by both Telegram handlers and the family API.
- `POST /admin/migrate` — idempotent runner for embedded migration 06.
- Migration 06: `family_tasks`, `family_lists`, `family_list_items`, `family_item_comments`, `family_events`, `family_settings` (RLS `family_shared` policy — any valid member), Ashley user created (`awronzberg@gmail.com`, id `b804bb54-9685-4df2-ac16-f6382573deb4`), Mark's full_name fixed 'Mork'→'Mark'.

### family-app (Next.js 16 App Router + Tailwind v4, mobile-first PWA)
- **Login** — pick Mark/Ashley + PIN (env `MARK_PIN`/`ASHLEY_PIN`, dev defaults 1111/2222). HMAC-signed cookie (Web Crypto), `proxy.ts` auth gate (Next 16 renamed middleware→proxy).
- **Home** — greeting, stat cards (tasks open / list items / to review), today's merged events, due tasks.
- **Tasks** — shared family tasks: add (notes, due date, assignee, priority), toggle, delete.
- **Lists** — Grocery/Shopping seeded + create custom; items with check-off (records who), delete, per-item 💬 comment threads.
- **Calendar** — agenda 45 days: family events (create/delete, Toronto DST-aware) merged with read-only Google Calendar **secret ICS feeds** (node-ical, RRULE expansion, 5-min cache). Feed URLs stored in `family_settings.ics_feeds` via Settings page.
- **Inbox** — the feedback environment: triage decision cards (subject, sender, classification chip, reasoning) with ✅ Correct / ❌ Wrong / 🔕 Not urgent (canned adjust) / ✏️ Adjust (free text → Claude parse → structured feedback). Pending-review badge on tab.
- PWA: manifest + icons + apple-icon + no-op service worker. Server actions for all mutations; worker token never reaches the browser.

## Verified end-to-end (against PROD worker/DB)
- Login as Mark → home renders live data
- Task create/toggle/delete; list item + comment; event create (correct Toronto time)/delete
- Inbox ✅ Correct and ✏️ Adjust both wrote `ai_decisions.feedback` (adjusted row has Claude-parsed JSON) — confirmed via feed query
- Production build passes (`npm run build`)

## Waiting on Mark (in order)
1. Run `vercel login` (CLI is logged out; Railway CLI also logged out — not needed for this)
2. Then deploy: from `family-app/` → `vercel --prod`, set env vars per `.env.example` (WORKER_URL, WORKER_AUTH_TOKEN, AUTH_SECRET, real MARK_PIN/ASHLEY_PIN)
3. In the deployed app → Settings: paste both Google Calendar secret ICS URLs
4. Both phones: open the Vercel URL → Add to Home Screen

## Session part 2 (same day — while blocked on vercel login)
- **Habits/accountability shipped:** migration 07 (`habits.shared` + seeded 'Hit step goal' and '10-min exercise' for both users), worker endpoints (list w/ Toronto-week counts, create, toggle-today, archive), Habits tab (6-tab nav) with both members' shared habits + week progress bars, Home check-in pill strip with partner status. Verified: toggle/untoggle round-trip.
- **Urgent-nag cron shipped:** 10/14/18 Toronto. First manual run sent 24 individual pings (old backlog) — fixed same session to the architecture-doc behavior: ONE consolidated message (max 10 listed) + auto-expire items unack'd >7 days (`ack_method='expired'`). Re-run: 24 expired, 0 pending, no ping. Manual trigger: `POST /cron/urgent-nag`.
- **Event editing shipped:** pencil icon on family events → inline edit form (title/date/time/duration/all-day/location), verified create→edit→delete.
- `/admin/migrate` now applies all embedded migrations in order (06, 07).

## Notes / follow-ups
- Mark's users row email is `mark@sophaxconsulting.com`; login maps freedman.m88@gmail.com → that row (see IDENTITIES in `app/login/actions.ts`).
- Demo item "Milk (2%)" + comment left in Grocery list.
- Follow-ups: event editing UI, push notifications (web push), habits page (tables exist), Resend inbound email → calendar, retire Telegram once app has push.
- Dev server: `npm run dev --prefix family-app` (or `.claude/launch.json` → family-app), localhost:3000.
