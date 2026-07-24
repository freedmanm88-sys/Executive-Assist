/**
 * Family App API — consumed by the family-app Next.js frontend (Vercel).
 *
 * Auth model: two layers.
 *   1. X-Internal-Auth shared secret (same middleware as n8n routes) — the
 *      Next.js server attaches it; the token never reaches the browser.
 *   2. X-Family-User: <uuid> — which family member is acting. Validated
 *      against the users table (cached), then used to set RLS context.
 *
 * Family tables use the shared `family_shared` RLS policy (any valid member
 * sees all family data). Personal tables (ai_decisions, email_triage_log)
 * keep tenant isolation, so the triage feed only ever shows the requesting
 * user's own email decisions.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool, withUserContext } from '../db.js';
import {
  recordFeedback,
  ackUrgentQueueByDecision,
  loadDecisionContext,
  parseFeedbackWithClaude,
} from '../feedback-core.js';
import { MIGRATION_06_SQL, MIGRATION_06_NAME } from '../migrations/06-family-app.js';

// ---------- Family member validation (cached) --------------------------------

interface FamilyMember { id: string; email: string; full_name: string | null }

let memberCache: { members: FamilyMember[]; fetchedAt: number } | null = null;
const MEMBER_CACHE_TTL_MS = 5 * 60 * 1000;

async function getFamilyMembers(): Promise<FamilyMember[]> {
  if (memberCache && Date.now() - memberCache.fetchedAt < MEMBER_CACHE_TTL_MS) {
    return memberCache.members;
  }
  const { rows } = await pool.query<FamilyMember>(
    `SELECT id, email, full_name FROM users WHERE deleted_at IS NULL ORDER BY created_at`,
  );
  memberCache = { members: rows, fetchedAt: Date.now() };
  return rows;
}

/** Resolves X-Family-User to a validated member id on res.locals.familyUserId. */
async function requireFamilyUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const headerVal = req.header('X-Family-User') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(headerVal)) {
    res.status(400).json({ error: 'missing_or_invalid_family_user_header' });
    return;
  }
  const members = await getFamilyMembers();
  if (!members.some((m) => m.id === headerVal)) {
    res.status(403).json({ error: 'unknown_family_user' });
    return;
  }
  res.locals['familyUserId'] = headerVal;
  next();
}

function familyUserId(res: Response): string {
  return res.locals['familyUserId'] as string;
}

// ---------- Schemas ----------------------------------------------------------

const uuid = z.string().uuid();

const TaskCreateSchema = z.object({
  title:       z.string().min(1).max(500),
  notes:       z.string().max(5000).nullish(),
  assigned_to: uuid.nullish(),
  due_at:      z.string().datetime({ offset: true }).nullish(),
  priority:    z.number().int().min(1).max(5).nullish(),
});

const TaskPatchSchema = z.object({
  title:       z.string().min(1).max(500).optional(),
  notes:       z.string().max(5000).nullable().optional(),
  assigned_to: uuid.nullable().optional(),
  due_at:      z.string().datetime({ offset: true }).nullable().optional(),
  priority:    z.number().int().min(1).max(5).optional(),
  status:      z.enum(['open', 'done']).optional(),
});

const ListCreateSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(['shopping', 'todo', 'custom']).default('custom'),
});

const ItemCreateSchema = z.object({
  text: z.string().min(1).max(500),
  note: z.string().max(2000).nullish(),
});

const ItemPatchSchema = z.object({
  text: z.string().min(1).max(500).optional(),
  note: z.string().max(2000).nullable().optional(),
  done: z.boolean().optional(),
});

const CommentCreateSchema = z.object({
  body: z.string().min(1).max(2000),
});

const EventCreateSchema = z.object({
  title:    z.string().min(1).max(300),
  location: z.string().max(500).nullish(),
  notes:    z.string().max(5000).nullish(),
  start_at: z.string().datetime({ offset: true }),
  end_at:   z.string().datetime({ offset: true }).nullish(),
  all_day:  z.boolean().nullish(),
});

