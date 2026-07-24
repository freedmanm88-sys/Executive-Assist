/**
 * POST /events/gmail
 *
 * Receives a Gmail message from n8n's Gmail Trigger workflow.
 * - Idempotency via email_triage_log unique index on (user_id, gmail_message_id)
 * - Classify via Claude with structured tool output
 * - Insert ai_decisions + email_triage_log in a single CTE (atomic)
 * - On urgent: insert urgent_queue + send Telegram alert
 *
 * Always responds 200 OK if processing completed (even for already-triaged duplicates).
 * Only returns 4xx for malformed requests or 5xx for unrecoverable errors.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { withUserContext } from '../db.js';
import { classifyEmail } from '../classifiers/email-triage.js';
import type { ClassifyResult } from '../classifiers/email-triage.js';
import { loadTriageRules, matchTriageRules, loadTriagePreferences } from '../triage-rules.js';
import { extractProposal, createProposal } from '../proposal-extract.js';
import { sendMessage, escapeMarkdown } from '../telegram.js';
import { sendPushToUser } from '../push.js';
import { config } from '../config.js';

// ---------- Request schema ---------------------------------------------------

const HeaderSchema = z.object({ name: z.string(), value: z.string() });

const PayloadPartSchema: z.ZodType<{
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: PayloadPart[];
}> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body:     z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
    parts:    z.array(PayloadPartSchema).optional(),
  }),
);
type PayloadPart = z.infer<typeof PayloadPartSchema>;

const GmailMessageSchema = z.object({
  id:           z.string(),
  threadId:     z.string().optional(),
  snippet:      z.string().optional(),
  internalDate: z.string().optional(),
  labelIds:     z.array(z.string()).optional(),
  payload: z
    .object({
      mimeType: z.string().optional(),
      headers:  z.array(HeaderSchema).optional(),
      body:     z.object({ data: z.string().optional() }).optional(),
      parts:    z.array(PayloadPartSchema).optional(),
    })
    .optional(),
  // n8n's Gmail Trigger flattens these to top-level when Simplify=true (default).
  // Capture them so we don't depend on payload.headers / payload.parts being present.
  From:    z.string().optional(),
  To:      z.string().optional(),
  Subject: z.string().optional(),
  Date:    z.string().optional(),
  text:    z.string().optional(),
  html:    z.string().optional(),
});

const GmailEventSchema = z.object({
  gmail_account_label: z.enum(['personal', 'business1', 'business2']),
  message:             GmailMessageSchema,
});

type GmailEvent = z.infer<typeof GmailEventSchema>;

// ---------- Body extraction --------------------------------------------------

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractBody(message: GmailEvent['message']): string {
  // Prefer n8n's flattened text (Simplify=true). Fall back to html stripped, then to raw payload walk.
  if (message.text && message.text.trim()) return message.text.trim();
  if (message.html && message.html.trim()) {
    return message.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const payload = message.payload;
  if (!payload) return message.snippet ?? '';

  // Top-level body
  if (payload.body?.data) {
    try { return decodeBase64Url(payload.body.data); } catch { /* fall through */ }
  }

  // Walk parts: prefer text/plain
  function walk(parts: PayloadPart[] | undefined): string {
    if (!parts) return '';

    const plain = parts.find((p) => p.mimeType === 'text/plain');
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);

    const html = parts.find((p) => p.mimeType === 'text/html');
    if (html?.body?.data) {
      return decodeBase64Url(html.body.data)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Recurse into nested multipart
    for (const p of parts) {
      const got = walk(p.parts);
      if (got) return got;
    }
    return '';
  }

  return walk(payload.parts) || message.snippet || '';
}

// ---------- Header parsing ---------------------------------------------------

interface ParsedHeaders {
  subject:     string;
  fromHeader:  string;
  senderName:  string;
  senderEmail: string;
  receivedAt:  string;
}

function parseHeaders(message: GmailEvent['message']): ParsedHeaders {
  // Build a header map from payload.headers (raw Gmail API shape, when Simplify=false)
  const map: Record<string, string> = {};
  for (const h of message.payload?.headers ?? []) map[h.name.toLowerCase()] = h.value;

  // Prefer n8n's flattened top-level fields (Simplify=true), fall back to header map
  const fromHeader =
    message.From ?? map['from'] ?? '(unknown)';
  const subject =
    message.Subject ?? map['subject'] ?? '(no subject)';
  // Date precedence: explicit Date header → header map → internalDate (epoch ms) → now
  let receivedAt: string;
  if (message.Date) {
    receivedAt = message.Date;
  } else if (map['date']) {
    receivedAt = map['date'];
  } else if (message.internalDate) {
    // Gmail's internalDate is epoch milliseconds as a string. Convert to ISO.
    const ms = parseInt(message.internalDate, 10);
    receivedAt = Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
  } else {
    receivedAt = new Date().toISOString();
  }

  let senderName  = '';
  let senderEmail = fromHeader;
  const m = fromHeader.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    senderName  = (m[1] ?? '').replace(/"/g, '').trim();
    senderEmail = (m[2] ?? '').trim();
  }

  return { subject, fromHeader, senderName, senderEmail, receivedAt };
}

