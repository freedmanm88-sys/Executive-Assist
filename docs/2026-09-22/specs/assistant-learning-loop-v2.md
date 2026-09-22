# Spec — Assistant Learning Loop v2 ("make it actually get better")

**Date:** 2026-09-22 · **Author:** Claude (Fable) for Mark · **Status:** Draft for Mark's review
**Supersedes:** the ✅/❌/✏️ per-decision feedback model (2026-05-04) and the weekly-only distillation (2026-07-24)

---

## 1. Overview

The assistant has not become useful because (a) **email ingestion has been dead since 2026-05-06** — nothing has flowed through it for 4.5 months, (b) the feedback loop has received **zero real feedback** (every row in `ai_decisions.feedback` is a synthetic test), and (c) the feedback surface itself is wrong: it asks "was this classification correct?" when what Mark wants to say is "draft a reply", "never show me this sender", "make this a task for Ashley". This spec replaces the abstract feedback model with **action-shaped review cards delivered by push notification**, makes every answer teach the system **immediately** (not Sunday), and adds the three capabilities Mark named: reply drafts, attachment/PDF understanding, and a memory of what he cares about. An Activity tab makes everything the assistant does visible, which is itself a feedback surface.

Muse (Meta, Sept 2026) validates this shape: approval-gated actions, a visible audit trail, memory that makes unprompted suggestions. We adopt those patterns; we skip browser-driving and purchasing.

## 2. Goals

- Mark spends **≤5 seconds per email** giving feedback, from a phone notification, with one tap plus an optional one-line "why".
- Every feedback action has an **immediate, visible effect** (a rule, a mute, a draft, a task) — no "thanks, noted".
- Within **two weeks of real use**, noise emails (bots, newsletters, listing alerts) no longer reach the review queue at all, because rules absorb them before Claude is called.
- The assistant **drafts replies** for reply-needed email and learns Mark's tone from his edits.
- The assistant **reads attachments** (PDF first) so "what is this item" is answered from the document, not the subject line.
- The assistant holds a **memory** of people, kids, projects, businesses, and preferences that every classification, draft, and extraction reads.
- Everything it did today is visible in one **Activity** screen, and the pipeline being dead is impossible to miss (canary deployed).

## 3. Non-goals