const EventPatchSchema = z.object({
  title:    z.string().min(1).max(300).optional(),
  location: z.string().max(500).nullable().optional(),
  notes:    z.string().max(5000).nullable().optional(),
  start_at: z.string().datetime({ offset: true }).optional(),
  end_at:   z.string().datetime({ offset: true }).nullable().optional(),
  all_day:  z.boolean().optional(),
});

const FeedbackSchema = z.object({
  decision_id: uuid,
  action:      z.enum(['correct', 'wrong', 'adjust']),
  note:        z.string().max(2000).optional(),   // required for 'adjust'
});

const SettingsPutSchema = z.record(z.string().min(1).max(100), z.unknown());

// ---------- Router -----------------------------------------------------------

export const familyRouter = Router();

// User directory — registered BEFORE requireFamilyUser because the app's login
// screen needs it to map emails → ids. Still behind X-Internal-Auth.
familyRouter.get('/users', asyncMw(async (_req, res) => {
  const members = await getFamilyMembers();
  res.json({
    users: members.map((m) => ({ id: m.id, email: m.email, name: m.full_name ?? m.email.split('@')[0] })),
  });
}));

familyRouter.use(asyncMw(requireFamilyUser));

// --- Bootstrap ---------------------------------------------------------------

familyRouter.get('/bootstrap', asyncMw(async (_req, res) => {
  const members = await getFamilyMembers();
  const uid = familyUserId(res);
  const [lists, settings] = await withUserContext(uid, async (client) => {
    const l = await client.query(
      `SELECT id, name, kind, archived FROM family_lists WHERE NOT archived ORDER BY created_at`,
    );
    const s = await client.query(`SELECT key, value FROM family_settings`);
    return [l.rows, s.rows] as const;
  });
  res.json({
    users: members.map((m) => ({ id: m.id, email: m.email, name: m.full_name ?? m.email.split('@')[0] })),
    lists,
    settings: Object.fromEntries(settings.map((r: { key: string; value: unknown }) => [r.key, r.value])),
  });
}));

// --- Tasks -------------------------------------------------------------------

familyRouter.get('/tasks', asyncMw(async (req, res) => {
  const status = req.query['status'] === 'done' ? 'done' : req.query['status'] === 'all' ? null : 'open';
  const rows = await withUserContext(familyUserId(res), async (client) => {
    const { rows } = await client.query(
      `SELECT t.*, u1.full_name AS assigned_to_name, u2.full_name AS created_by_name
       FROM family_tasks t
       LEFT JOIN users u1 ON u1.id = t.assigned_to
       LEFT JOIN users u2 ON u2.id = t.created_by
       WHERE ($1::text IS NULL OR t.status = $1)
       ORDER BY t.status = 'done', t.due_at NULLS LAST, t.priority, t.created_at DESC
       LIMIT 500`,
      [status],
    );
    return rows;
  });
  res.json({ tasks: rows });
}));

