/**
 * Extract a proposed family task or event from an actionable personal email.
 * Called from the gmail-event pipeline for classification action/calendar
 * (personal inbox only). Best-effort: failures never break triage.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, DEFAULT_MODEL } from './claude.js';
import { withUserContext } from './db.js';
import { sendPushToUser } from './push.js';
import { pool } from './db.js';

export interface ProposalPayload {
  kind:          'task' | 'event' | 'none';
  title?:        string;
  notes?:        string;
  due_date?:     string;   // YYYY-MM-DD Toronto (tasks)
  date?:         string;   // YYYY-MM-DD Toronto (events)
  time?:         string;   // HH:MM 24h (events)
  duration_min?: number;
  location?:     string;
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'propose_item',
  description: 'Propose a family task or calendar event extracted from the email, or none.',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['task', 'event', 'none'],
        description: "task = something someone must do. event = something with a date/time to attend. none = nothing concrete to propose.",
      },
      title:        { type: 'string', description: 'Short, action-oriented. E.g. "Send pizza money for Logan\'s class party".' },
      notes:        { type: 'string', description: 'Key details from the email (1-2 sentences).' },
      due_date:     { type: 'string', description: 'Tasks: YYYY-MM-DD deadline if stated.' },
      date:         { type: 'string', description: 'Events: YYYY-MM-DD.' },
      time:         { type: 'string', description: 'Events: HH:MM 24h if stated.' },
      duration_min: { type: 'integer' },
      location:     { type: 'string' },
    },
    required: ['kind'],
  },
};

export async function extractProposal(email: {
  subject: string;
  fromHeader: string;
  bodySnippet: string;
}): Promise<ProposalPayload | null> {
  const todayToronto = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  }).format(new Date());

  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 500,
    system: [{
      type: 'text',
      text: `You extract concrete to-dos or events from family emails (school notices, appointments, activities) for a shared family organizer. Today is ${todayToronto} (America/Toronto). Resolve relative dates yourself. Propose 'none' unless there is a clear, concrete action or event a parent must handle.`,
      cache_control: { type: 'ephemeral' },
    }],
    tools: [{ ...EXTRACT_TOOL, cache_control: { type: 'ephemeral' } }],
    tool_choice: { type: 'tool', name: 'propose_item' },
    messages: [{
      role: 'user',
      content: `From: ${email.fromHeader}\nSubject: ${email.subject}\n\n${email.bodySnippet || '(empty)'}`,
    }],
  });

  const tu = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'propose_item',
  );
  if (!tu) return null;
  const payload = tu.input as ProposalPayload;
  if (payload.kind === 'none' || !payload.title) return null;
  return payload;
}

/** Persist the proposal and push-notify every family member. Best-effort. */
export async function createProposal(
  userId: string,
  triageLogId: string,
  email: { subject: string; senderEmail: string },
  payload: ProposalPayload,
): Promise<void> {
  await withUserContext(userId, (client) =>
    client.query(
      `INSERT INTO family_proposals (kind, payload, triage_log_id, subject, sender_email)
       VALUES ($1, $2, $3::uuid, $4, $5)`,
      [payload.kind, JSON.stringify(payload), triageLogId, email.subject, email.senderEmail],
    ),
  );

  const { rows: members } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE deleted_at IS NULL`,
  );
  for (const m of members) {
    await sendPushToUser(m.id, {
      title: payload.kind === 'event' ? '📅 Suggested event from an email' : '📋 Suggested task from an email',
      body: `${payload.title}${payload.due_date ? ` (due ${payload.due_date})` : payload.date ? ` (${payload.date})` : ''}`,
      url: '/',
      tag: 'proposal',
    });
  }
}
