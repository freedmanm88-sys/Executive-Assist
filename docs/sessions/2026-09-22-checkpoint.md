# Session Checkpoint — 2026-09-22 — Muse review → learning loop v2 spec → Phase 1 shipped

**Status:** Spec written, canary deployed live (fired: `alerted`, ~60 d silent), Phase 1 (review cards + instant rules) built and deploying. **Still blocked on Mark for Phase 0** (Gmail OAuth re-auth + publish OAuth app) — nothing learns until email flows.

---

## Findings that reframed the work
- Newest real email: **2026-05-06**. Ingestion dead 4.5 months. The 2026-07-24 row is synthetic.
- **0 real feedback rows** — the 4 present are my tests. Learning loop never had input.
- **0 push subscriptions** — app was never installed on a phone.
- Worker had not redeployed since 2026-07-24 → Aug 1 canary sat unmerged on `fix/ingestion-staleness-canary`.
- Conclusion (Mark's words: "not high value"): the system was unplugged and the feedback question was wrong, not that the model is weak.

## Muse assessment (delivered in chat)
Adopt: activity/audit feed, memory store, follow-ups/open loops, bounded background jobs with approval gates. Skip: browser agent, shopping, WhatsApp, Mac agent. Our "bounded tools" stance validated by Muse's trust/reliability critiques.

## Shipped
- `docs/2026-09-22/specs/assistant-learning-loop-v2.md` — Phases 0–5 with acceptance criteria (review cards, memory store, reply drafts, attachments/PDF, activity tab).
- `docs/decisions/0004-instant-rules-over-weekly-distillation.md`.
- Merged canary branch → main, deployed. Live run: `{"state":"alerted","hours_silent":1436.6}` → Telegram alert sent (push: 0 devices).
- **Phase 1 code** (commit "feat: review cards — instant-learning feedback surface"):
  - worker `handlers/family-review.ts`: `GET /family/review`, `GET /family/review/count`, `POST /family/review/:decisionId/act` (actions: fine, not_urgent, mute_sender, mute_domain, vip_sender, make_task, add_event, draft_reply→not_available, dismiss). Instant `triage_rules` + `sender_profiles` writes; mute auto-resolves sibling cards; note → `parseFeedbackWithClaude` → `learned_preferences`; all logged to `agent_actions`.
  - crons: `review-digest-am` 09:05 (≥1 card), `review-digest-pm` 17:00 (≥3); manual `POST /cron/review-digest`. Urgent push url → `/review`.
  - app: `/review` deck (`components/review-deck.tsx`), nav tab Inbox→Review, badge via `/review/count`, home stat → `/review`. `/inbox` ("Everything") still reachable from the empty state.

## Verification
- worker `tsc` ✅, `npm test` 11/11 ✅; family-app `next build` ✅ (`/review` route present).
- Live: canary ✅. Phase 1 endpoints + Vercel deploy: see background chain result (recorded in final chat message).

## Part 2 — n8n retired (Mark: "not reliable")
- ADR 0005. Worker now owns: Gmail OAuth (`gmail/oauth.ts`, tokens AES-GCM in `user_credentials`, key HKDF from INTERNAL_AUTH_TOKEN or `CREDENTIALS_KEY`), Gmail REST (`gmail/api.ts`), `crons/gmail-sync.ts` every 2 min (business2 body never sent to Claude), Telegram webhook (`handlers/telegram-webhook.ts`: buttons → feedback handlers, text → quick-add assistant), OAuth callback `GET /oauth/google/callback`, admin `POST /admin/google-client` + `/admin/telegram-webhook`, manual `POST /cron/gmail-sync`.
- `gmail-event.ts` refactored: `processGmailMessage(label, message, {bodyAllowed})`; `/events/gmail` kept as legacy shim.
- App: Settings → **Email accounts** (Connect/Reconnect per inbox, sync time, error). OAuth bounce-back notice via `?gmail=connected|error`.
- Google OAuth client seeded into `family_settings.google_oauth_client` (server-only) from `.env.local.txt` values — same Google Cloud client n8n used.
- Verification of the live chain: see final chat message / `bbjuelkzk` output.

## Next (in order)
1. **Mark — Phase 0 (no n8n):** Google Cloud Console → OAuth client → add redirect URI `https://worker-production-5e83.up.railway.app/oauth/google/callback`; consent screen → **Publish app**; then app Settings → Email accounts → Connect ×3. Canary sends ✅ recovery ping once mail flows. Then stop the n8n Railway service.
2. **Mark:** install app on phone, enable push, `POST /family/push/test` → sent ≥1. Then actually use `/review` for a few days.
3. Claude — Phase 5 Activity tab (cheap; also gives Undo for rules). Then Phase 2 memory store → Phase 3 drafts (needs one n8n create-draft workflow) → Phase 4 attachments (n8n "download attachments" toggle; personal inbox only — borrower PII rule).
4. Consider a public-mail-domain denylist for `mute_domain` (ADR 0004 consequence).

## Key IDs
Mark `591ebda6-7476-4dc6-8296-687eb4e13c57` · Ashley `b804bb54-9685-4df2-ac16-f6382573deb4` · worker https://worker-production-5e83.up.railway.app · app https://family-app-dun-rho.vercel.app · Vercel `mark-6073s-projects/family-app`.
