# Session Checkpoint — 2026-08-01 — Ingestion found dead; canary shipped

**Status:** Verification session, resumed after the 2026-07-24 pause. Found that
**email ingestion has been dead since 2026-05-06 (87 days)**. Built the
monitoring that should have caught it. Root cause still unconfirmed — blocked on
`railway login`.

---

## The finding

Newest 200 triage decisions, by date:

| Date | Rows |
|---|---|
| 2026-05-05 | 80 |
| 2026-05-06 | 119 |
| 2026-07-24 | 1 — *synthetic test row from the family-app session* |

Last real email triaged: `2026-05-06T20:55:27Z`.

Ruled out as a query artifact: `/family/feed` (`family-api.ts:534`) has no date
filter — plain `ORDER BY d.created_at DESC LIMIT n`.

**Probable cause** (fits the timeline almost exactly, unconfirmed): the Gmail
OAuth credential expired under Google's 7-day refresh-token rule for apps left in
**Testing** publishing status. n8n deployed 2026-04-29 → triage activated
2026-04-30 → ingestion stops 2026-05-06. Alternatives not excluded: n8n service
down, or workflow toggled inactive.

**Why it went unnoticed for 87 days:** W99 only fires on *errors*. Every silent
failure mode looks identical to a quiet inbox, and everything downstream
degraded plausibly — digest said "all clear", nag queue sat empty, proposals
returned `[]`, distillation skipped for lack of feedback. Full reasoning in
[ADR 0003](../decisions/0003-ingestion-staleness-canary.md).

---

## What shipped this session

### Ingestion canary (the durable fix)
- `worker/src/crons/ingest-canary-policy.ts` — dependency-free state machine
  (`decideCanary`): alert / throttle / re-alert / recover. Pure, so it's testable
  without a DB, a bot token, or an 18-hour wait.
- `worker/src/crons/ingest-canary.ts` — the IO around it. Reads
  `MAX(processed_at)` from `email_triage_log`; alerts via Telegram + web push at
  ≥18h silence; re-alerts at most daily; sends an explicit **recovery** ping so a
  fix is confirmed rather than assumed. Stays quiet on a fresh install with no rows.
- Registered at **09:00 and 17:00 America/Toronto**; manual trigger
  `POST /cron/ingest-canary`.
- State in `family_settings.ingest_canary`, server-only.

### Settings hardening
`/family/settings` was returning the whole settings blob **including
`vapid_keys.privateKey`**. Not a live leak — the settings page is a Server
Component and passes only `feeds`/`categories` to client children — but the
signing key was one careless prop-spread from shipping to a browser. The PUT
schema (`z.record(z.string(), z.unknown())`) was also fully permissive, so a
client could have overwritten the VAPID keys and silently broken push on every
subscribed device.

Both directions now guarded by `SERVER_ONLY_SETTING_KEYS`
(`vapid_keys`, `ingest_canary`): stripped from GET, rejected 403 on PUT.

### Test infrastructure (new to this repo)
No test runner existed. Added `npm test` using Node's built-in runner via the
already-present `tsx` — **zero new dependencies**. 11 tests covering the canary's
transitions, boundaries, and the degenerate-memo case where a corrupt memo could
otherwise wedge the canary into permanent silence.

---

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` (worker) | ✅ clean |
| `npm test` (worker) | ✅ 11/11 pass |
| `npm run build` (worker) | ✅ |
| `npm run build` (family-app) | ✅ |
| Worker `/healthz` | ✅ up, uptime 7.7d, no crashes |
| Deployed app `/login` | ✅ 200, renders "Freedman HQ" |
| Sunday 2026-07-26 distillation | ✅ correctly skipped (`not_enough_feedback`) — **no bad rules minted** |

**Not verified live:** the canary itself and the settings fix are unverified
against PROD because deploying is blocked. Logic is unit-tested; the live path is not.

---

## ⚠️ On first deploy, the canary will fire immediately

Ingestion has been silent for 87 days, so the first 09:00 or 17:00 run (or a
manual `POST /cron/ingest-canary`) sends a Telegram + push alert saying email
ingestion looks dead. **That is correct behaviour, not a bug** — and it doubles as
the live end-to-end test of the canary. Once the Gmail credential is fixed and
real email flows again, the next run sends the ✅ recovery ping.

---

## Waiting on Mark

1. **`railway login`** — CLI returns `invalid_grant`. Blocks all n8n/DB diagnosis
   *and* the worker deploy of this session's code.
2. Then in n8n: confirm the service is up, confirm `03a - Email Triage (Personal)`
   is **Active**, and re-authorize the Gmail OAuth credential for all three accounts.
3. **Publish the Google Cloud OAuth app (Testing → In production)** — otherwise
   refresh tokens keep expiring every 7 days and the pipe dies again. The canary
   means we'd find out the same day, but this is the actual fix.
4. Still open from 2026-07-24: install app on phone + enable notifications + send
   test push (never verified on-device); send Ashley the link + PIN 5779; paste
   remaining secret `basic.ics` links (only **Chiro** is connected).

---

## Deliberately not done

- **Inbox backlog burn-down** (196 of 200 newest decisions unreviewed). Those rows
  are now ~3 months stale, and the feedback is meant to encode *Mark's* judgment —
  me marking them would poison the distillation input with invented signal.
  Better: fix ingestion, then triage fresh mail.
- **Per-account staleness.** If one of three Gmail accounts dies while the others
  flow, total volume masks it and the canary stays quiet. Noted as follow-up in
  ADR 0003; kept out to keep this fix small.

---

## State

Worker on Railway (migrations 06–10 applied), app at
https://family-app-dun-rho.vercel.app. Committed on `main`, **not pushed** —
pushing may trigger a Railway auto-deploy, which is Mark's call.

**Key IDs:** Mark `591ebda6-7476-4dc6-8296-687eb4e13c57` · Ashley
`b804bb54-9685-4df2-ac16-f6382573deb4` · worker
https://worker-production-5e83.up.railway.app · Vercel project
`mark-6073s-projects/family-app`.
