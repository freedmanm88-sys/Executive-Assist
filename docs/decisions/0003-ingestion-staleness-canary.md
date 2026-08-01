# ADR 0003 — Monitor ingestion by staleness, not by errors

**Status:** Accepted
**Date:** 2026-08-01
**Phase:** 2 (learning loop / family app)

---

## Context

On 2026-08-01 a routine verification pass found that **email ingestion had been
dead for 87 days**. The evidence:

| Date | Triage decisions logged |
|---|---|
| 2026-05-05 | 80 |
| 2026-05-06 | 119 |
| 2026-07-24 | 1 — *synthetic test row, not a real email* |

Last real email triaged: `2026-05-06T20:55:27Z`. Nothing since.

This was not a query artifact — `/family/feed` has no date filter, it is a plain
`ORDER BY created_at DESC LIMIT n`.

### Why nobody noticed

W99 (Error Alerter) is wired as the error workflow on W1/W2/W3 and works: it
fired correctly on a typo during the 2026-05-04 session. But **it only fires on
errors**. The failure modes that actually killed ingestion are silent:

- an OAuth credential that expires and simply stops yielding messages
- a workflow toggled inactive
- an n8n service that is up but not polling

In all three the system sees "no new email", which is indistinguishable from a
genuinely quiet inbox. Nothing anywhere in the stack asserted *"email should be
arriving, and it isn't."*

Worse, everything downstream degraded quietly and plausibly. The daily digest
kept running and reporting "all clear". The urgent-nag queue drained to empty
and stayed empty. The email→proposal bridge produced zero proposals. The Sunday
distillation skipped every week for lack of feedback. Every one of those is the
correct behaviour for an empty inbox, so the whole system read as *calm* rather
than *disconnected*. Two full months of feature work — habits, push, proposals,
the learning loop — was built on top of a pipe with no input.

### Root cause (probable, not yet confirmed)

The timeline fits Google's 7-day refresh-token expiry for OAuth apps left in
**Testing** publishing status:

- 2026-04-29 — n8n deployed (ADR 0002)
- 2026-04-30 — `03a - Email Triage (Personal)` toggled Active
- 2026-05-06 — ingestion stops, ~7 days later

Confirming this requires n8n access (blocked on `railway login`). The canary is
worth having regardless of which of the silent failure modes it turns out to be.

---

## Decision

**Monitor the ingestion pipe by staleness, not by error events.**

A new in-process cron, `worker/src/crons/ingest-canary.ts`, runs at 09:00 and
17:00 America/Toronto. It reads `MAX(processed_at)` from `email_triage_log` and:

- **≥ 18h silent** → alert once via Telegram + web push, naming the two most
  likely causes so the fix path is in the alert itself
- **still silent** → stay quiet, re-alerting at most every 24h
- **recovered** → send an explicit recovery ping, so a fix is *confirmed* rather
  than assumed
- **no rows at all** → stay quiet (a fresh install has no baseline to judge)

Thresholds: 18h staleness, 24h re-alert. Normal volume is ~100 emails/day across
the three accounts, so 18h of complete silence is unambiguous while still
spanning a quiet overnight without crying wolf.

State lives in `family_settings.ingest_canary` (`{ alerting, last_alert_at }`),
which is server-only and excluded from the `/family/settings` payload.

The decision logic is isolated as a dependency-free pure function in
`ingest-canary-policy.ts` (`decideCanary`), so the transitions that matter —
alert, throttle, re-alert, recover — are unit-testable without a database, a bot
token, or an 18-hour wait. See `ingest-canary.test.ts`.

---

## Consequences

### Accepted trade-offs

- **A genuinely quiet 18 hours produces a false alarm.** Acceptable: a false
  positive costs one notification, a false negative cost 87 days.
- **Threshold is a fixed constant, not per-account.** If one of the three Gmail
  accounts dies while the others keep flowing, the canary stays silent — total
  volume masks a partial failure. Per-account staleness is the obvious next
  iteration; deliberately deferred to keep this fix small.
- **The canary only covers ingestion.** The same "silent absence" class of bug
  exists for any scheduled input. This ADR sets the pattern; it does not apply
  it everywhere yet.

### Follow-ups

- Publish the Google Cloud OAuth app (**Testing → In production**) so refresh
  tokens stop expiring every 7 days. Without this the pipe will keep dying; the
  canary just means we find out the same day.
- Consider per-`gmail_account` staleness once the pipe is confirmed healthy.

---

## Notes for future sessions

The general lesson is worth carrying beyond this repo: **an error alerter cannot
detect the absence of work.** Any pipeline whose failure mode is "stops
producing" rather than "throws" needs a liveness assertion that is independent of
the pipeline itself. Ask of each scheduled input: *if this silently stopped,
what would tell us?* If the answer is "the absence of rows nobody is counting",
that is this bug again.