// ---------- DB helpers -------------------------------------------------------

interface GmailAccountRow {
  id:        string;
  user_id:   string;
  label:     string;
  address:   string;
}

async function getGmailAccountByLabel(
  userId: string,
  label: GmailEvent['gmail_account_label'],
): Promise<GmailAccountRow | null> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<GmailAccountRow>(
      `SELECT id, user_id, label, address
       FROM gmail_accounts
       WHERE label = $1 AND active = TRUE
       LIMIT 1`,
      [label],
    );
    return rows[0] ?? null;
  });
}

async function alreadyTriaged(userId: string, gmailMessageId: string): Promise<boolean> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM email_triage_log WHERE gmail_message_id = $1`,
      [gmailMessageId],
    );
    return parseInt(rows[0]?.count ?? '0', 10) > 0;
  });
}

interface SaveTriageInput {
  userId:           string;
  gmailAccountId:   string;
  gmailMessageId:   string;
  gmailThreadId:    string | null;
  subject:          string;
  senderEmail:      string;
  senderName:       string;
  receivedAt:       string;
  classification:   ClassifyResult;
  modelUsed:        string;
}

async function saveTriage(input: SaveTriageInput): Promise<{ triageId: string; decisionId: string }> {
  return withUserContext(input.userId, async (client) => {
    const wouldArchive = ['newsletter', 'receipt', 'spam'].includes(input.classification.classification);

    const { rows } = await client.query<{ triage_id: string; decision_id: string }>(
      `WITH dec AS (
         INSERT INTO ai_decisions (
           user_id, domain, decision, reasoning, inputs, model, prompt_version, related_table
         ) VALUES (
           current_user_id(),
           'email_triage',
           jsonb_build_object(
             'classification',   $1::text,
             'urgency_score',    $2::int,
             'suggested_action', $3::text
           ),
           $4::text,
           jsonb_build_object(
             'gmail_message_id', $5::text,
             'sender_email',     $6::text,
             'subject',          $7::text
           ),
           $8::text,
           'phase1-v1',
           'email_triage_log'
         )
         RETURNING id
       ),
       log AS (
         INSERT INTO email_triage_log (
           user_id, gmail_account_id, gmail_message_id, gmail_thread_id,
           subject, sender_email, sender_name, received_at,
           classification, reasoning, would_archive, archived, decision_id
         )
         SELECT
           current_user_id(), $9::uuid, $5::text, $10::text,
           $7::text, $6::text, $11::text, $12::timestamptz,
           $1::text, $4::text, $13::boolean, FALSE, d.id
         FROM dec d
         ON CONFLICT (user_id, gmail_message_id) DO NOTHING
         RETURNING id
       )
       SELECT
         (SELECT id FROM log) AS triage_id,
         (SELECT id FROM dec) AS decision_id;`,
      [
        input.classification.classification,            // $1
        input.classification.urgency_score,             // $2
        input.classification.suggested_action,          // $3
        input.classification.reasoning,                 // $4
        input.gmailMessageId,                           // $5
        input.senderEmail,                              // $6
        input.subject,                                  // $7
        input.modelUsed,                                // $8
        input.gmailAccountId,                           // $9
        input.gmailThreadId ?? '',                      // $10
        input.senderName,                               // $11
        input.receivedAt,                               // $12
        wouldArchive,                                   // $13
      ],
    );

    const row = rows[0];
    if (!row || !row.triage_id) {
      // Race condition: another concurrent call inserted the same gmail_message_id.
      // Recover by looking up the existing row.
      const existing = await client.query<{ triage_id: string; decision_id: string }>(
        `SELECT id AS triage_id, decision_id FROM email_triage_log WHERE gmail_message_id = $1 LIMIT 1`,
        [input.gmailMessageId],
      );
      const e = existing.rows[0];
      if (!e) throw new Error('saveTriage: insert returned no row and no existing row found');
      return { triageId: e.triage_id, decisionId: e.decision_id };
    }
    return { triageId: row.triage_id, decisionId: row.decision_id };
  });
}

async function insertUrgentQueue(userId: string, triageId: string, summary: string): Promise<void> {
  await withUserContext(userId, async (client) => {
    await client.query(
      `INSERT INTO urgent_queue (user_id, triage_log_id, summary)
       VALUES (current_user_id(), $1::uuid, $2)`,
      [triageId, summary],
    );
  });
}

// ---------- Handler ----------------------------------------------------------

export async function gmailEventHandler(req: Request, res: Response): Promise<void> {
  const parsed = GmailEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }

  const { gmail_account_label, message } = parsed.data;
  const userId = config.USER_ID;

  // Idempotency check
  if (await alreadyTriaged(userId, message.id)) {
    res.status(200).json({ status: 'already_triaged', gmail_message_id: message.id });
    return;
  }

  const account = await getGmailAccountByLabel(userId, gmail_account_label);
  if (!account) {
    res.status(404).json({ error: 'gmail_account_not_found', label: gmail_account_label });
    return;
  }

  const headers = parseHeaders(message);
  const body    = extractBody(message).slice(0, 4000); // keep token cost bounded

  // Level 1: hard rules (learned or hand-written) run before Claude.
  const rules = await loadTriageRules(userId);
  const ruleMatch = matchTriageRules(rules, {
    senderEmail: headers.senderEmail,
    subject: headers.subject,
  });

  let classification: ClassifyResult;
  if (ruleMatch.classify) {
    classification = {
      classification:   ruleMatch.classify,
      urgency_score:    ruleMatch.classify === 'urgent' ? 85 : 5,
      reasoning:        `Matched triage rule: ${ruleMatch.matched.map((r) => `${r.pattern_type}=${r.pattern_value}`).join(', ')}`,
      suggested_action: ruleMatch.classify === 'newsletter' || ruleMatch.classify === 'spam' ? 'archive' : 'label_only',
    };
  } else {
    const preferences = await loadTriagePreferences(userId);
    classification = await classifyEmail({
      subject:      headers.subject,
      fromHeader:   headers.fromHeader,
      receivedAt:   headers.receivedAt,
      bodySnippet:  body,
      preferences,
      accountLabel: gmail_account_label,
    });
  }

  // never_urgent / always_urgent rules adjust whatever Claude decided
  if (ruleMatch.neverUrgent && classification.urgency_score > 40) {
    classification = {
      ...classification,
      urgency_score: 40,
      classification: classification.classification === 'urgent' ? 'action' : classification.classification,
      reasoning: `${classification.reasoning} (urgency capped by never_urgent rule)`,
    };
  }
  if (ruleMatch.alwaysUrgent && classification.classification !== 'urgent') {
    classification = { ...classification, classification: 'urgent', urgency_score: Math.max(classification.urgency_score, 85) };
  }

  const { triageId, decisionId } = await saveTriage({
    userId,
    gmailAccountId:  account.id,
    gmailMessageId:  message.id,
    gmailThreadId:   message.threadId ?? null,
    subject:         headers.subject,
    senderEmail:     headers.senderEmail,
    senderName:      headers.senderName,
    receivedAt:      headers.receivedAt,
    classification,
    modelUsed:       'claude-sonnet-4-5-20250929',
  });

  // Email → proposed family task/event. Personal inbox only (business email
  // must never leak into the shared family space). Best-effort.
  if (
    gmail_account_label === 'personal' &&
    (classification.classification === 'action' || classification.classification === 'calendar')
  ) {
    try {
      const payload = await extractProposal({
        subject: headers.subject,
        fromHeader: headers.fromHeader,
        bodySnippet: body,
      });
      if (payload) {
        await createProposal(userId, triageId, {
          subject: headers.subject,
          senderEmail: headers.senderEmail,
        }, payload);
      }
    } catch (err) {
      console.error('[gmail-event] proposal extraction failed (non-fatal):', err);
    }
  }

  const isUrgent = classification.classification === 'urgent' || classification.urgency_score >= 80;

  if (isUrgent) {
    const summary = `${headers.subject} — ${classification.reasoning}`;
    await insertUrgentQueue(userId, triageId, summary);

    const senderDisplay = headers.senderName || headers.senderEmail;
    const alertText = [
      `🚨 *Urgent email* (${classification.urgency_score}/100)`,
      '',
      `*From:* ${escapeMarkdown(senderDisplay)}`,
      `*Account:* ${gmail_account_label}`,
      `*Subject:* ${escapeMarkdown(headers.subject)}`,
      '',
      escapeMarkdown(classification.reasoning),
    ].join('\n');

    await sendMessage(alertText, {
      parseMode: 'Markdown',
      disablePreview: true,
      inlineKeyboard: [[
        { text: '✅ Correct', callback_data: `fb:correct:${decisionId}` },
        { text: '❌ Wrong',   callback_data: `fb:wrong:${decisionId}` },
        { text: '✏️ Adjust',  callback_data: `fb:adjust:${decisionId}` },
      ]],
    });

    // Family app push — best-effort, never blocks the Telegram path
    await sendPushToUser(userId, {
      title: `🚨 Urgent: ${headers.subject}`,
      body:  `${senderDisplay} — ${classification.reasoning}`,
      url:   '/inbox',
      tag:   `urgent-${triageId}`,
    });
  }

  res.status(200).json({
    status:           'triaged',
    triage_id:        triageId,
    decision_id:      decisionId,
    classification:   classification.classification,
    urgency_score:    classification.urgency_score,
    is_urgent:        isUrgent,
    gmail_message_id: message.id,
  });
}