familyRouter.post('/tasks', asyncMw(async (req, res) => {
  const body = TaskCreateSchema.parse(req.body);
  const uid = familyUserId(res);
  const row = await withUserContext(uid, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO family_tasks (title, notes, assigned_to, due_at, priority, created_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, 3), $6) RETURNING *`,
      [body.title, body.notes ?? null, body.assigned_to ?? null, body.due_at ?? null, body.priority ?? null, uid],
    );
    return rows[0];
  });
  res.status(201).json({ task: row });
}));

familyRouter.patch('/tasks/:id', asyncMw(async (req, res) => {
  const id = uuid.parse(req.params['id']);
  const body = TaskPatchSchema.parse(req.body);
  const uid = familyUserId(res);
  const row = await withUserContext(uid, async (client) => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (frag: string, v: unknown) => { vals.push(v); sets.push(`${frag} = $${vals.length}`); };

    if (body.title !== undefined)       push('title', body.title);
    if (body.notes !== undefined)       push('notes', body.notes);
    if (body.assigned_to !== undefined) push('assigned_to', body.assigned_to);
    if (body.due_at !== undefined)      push('due_at', body.due_at);
    if (body.priority !== undefined)    push('priority', body.priority);
    if (body.status !== undefined) {
      push('status', body.status);
      if (body.status === 'done') {
        push('completed_at', new Date().toISOString());
        push('completed_by', uid);
      } else {
        push('completed_at', null);
        push('completed_by', null);
      }
    }
    if (sets.length === 0) return null;
    vals.push(id);
    const { rows } = await client.query(
      `UPDATE family_tasks SET ${sets.join(', ')} WHERE id = $${vals.length}::uuid RETURNING *`,
      vals,
    );
    return rows[0] ?? null;
  });
  if (!row) { res.status(404).json({ error: 'task_not_found' }); return; }
  res.json({ task: row });
}));

familyRouter.delete('/tasks/:id', asyncMw(async (req, res) => {
  const id = uuid.parse(req.params['id']);
  await withUserContext(familyUserId(res), (client) =>
    client.query(`DELETE FROM family_tasks WHERE id = $1::uuid`, [id]),
  );
  res.json({ deleted: true });
}));

// --- Lists + items + comments ------------------------------------------------

familyRouter.get('/lists', asyncMw(async (_req, res) => {
  const uid = familyUserId(res);
  const data = await withUserContext(uid, async (client) => {
    const lists = await client.query(
      `SELECT id, name, kind, archived, created_at FROM family_lists WHERE NOT archived ORDER BY created_at`,
    );
    const items = await client.query(
      `SELECT i.*, u.full_name AS created_by_name, d.full_name AS done_by_name
       FROM family_list_items i
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN users d ON d.id = i.done_by
       ORDER BY i.done, i.created_at DESC
       LIMIT 2000`,
    );
    const comments = await client.query(
      `SELECT c.*, u.full_name AS author_name
       FROM family_item_comments c
       JOIN users u ON u.id = c.author_id
       ORDER BY c.created_at
       LIMIT 5000`,
    );
    return { lists: lists.rows, items: items.rows, comments: comments.rows };
  });
  res.json(data);
}));

familyRouter.post('/lists', asyncMw(async (req, res) => {
  const body = ListCreateSchema.parse(req.body);
  const uid = familyUserId(res);
  const row = await withUserContext(uid, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO family_lists (name, kind, created_by) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET archived = FALSE
       RETURNING *`,
      [body.name, body.kind, uid],
    );
    return rows[0];
  });
  res.status(201).json({ list: row });
}));

