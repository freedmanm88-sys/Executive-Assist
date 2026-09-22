/**
 * Review cards — the feedback surface that actually teaches the system.
 *
 * Spec: docs/2026-09-22/specs/assistant-learning-loop-v2.md (Phase 1)
 *
 * A card = one actionable email decision awaiting Mark's judgment. Every
 * action has an IMMEDIATE effect (a rule, a mute, a task) plus a feedback
 * row, so the system changes behaviour on the next email — not on Sunday.
 * Everything an action does is logged to agent_actions for the Activity tab.
 *
 * Mounted at /family/review (behind requireInternalAuth + requireFamilyUser).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { withUserContext, type DbClient } from '../db.js';
import {
  recordFeedback,
  ackUrgentQueueByDecision,
  loadDecisionContext,
  parseFeedbackWithClaude,
} from '../feedback-core.js';

const ACTIONABLE_CLASSES = ['urgent', 'action', 'reply_needed', 'calendar'];

const ActSchema = z.object({
  action: z.enum([
    'fine',          // classification was right; nothing else to do
    'not_urgent',    // cap this sender's urgency from now on
    'mute_sender',   // never show this sender again (rule → newsletter, no Claude call)
    'mute_domain',   // same, for the whole domain
    'vip_sender',    // this person is always urgent
    'make_task',     // turn it into a family task
    'add_event',     // accept the extracted event proposal
    'draft_reply',   // Phase 3 — returns not_available for now
    'dismiss',       // clear it, learn nothing
  ]),
  note:        z.string().max(1000).optional(),
  assigned_to: z.string().uuid().nullish(),
  category:    z.string().max(60).nullish(),
});

export interface ActResult {
  status:        'done' | 'not_available';
  effects:       string[];   // human-readable, shown on the card + Activity tab
  also_resolved: number;     // sibling cards auto-cleared by a mute
}

// ---------- Router -----------------------------------------------------------

export const reviewRouter = Router();

function uid(res: Response): string {
  return res.locals['familyUserId'] as string;
}

/** Pending cards: unreviewed decisions that deserve a human look. */
reviewRouter.get('/', asyncMw(async (req, res) => {
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '30'), 10) || 30, 100);
  const rows = await withUserContext(uid(res), async (client) => {
    const { rows } = await client.query(
      `SELECT
         d.id            AS decision_id,
         d.decision,
         d.reasoning,
         d.created_at,
         etl.id          AS triage_log_id,
         etl.subject, etl.sender_email, etl.sender_name, etl.received_at,
         etl.classification,
         ga.label        AS account_label,
         sp.relationship AS sender_relationship,
         sp.interaction_count,
         (SELECT row_to_json(p) FROM (
            SELECT id, kind, payload, status FROM family_proposals fp
            WHERE fp.triage_log_id = etl.id ORDER BY created_at DESC LIMIT 1
          ) p) AS proposal
       FROM ai_decisions d
       JOIN email_triage_log etl ON etl.decision_id = d.id
       LEFT JOIN gmail_accounts ga ON ga.id = etl.gmail_account_id
       LEFT JOIN sender_profiles sp ON sp.user_id = d.user_id AND sp.email = etl.sender_email
       WHERE d.domain = 'email_triage'
         AND d.feedback IS NULL
         AND (etl.classification = ANY($1::text[])
              OR (d.decision->>'urgency_score')::int >= 70)
       ORDER BY (etl.classification = 'urgent') DESC, d.created_at DESC
       LIMIT $2`,
      [ACTIONABLE_CLASSES, limit],
    );
    return rows;
  });
  res.json({ cards: rows, pending: rows.length });
}));

/** Count only — cheap, for badges and the digest push. */
reviewRouter.get('/count', asyncMw(async (_req, res) => {
  const n = await countPending(uid(res));
  res.json({ pending: n });
}));

