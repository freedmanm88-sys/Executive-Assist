# ADR 0004 — Instant, action-shaped feedback replaces weekly distillation as the primary learning path

**Status:** Accepted (2026-09-22)
**Related:** [Spec — Assistant Learning Loop v2](../2026-09-22/specs/assistant-learning-loop-v2.md), ADR 0003 (ingestion canary)

## Context

The learning loop designed in May (✅/❌/✏️ per decision → Sunday distillation → rules) never learned anything. Two reasons, one operational and one structural:

- **Operational:** ingestion died 2026-05-06 and no real feedback was ever given (all 4 feedback rows are synthetic tests). See ADR 0003.
- **Structural:** the feedback question was wrong. "Was this classification correct?" is abstract; Mark's actual reactions are *actions* — "never show me this sender", "make this a task for Ashley", "draft a reply". Asking for a grade, then waiting up to a week for a batch job to maybe turn grades into rules, gave no visible payoff for the effort of answering, so there was no reason to answer.

Meta's Muse (Sept 2026) demonstrated the pattern people respond to: approval-gated actions with an immediate, visible audit trail.

## Decision

1. Feedback is **action-shaped**. The review surface offers what to *do* (mute, not-urgent, VIP, make task, add event, draft reply, fine, skip), not what to *grade*.
2. Every action writes its rule/profile/row **synchronously** in the same request (`triage_rules`, `sender_profiles`, `family_tasks`, `family_events`), so the next email is handled differently. A mute also clears every other pending card from that sender.
3. The free-text "why" is optional and never blocks the action; it is parsed into `learned_preferences` best-effort.
4. Every action is logged to `agent_actions` — the basis of the Activity tab (spec Phase 5) and of an **Undo**.
5. Weekly distillation is **demoted** to pattern-finding across instant rules (e.g. three muted senders on one domain → domain rule). It is no longer the only path from feedback to behaviour.
6. Delivery is push-first with batching: urgent → immediate; everything else → 09:05 digest, 17:00 only if ≥3 cards.

## Consequences

- **+** Payoff for feedback is immediate and visible, which is the only thing that will get feedback given at all.
- **+** Claude call volume falls as rules absorb noise before classification (rules already run pre-Claude since 2026-07-24).
- **+** Rules are auditable per-tap (`agent_actions.input.decision_id`), and reversible.
- **−** A careless "Mute domain" on `gmail.com` would silence everyone at that domain. Mitigation: the effect text names the value before the tap lands (UI), and Undo lands with the Activity tab. Consider a denylist of public mail domains for `mute_domain`.
- **−** Rules are per-user (`user_id = Mark`); Ashley's future email would need her own. Schema already supports it.
- **−** None of this matters until ingestion is revived (Phase 0 — Mark: re-auth Gmail OAuth in n8n, publish the OAuth app). The canary now makes silence loud.
