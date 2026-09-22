# ADR 0005 — Retire n8n; the worker owns Gmail and Telegram directly

**Status:** Accepted (2026-09-22, Mark: "I don't want n8n anymore — it's not reliable")
**Related:** ADR 0003 (ingestion canary), ADR 0004 (instant rules), [Spec v2](../2026-09-22/specs/assistant-learning-loop-v2.md)

## Context

n8n was chosen in April "for prototyping speed" with an explicit plan to replace it later (architecture doc, Phase 7). In practice it was the least reliable component: a proxy-header crash storm (2026-04-30), Switch-node type validation bugs, one-shot Telegram callbacks lost on any error, and — decisively — Gmail ingestion **silently dead since 2026-05-06** because an OAuth credential inside n8n's vault expired and nothing in n8n said so. Every capability on the roadmap (drafts, attachments, Ashley's inbox) would have needed another n8n workflow and another credential we cannot inspect from code.

## Decision

The worker (Express/TS on Railway) becomes the only backend:

| n8n workflow | Replacement |
|---|---|
| W3a/b/c Gmail triggers | `crons/gmail-sync.ts` polls the Gmail REST API every 2 min per account, calls the existing triage pipeline (`processGmailMessage`) |
| Gmail OAuth credentials (vault) | `gmail/oauth.ts` — tokens AES-256-GCM encrypted in `user_credentials.oauth_payload`; key HKDF-derived from `INTERNAL_AUTH_TOKEN` (or `CREDENTIALS_KEY`); connect flow from the app's Settings page |
| W1 Telegram router + W2 chat agent | `handlers/telegram-webhook.ts` — direct Bot API webhook; buttons → existing feedback handlers; free text → the quick-add assistant |
| W99 error alerter | worker logs + ingestion canary (already alerts on silence, which n8n never could) |
| (planned) create-draft workflow | `gmail/api.ts` `createDraft` — Phase 3 needs no new plumbing |
| (planned) attachment download | `gmail/api.ts` `getAttachment` + `findPdfAttachments` — Phase 4 needs no new plumbing |

Google OAuth client id/secret are stored in `family_settings` (server-only key `google_oauth_client`), seeded via `POST /admin/google-client`, so no Railway env change is needed to roll out.

**Compliance default:** `business2` (Stonefield) mail is classified from headers + snippet only — the body is not sent to Claude — until a ZDR agreement exists (global standard: no raw borrower PII to the Claude API). `personal` and `business1` keep the existing 4 000-char body window. Constant `BODY_ALLOWED_ACCOUNTS` in `gmail-sync.ts`.

## Consequences

- **+** One codebase, one deploy, one log stream. Silent failure modes become loud (per-account `error` on the credential row, surfaced in Settings; canary on silence).
- **+** Drafts, attachments, and Ashley's inbox become code changes, not n8n projects.
- **+** Railway n8n service + its Postgres usage can be shut down (saves cost; removes a public surface).
- **−** Mark must do a one-time Google Console change: add `https://worker-production-5e83.up.railway.app/oauth/google/callback` as an authorized redirect URI, and **publish the OAuth app** (Testing → In production) or refresh tokens expire every 7 days — the same root cause as May.
- **−** Polling (2 min) instead of Gmail push notifications. Acceptable for personal volume; Pub/Sub watch can come later.
- **−** Token encryption key derives from a shared secret; a dedicated `CREDENTIALS_KEY` should be set before any non-family user is onboarded.
- **−** Telegram becomes a thin fallback channel; the app is the primary surface. Switching the webhook to the worker drops n8n's Telegram flow immediately (intended).