reviewRouter.post('/:decisionId/act', asyncMw(async (req, res) => {
  const decisionId = z.string().uuid().parse(req.params['decisionId']);
  const body = ActSchema.parse(req.body);
  const userId = uid(res);

  const ctx = await loadDecisionContext(userId, decisionId);
  if (!ctx) { res.status(404).json({ error: 'decision_not_found' }); return; }

  // A card can be acted on once. Prevents a double-tap (or a stale screen)
  // from overwriting the feedback and re-running side effects.
  const alreadyResolved = await withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ feedback: string | null }>(
      `SELECT feedback FROM ai_decisions WHERE id = $1::uuid`, [decisionId],
    );
    return rows[0]?.feedback != null;
  });
  if (alreadyResolved) { res.status(409).json({ error: 'already_resolved' }); return; }

  const result = await withUserContext(userId, (client) =>
    applyAction(client, userId, decisionId, ctx, body),
  );

  // Free-text "why" → structured preference/hint (existing parser). Best-effort,
  // and the button's rule already fired regardless of how this goes.
  if (body.note && body.note.trim().length > 3) {
    try {
      const parsed = await parseFeedbackWithClaude(body.note, {
        classification: ctx.classification,
        urgency_score:  ctx.urgency_score,
        reasoning:      ctx.reasoning,
        subject:        ctx.subject,
        sender:         ctx.sender_email,
      });
      await withUserContext(userId, async (client) => {
        await client.query(
          `UPDATE ai_decisions SET feedback_note = $1 WHERE id = $2::uuid`,
          [JSON.stringify({ raw: body.note, action: body.action, parsed }), decisionId],
        );
        if (parsed.pattern_hint) {
          await client.query(
            `INSERT INTO learned_preferences (user_id, domain, preference, confidence, derived_from_count)
             SELECT $1::uuid, 'email_triage', $2, 0.6, 1
             WHERE NOT EXISTS (
               SELECT 1 FROM learned_preferences WHERE lower(preference) = lower($2)
             )`,
            [userId, parsed.pattern_hint],
          );
          result.effects.push(`Learned: ${parsed.pattern_hint}`);
        }
      });
    } catch (err) {
      console.error('[review] note parse failed (non-fatal):', err);
    }
  }

  await withUserContext(userId, (client) =>
    client.query(
      `INSERT INTO agent_actions (user_id, tool_name, input, output, success)
       VALUES ($1::uuid, $2, $3, $4, TRUE)`,
      [userId, `review:${body.action}`,
       JSON.stringify({ decision_id: decisionId, subject: ctx.subject, sender: ctx.sender_email, note: body.note ?? null }),
       JSON.stringify(result)],
    ),
  );

  res.json(result);
}));

// ---------- What it has learned (+ Undo) -------------------------------------

/** Active rules + preferences — the backbone of the Activity tab's Undo. */
reviewRouter.get('/learning', asyncMw(async (_req, res) => {
  const data = await withUserContext(uid(res), async (client) => {
    const rules = await client.query(
      `SELECT id, pattern_type, pattern_value, action, created_at
       FROM triage_rules WHERE active AND domain = 'email_triage' ORDER BY created_at DESC LIMIT 200`,
    );
    const prefs = await client.query(
      `SELECT id, domain, preference, confidence, last_reinforced
       FROM learned_preferences WHERE active ORDER BY last_reinforced DESC LIMIT 200`,
    );
    return { rules: rules.rows, preferences: prefs.rows };
  });
  res.json(data);
}));

const UndoSchema = z.object({
  kind: z.enum(['rule', 'preference']),
  id:   z.string().uuid(),
});

/** Deactivate (never delete) a learned rule or preference. */
reviewRouter.post('/learning/undo', asyncMw(async (req, res) => {
  const { kind, id } = UndoSchema.parse(req.body);
  const userId = uid(res);
  const table = kind === 'rule' ? 'triage_rules' : 'learned_preferences';
  const r = await withUserContext(userId, (client) =>
    client.query(`UPDATE ${table} SET active = FALSE WHERE id = $1::uuid AND active`, [id]),
  );
  if ((r.rowCount ?? 0) === 0) { res.status(404).json({ error: 'not_found_or_inactive' }); return; }
  await withUserContext(userId, (client) =>
    client.query(
      `INSERT INTO agent_actions (user_id, tool_name, input, output, success)
       VALUES ($1::uuid, 'review:undo', $2, '{"deactivated":true}', TRUE)`,
      [userId, JSON.stringify({ kind, id })],
    ),
  );
  res.json({ deactivated: true });
}));

// ---------- Action semantics -------------------------------------------------