- Browser automation, shopping, bookings, payments (Muse's territory; unreliable; not the need).
- Auto-sending email. Drafts land in Gmail Drafts; Mark sends.
- Processing business-inbox **attachments** in v2 (borrower PII risk — see §6.6). Business inbox *classification* continues as today.
- Rebuilding the surface (Telegram vs app). The app stays; Telegram remains a fallback alert channel only.

## 4. The interaction model

```
email arrives → rules absorb noise (no Claude call) → Claude classifies + extracts
   → if actionable: creates a REVIEW CARD → push notification (one per card, or batched)
   → Mark taps → one screen, one email, big buttons:
        [✉ Draft reply]  [☑ Make task ▾ me/Ashley]  [📅 Add event]
        [🔕 Not urgent]  [🚫 Mute sender]  [👍 Fine as is]   + "why?" one-liner
   → tap = action executes NOW + a rule/preference/memory is written NOW
   → Activity tab shows: what it did, what it learned, what it proposes
```

**Delivery rule:** urgent → immediate push. Everything else → batched into the 9:00 push ("6 to review") and a 17:00 push if ≥3 new. Never more than 3 pushes/day outside urgent.

**Platform note (iOS):** Safari web push cannot render action buttons *inside* the notification; the tap opens the card (one tap either way). If in-notification buttons prove essential, the escape hatch is a Capacitor native shell (no rewrite) — not Telegram.

## 5. Acceptance criteria

### Phase 0 — Revive the pipe (prerequisite; needs Mark) — **n8n retired, see ADR 0005**
1. ✅ Canary merged and deployed; first run sent the "ingestion looks dead" alert (2026-09-22).
2. ✅ Worker-native Gmail sync + OAuth connect flow + Telegram webhook deployed (replaces n8n W1/W2/W3/W99).
3. **Mark — Google Cloud Console → APIs & Services → Credentials → the OAuth client `1053321758874-…`:** add authorized redirect URI `https://worker-production-5e83.up.railway.app/oauth/google/callback`.
4. **Mark — OAuth consent screen → Publish app (Testing → In production)** so refresh tokens stop expiring every 7 days (the May root cause).
5. **Mark — app → Settings → Email accounts → Connect** ×3 (personal, Sophax, Stonefield). Each shows "Synced …" within 2 min.
6. Canary sends the ✅ recovery ping; `MAX(processed_at)` in `email_triage_log` is < 1 h old.
7. Mark's phone has the app installed with push enabled; `POST /family/push/test` returns `sent ≥ 1`.
8. n8n Railway service stopped (after 6 is green for a day).

### Phase 1 — Review cards + instant learning
6. `GET /family/review` returns pending cards (actionable classes + anything urgent), newest first, with subject, sender, snippet, classification, reasoning, and — when present — extracted proposal and draft.
7. Each card action is one request `POST /family/review/:id/act` with `action ∈ {draft_reply, make_task, add_event, not_urgent, mute_sender, mute_domain, vip_sender, fine, dismiss}` + optional `note` + optional `assigned_to`.
8. **Instant effects** (all synchronous, all visible in Activity):
   - `mute_sender` / `mute_domain` → `triage_rules` row `classify:newsletter` (or `spam` if note says so) active immediately; `sender_profiles.never_archive=false, notes` updated; future mail from that sender never creates a card and never calls Claude.
   - `not_urgent` → `triage_rules` `never_urgent` for sender **and** `ai_decisions.feedback='adjusted'` with the note; urgent_queue row acknowledged.
   - `vip_sender` → `sender_profiles.always_urgent=true` + rule `always_urgent`.
   - `make_task` / `add_event` → creates the row (source `email:<id>`), assigned as chosen.
   - `fine` → `feedback='correct'`.
   - `draft_reply` → see Phase 3; until then, returns `not_available`.
9. A one-line `note` is stored raw on the decision **and** parsed by Claude into `learned_preferences` (existing `parseFeedbackWithClaude`) — but the rule from the button fires regardless of parsing.
10. Push: one notification per **urgent** card; batched digest pushes at 09:00/17:00 with count + top 3 subjects; tapping opens `/review`.
11. `/review` page: one card per screen, swipe/next, buttons ≥44 px, "why?" is a single-line input that never blocks the tap.
12. Sunday distillation still runs, but now looks for **patterns across** instant rules (e.g. 3 muted senders on one domain → domain rule) rather than being the only learning path.

### Phase 2 — Memory store ("what Mark cares about")
13. Table `family_memory(id, scope 'mark'|'ashley'|'family', kind 'person'|'kid'|'business'|'project'|'preference'|'fact', key, value TEXT, source 'manual'|'feedback'|'email'|'assistant', confidence, active, created_at, updated_at)` with `family_shared` RLS.
14. Settings → **Memory** screen lists entries by kind; add/edit/delete; "why does it think this?" shows source.
15. Seeded from what we already know: Mark/Ashley, Logan/Jackson, Sophax, Stonefield, Chiro provider, existing `learned_preferences`, sender VIP/mute profiles.
16. Every Claude call that reads email (classify, extract, draft) receives a compact memory block (≤ 40 lines, highest-confidence first). Verified by a test that a seeded fact ("Logan's teacher is Ms. Patel") changes extraction output.
17. The quick-add assistant can write memory: "remember that Jackson is allergic to peanuts" → `family_memory` row, source `assistant`, shown in Activity.
18. Review-card notes that state a durable fact ("this is my accountant") become memory rows via the existing parse step (`pattern_hint` → memory, not just preference).

### Phase 3 — Reply drafts
19. For `reply_needed` (and `action` where a reply is the action) on **personal** + **business1** inboxes, the worker generates a draft (`reply_drafts` table, exists) using memory + the thread + the last 5 approved drafts as tone examples.
20. Card shows the draft; buttons `Approve → Gmail Drafts`, `Edit` (inline textarea → re-save), `Discard`. Approve creates a Gmail draft via an n8n "create draft" webhook (`POST /events/create-draft` → n8n Gmail node) — n8n already holds OAuth; the worker never does.
21. Edited drafts are stored (`user_edits`) and the diff feeds a `reply_draft` domain preference ("Mark shortens greetings", "signs off 'Thanks, Mark'") — tone only, no rules.
22. Nothing is ever auto-sent. Acceptance test: zero rows in `reply_drafts` with status `sent`.

### Phase 4 — Attachments (PDF first)
23. n8n Gmail triggers set **Download Attachments = true**; PDFs (≤ 8 MB, ≤ 3 per email) forwarded base64 in the existing `/events/gmail` body (raise Express limit to 25 MB). Other types: filename + mime only.
24. Worker passes PDFs to Claude as native `document` blocks in the *same* classify/extract call; `email_triage_log` gains `attachments JSONB` (name, mime, size, extracted_summary).
25. Card shows "📎 invoice.pdf — $412.50 due Oct 3, Enbridge" (the summary), and proposals/drafts use it.
26. **Personal inbox only in v2.** `business2` (Stonefield) attachments are never sent to Claude — they routinely contain borrower PII and the global standard forbids raw PII in Claude calls without ZDR. `business1` (Sophax) attachments: off by default, flag to enable after review. Enforced in code, covered by a test.

### Phase 5 — Activity tab
27. `GET /family/activity?since=` unions: triage decisions (with rule-absorbed vs Claude-classified), rules created (and by which card), memory written, proposals/drafts created/resolved, crons fired (digest, nag, canary), push sends. Ordered by time, 200 max.
28. Tab shows a day-grouped feed with plain-English lines ("Muted housesigma.com — from your tap on 'Watched areas'"; "Absorbed 14 emails by rules, 0 Claude calls"). Each rule/memory line has **Undo** (deactivates the row).
29. Canary status pill at top: green "last email 12 min ago" / red "no email since May 6".

## 6. Technical notes

- **Stack unchanged:** worker (Express/TS on Railway) + family-app (Next 16 on Vercel) + Postgres. New tables via embedded migrations 11+ (`/admin/migrate`).
- **Rules before Claude** already exists (`triage-rules.ts`); Phase 1 just makes rule creation instant and user-driven. Expect Claude call volume to drop >60% within two weeks of use.
- **Push batching** lives in a new cron (`review-digest`) and replaces the per-email urgent push only for non-urgent classes.
- **Gmail read/write is worker-native** (ADR 0005 replaced the n8n credential boundary): `gmail/api.ts` already has `createDraft`, `getAttachment`, `findPdfAttachments` — Phases 3 and 4 need no new plumbing and no n8n toggles.
- **Compliance (global CLAUDE.md):** no raw PII to Claude — attachment processing gated to personal inbox; business classification continues on subject/snippet only as today. Railway has **no Canadian region**; the worker currently processes Mark's personal email in `us-west2`/`us-east4`. Acceptable for personal data by Mark's choice; flagged here so it's a decision, not an accident. Borrower data must not enter this pipeline.
- **iOS push actions:** not supported by Safari web push; card-on-tap is the design. Revisit native shell only if the one-tap flow proves insufficient.
- **Effort (rough):** P0 = 30 min of Mark + 1 h; P1 = 2 sessions; P2 = 1 session; P3 = 1–2 sessions (needs one n8n workflow); P4 = 1–2 sessions (needs n8n trigger setting); P5 = 1 session.
- **Sequence:** P0 → P1 → P5 (cheap, high visibility) → P2 → P3 → P4. Nothing after P0 requires Mark except n8n toggles in P3/P4 and daily feedback use.

## 7. Open questions

| # | Question | Owner |
|---|---|---|
| 1 | Re-authorize Gmail OAuth + publish the OAuth app — when? Everything downstream is blocked on this. | Mark |
| 2 | Business1 (Sophax) attachments: enable after Phase 4 lands, or keep personal-only? | Mark |
| 3 | Should Ashley receive review cards for *her* email eventually (needs her Gmail OAuth in n8n)? Out of scope now; schema supports it. | Mark |
| 4 | Batch push times: 09:00/17:00 assumed. Change? | Mark |
| 5 | If iOS one-tap-to-card feels like too much friction after a week, go native shell (Capacitor) — decision point after Phase 1 use. | Mark + Claude |
| 6 | Railway US-region processing of personal email: accept (recommended for a personal tool) or move worker? | Mark |