familyRouter.post('/lists/:id/items', asyncMw(async (req, res) => {
  const listId = uuid.parse(req.params['id']);
  const body = ItemCreateSchema.parse(req.body);
  const uid = familyUserId(res);
  const row = await withUserContext(uid, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO family_list_items (list_id, text, note, created_by)
       VALUES ($1::uuid, $2, $3, $4) RETURNING *`,
      [listId, body.text, body.note ?? null, uid],
    );
    return rows[0];
  });
  res.status(201).json({ item: row });
}));

familyRouter.patch('/items/:id', asyncMw(async (req, res) => {
  const id = uuid.parse(req.params['id']);
  const body = ItemPatchSchema.parse(req.body);
  const uid = familyUserId(res);
  const row = await withUserContext(uid, async (client) => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (frag: string, v: unknown) => { vals.push(v); sets.push(`${frag} = $${vals.length}`); };

    if (body.text !== undefined) push('text', body.text);
    if (body.note !== undefined) push('note', body.note);
    if (body.done !== undefined) {
      push('done', body.done);
      push('done_by', body.done ? uid : null);
      push('done_at', body.done ? new Date().toISOString() : null);
    }
    if (sets.length === 0) return null;
    vals.push(id);
    const { rows } = await client.query(
      `UPDATE family_list_items SET ${sets.join(', ')} WHERE id = $${vals.length}::uuid RETURNING *`,
      vals,
    );
    return rows[0] ?? null;
  });
  if (!row) { res.status(404).json({ error: 'item_not_found' }); return; }
  res.json({ item: row });
}));

familyRouter.delete('/items/:id', asyncMw(async (req, res) => {
  const id = uuid.parse(req.params['id']);
  await withUserContext(familyUserId(res), (client) =>
    client.query(`DELETE FROM family_list_items WHERE id = $1::uuid`, [id]),
  );
  res.json({ deleted: true });
}));

familyRouter.post('/items/:id/comments', asyncMw(async (req, res) => {
  const itemId = uuid.parse(req.params['id']);
  const body = CommentCreateSchema.parse(req.body);
  const uid = familyUserId(res);
  const row = await withUserContext(uid, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO family_item_comments (item_id, author_id, body)
       VALUES ($1::uuid, $2, $3) RETURNING *`,
      [itemId, uid, body.body],
    );
    return rows[0];
  });
  res.status(201).json({ comment: row });
}));

// --- Events ------------------------------------------------------------------

familyRouter.get('/events', asyncMw(async (req, res) => {
  const from = typeof req.query['from'] === 'string' ? req.query['from'] : new Date().toISOString();
  const to   = typeof req.query['to']   === 'string' ? req.query['to']
             : new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
  const rows = await withUserContext(familyUserId(res), async (client) => {
    const { rows } = await client.query(
      `SELECT e.*, u.full_name AS created_by_name
       FROM family_events e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.start_at >= $1::timestamptz - INTERVAL '1 day' AND e.start_at <= $2::timestamptz
       ORDER BY e.start_at
       LIMIT 500`,
      [from, to],
    );
    return rows;
  });
  res.json({ events: rows });
}));