async function applyAction(
  client: DbClient,
  userId: string,
  decisionId: string,
  ctx: { classification: string; subject: string; sender_email: string },
  body: z.infer<typeof ActSchema>,
): Promise<ActResult> {
  const effects: string[] = [];
  let alsoResolved = 0;
  const sender = (ctx.sender_email ?? '').toLowerCase();
  const domain = sender.includes('@') ? sender.split('@')[1] ?? '' : '';

  switch (body.action) {
    case 'fine':
      await recordFeedback(userId, decisionId, 'correct', null);
      effects.push('Marked correct');
      break;

    case 'dismiss':
      await recordFeedback(userId, decisionId, 'adjusted', { action: 'dismiss' });
      effects.push('Cleared');
      break;

    case 'not_urgent':
      await addRule(client, userId, 'sender_email', sender, 'never_urgent');
      await recordFeedback(userId, decisionId, 'adjusted', { action: 'not_urgent', raw: body.note ?? null });
      await ackUrgentQueueByDecision(userId, decisionId);
      effects.push(`${sender} can no longer be urgent`);
      break;

    case 'mute_sender':
    case 'mute_domain': {
      const isDomain = body.action === 'mute_domain';
      const value = isDomain ? domain : sender;
      const cls = /spam|junk/i.test(body.note ?? '') ? 'spam' : 'newsletter';
      await addRule(client, userId, isDomain ? 'sender_domain' : 'sender_email', value, `classify:${cls}`);
      await upsertSenderProfile(client, userId, sender, { relationship: 'newsletter', notes: `muted via review ${new Date().toISOString().slice(0, 10)}` });
      await recordFeedback(userId, decisionId, 'adjusted', { action: body.action, raw: body.note ?? null });
      await ackUrgentQueueByDecision(userId, decisionId);
      // Clear every other pending card from the same sender/domain — one tap, done.
      const sib = await client.query(
        `UPDATE ai_decisions d SET feedback = 'adjusted', feedback_at = NOW(),
                feedback_note = $3
         FROM email_triage_log etl
         WHERE etl.decision_id = d.id AND d.feedback IS NULL AND d.id <> $1::uuid
           AND ${isDomain ? `lower(etl.sender_email) LIKE '%@' || $2` : `lower(etl.sender_email) = $2`}`,
        [decisionId, value, JSON.stringify({ action: 'auto_muted_sibling', via: decisionId })],
      );
      alsoResolved = sib.rowCount ?? 0;
      effects.push(`Muted ${value} → future mail filed as ${cls}, no review, no AI call`);
      if (alsoResolved > 0) effects.push(`Cleared ${alsoResolved} other pending email${alsoResolved === 1 ? '' : 's'} from ${value}`);
      break;
    }

    case 'vip_sender':
      await addRule(client, userId, 'sender_email', sender, 'always_urgent');
      await upsertSenderProfile(client, userId, sender, { always_urgent: true, relationship: 'vip' });
      await recordFeedback(userId, decisionId, 'adjusted', { action: 'vip_sender', raw: body.note ?? null });
      effects.push(`${sender} is now always urgent`);
      break;

    case 'make_task': {
      const proposal = await pendingProposal(client, decisionId);
      const title = proposal?.kind === 'task' && proposal.payload['title']
        ? String(proposal.payload['title'])
        : cleanSubject(ctx.subject);
      const { rows } = await client.query(
        `INSERT INTO family_tasks (title, notes, assigned_to, due_at, category, created_by, source)
         VALUES ($1, $2, $3,
                 CASE WHEN $4::text IS NULL THEN NULL
                      ELSE (($4::date + time '23:59') AT TIME ZONE 'America/Toronto') END,
                 $5, $6::uuid, $7)
         RETURNING id`,
        [
          title,
          proposal?.payload['notes'] ?? `From email: "${ctx.subject}" (${sender})`,
          body.assigned_to ?? null,
          proposal?.payload['due_date'] ?? null,
          body.category ?? 'Family',
          userId,
          `email:${decisionId}`,
        ],
      );
      if (proposal) await resolveProposal(client, proposal.id, userId, 'accepted', rows[0].id, null);
      await recordFeedback(userId, decisionId, 'correct', { action: 'make_task', task_id: rows[0].id });
      await ackUrgentQueueByDecision(userId, decisionId);
      effects.push(`Task created: "${title}"`);
      break;
    }

    case 'add_event': {
      const proposal = await pendingProposal(client, decisionId);
      if (!proposal || proposal.kind !== 'event' || !proposal.payload['date']) {
        return { status: 'not_available', effects: ['No event details were extracted from this email — add it from the Calendar tab.'], also_resolved: 0 };
      }
      const p = proposal.payload;
      const time = typeof p['time'] === 'string' ? p['time'] : null;
      const dur = typeof p['duration_min'] === 'number' ? p['duration_min'] : 60;
      const { rows } = await client.query(
        `INSERT INTO family_events (title, notes, location, start_at, end_at, all_day, created_by, source)
         VALUES ($1, $2, $3,
                 (($4::text || ' ' || COALESCE($5::text, '00:00'))::timestamp AT TIME ZONE 'America/Toronto'),
                 CASE WHEN $5::text IS NULL THEN NULL
                      ELSE ((($4::text || ' ' || $5::text)::timestamp + ($6 || ' minutes')::interval) AT TIME ZONE 'America/Toronto') END,
                 $5::text IS NULL, $7::uuid, $8)
         RETURNING id`,
        [p['title'], p['notes'] ?? null, p['location'] ?? null, p['date'], time, String(dur), userId, `email:${decisionId}`],
      );
      await resolveProposal(client, proposal.id, userId, 'accepted', null, rows[0].id);
      await recordFeedback(userId, decisionId, 'correct', { action: 'add_event', event_id: rows[0].id });
      effects.push(`Event added: "${p['title']}" on ${p['date']}`);
      break;
    }

    case 'draft_reply':
      return { status: 'not_available', effects: ['Reply drafts arrive in Phase 3 (needs the Gmail draft workflow).'], also_resolved: 0 };
  }

  return { status: 'done', effects, also_resolved: alsoResolved };
}

// ---------- Helpers ----------------------------------------------------------

async function addRule(client: DbClient, userId: string, patternType: string, value: string, action: string): Promise<void> {
  if (!value) return;
  await client.query(
    `INSERT INTO triage_rules (user_id, domain, pattern_type, pattern_value, action)
     SELECT $1::uuid, 'email_triage', $2, $3, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM triage_rules
       WHERE domain = 'email_triage' AND pattern_type = $2 AND lower(pattern_value) = lower($3) AND action = $4 AND active
     )`,
    [userId, patternType, value, action],
  );
}

async function upsertSenderProfile(
  client: DbClient,
  userId: string,
  email: string,
  patch: { relationship?: string; always_urgent?: boolean; notes?: string },
): Promise<void> {
  if (!email) return;
  await client.query(
    `INSERT INTO sender_profiles (user_id, email, relationship, always_urgent, notes, last_interaction_at, interaction_count)
     VALUES ($1::uuid, $2, $3, COALESCE($4, FALSE), $5, NOW(), 1)
     ON CONFLICT (user_id, email) DO UPDATE SET
       relationship = COALESCE(EXCLUDED.relationship, sender_profiles.relationship),
       always_urgent = COALESCE($4, sender_profiles.always_urgent),
       notes = COALESCE(EXCLUDED.notes, sender_profiles.notes),
       last_interaction_at = NOW()`,
    [userId, email, patch.relationship ?? null, patch.always_urgent ?? null, patch.notes ?? null],
  );
}

interface PendingProposal { id: string; kind: string; payload: Record<string, unknown> }

async function pendingProposal(client: DbClient, decisionId: string): Promise<PendingProposal | null> {
  const { rows } = await client.query<PendingProposal>(
    `SELECT fp.id, fp.kind, fp.payload
     FROM family_proposals fp
     JOIN email_triage_log etl ON etl.id = fp.triage_log_id
     WHERE etl.decision_id = $1::uuid AND fp.status = 'pending'
     ORDER BY fp.created_at DESC LIMIT 1`,
    [decisionId],
  );
  return rows[0] ?? null;
}

async function resolveProposal(
  client: DbClient, id: string, userId: string, status: string,
  taskId: string | null, eventId: string | null,
): Promise<void> {
  await client.query(
    `UPDATE family_proposals SET status = $1, resolved_by = $2::uuid, resolved_at = NOW(),
       created_task_id = $3, created_event_id = $4 WHERE id = $5::uuid`,
    [status, userId, taskId, eventId, id],
  );
}

export async function countPending(userId: string): Promise<number> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
       FROM ai_decisions d JOIN email_triage_log etl ON etl.decision_id = d.id
       WHERE d.domain = 'email_triage' AND d.feedback IS NULL
         AND (etl.classification = ANY($1::text[]) OR (d.decision->>'urgency_score')::int >= 70)`,
      [ACTIONABLE_CLASSES],
    );
    return rows[0]?.n ?? 0;
  });
}

function cleanSubject(s: string | null): string {
  return (s ?? 'Follow up on email').replace(/^(re|fwd?|fw):\s*/i, '').trim().slice(0, 200) || 'Follow up on email';
}

function asyncMw(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