familyRouter.post('/events', asyncMw(async (req, res) => {
  const body = EventCreateSchema.parse(req.body);
  const uid = familyUserId(res);
  const row = await withUserContext(uid, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO family_events (title, location, notes, start_at, end_at, all_day, created_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, FALSE), $7) RETURNING *`,
      [body.title, body.location ?? null, body.notes ?? null, body.start_at, body.end_at ?? null, body.all_day ?? null, uid],
    );
    return rows[0];
  });
  res.status(201).json({ event: row });
}));

familyRouter.patch('/events/:id', asyncMw(async (req, res) => {
  const id = uuid.parse(req.params['id']);
  const body = EventPatchSchema.parse(req.body);
  const row = await withUserContext(familyUserId(res), async (client) => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (frag: string, v: unknown) => { vals.push(v); sets.push(`${frag} = $${vals.length}`); };

    if (body.title !== undefined)    push('title', body.title);
    if (body.location !== undefined) push('location', body.location);
    if (body.notes !== undefined)    push('notes', body.notes);
    if (body.start_at !== undefined) push('start_at', body.start_at);
    if (body.end_at !== undefined)   push('end_at', body.end_at);
    if (body.all_day !== undefined)  push('all_day', body.all_day);
    if (sets.length === 0) return null;
    vals.push(id);
    const { rows } = await client.query(
      `UPDATE family_events SET ${sets.join(', ')} WHERE id = $${vals.length}::uuid RETURNING *`,
      vals,
    );
    return rows[0] ?? null;
  });
  if (!row) { res.status(404).json({ error: 'event_not_found' }); return; }
  res.json({ event: row });
}));

familyRouter.delete('/events/:id', asyncMw(async (req, res) => {
  const id = uuid.parse(req.params['id']);
  await withUserContext(familyUserId(res), (client) =>
    client.query(`DELETE FROM family_events WHERE id = $1::uuid`, [id]),
  );
  res.json({ deleted: true });
}));

// --- Triage feed + feedback --------------------------------------------------

familyRouter.get('/feed', asyncMw(async (req, res) => {
  const limit = Math.min(parseInt(String(req.query['limit'] ?? '40'), 10) || 40, 200);
  const pendingOnly = req.query['pending'] === '1';
  const rows = await withUserContext(familyUserId(res), async (client) => {
    const { rows } = await client.query(
      `SELECT
         d.id            AS decision_id,
         d.decision,
         d.reasoning,
         d.feedback,
         d.feedback_note,
         d.created_at,
         etl.subject,
         etl.sender_email,
         etl.sender_name,
         etl.received_at,
         etl.classification,
         ga.label        AS account_label
       FROM ai_decisions d
       JOIN email_triage_log etl ON etl.decision_id = d.id
       LEFT JOIN gmail_accounts ga ON ga.id = etl.gmail_account_id
       WHERE d.domain = 'email_triage'
         AND ($1::boolean = FALSE OR d.feedback IS NULL)
       ORDER BY d.created_at DESC
       LIMIT $2`,
      [pendingOnly, limit],
    );
    return rows;
  });
  res.json({ feed: rows });
}));

familyRouter.post('/feedback', asyncMw(async (req, res) => {
  const body = FeedbackSchema.parse(req.body);
  const uid = familyUserId(res);

  if (body.action === 'correct' || body.action === 'wrong') {
    await recordFeedback(uid, body.decision_id, body.action, body.note ? { raw: body.note } : null);
    await ackUrgentQueueByDecision(uid, body.decision_id);
    res.json({ status: 'recorded', feedback: body.action });
    return;
  }

  // action === 'adjust' — free text parsed by Claude, same as the Telegram ✏️ path
  if (!body.note || body.note.trim().length === 0) {
    res.status(400).json({ error: 'note_required_for_adjust' });
    return;
  }
  const original = await loadDecisionContext(uid, body.decision_id);
  if (!original) {
    res.status(404).json({ error: 'decision_not_found' });
    return;
  }
  const parsed = await parseFeedbackWithClaude(body.note, {
    classification: original.classification,
    urgency_score:  original.urgency_score,
    reasoning:      original.reasoning,
    subject:        original.subject,
    sender:         original.sender_email,
  });
  await recordFeedback(uid, body.decision_id, 'adjusted', { raw: body.note, parsed });
  await ackUrgentQueueByDecision(uid, body.decision_id);
  res.json({ status: 'recorded', feedback: 'adjusted', parsed });
}));

// --- Settings ----------------------------------------------------------------

familyRouter.get('/settings', asyncMw(async (_req, res) => {
  const rows = await withUserContext(familyUserId(res), async (client) => {
    const { rows } = await client.query(`SELECT key, value FROM family_settings`);
    return rows;
  });
  res.json({ settings: Object.fromEntries(rows.map((r: { key: string; value: unknown }) => [r.key, r.value])) });
}));

familyRouter.put('/settings', asyncMw(async (req, res) => {
  const body = SettingsPutSchema.parse(req.body);
  await withUserContext(familyUserId(res), async (client) => {
    for (const [key, value] of Object.entries(body)) {
      await client.query(
        `INSERT INTO family_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)],
      );
    }
  });
  res.json({ saved: Object.keys(body) });
}));

// ---------- Migration runner (admin) -----------------------------------------

/**
 * Applies migration 06 idempotently. Behind X-Internal-Auth (mounted in
 * index.ts), NOT behind requireFamilyUser — it must run before Ashley exists.
 */
export async function runMigration06(_req: Request, res: Response): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(MIGRATION_06_SQL);
    await client.query('COMMIT');
    memberCache = null;  // Ashley may have just been created
    res.json({ applied: MIGRATION_06_NAME });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Helpers ----------------------------------------------------------

/** asyncHandler twin for router middlewares/handlers (index.ts has its own). */
function asyncMw(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
