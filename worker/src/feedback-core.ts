/**
 * Shared feedback logic — used by both the Telegram feedback handlers
 * (handlers/feedback-event.ts) and the family app API (handlers/family-api.ts).
 *
 * Records user corrections on ai_decisions, acknowledges related urgent_queue
 * rows, and parses free-text corrections into structured feedback via Claude.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { withUserContext } from './db.js';
import { anthropic, DEFAULT_MODEL } from './claude.js';

export type FeedbackValue = 'correct' | 'wrong' | 'adjusted';

export async function recordFeedback(
  userId: string,
  decisionId: string,
  feedback: FeedbackValue,
  feedbackNote: object | null,
): Promise<void> {
  await withUserContext(userId, async (client) => {
    await client.query(
      `UPDATE ai_decisions
       SET feedback = $1,
           feedback_note = $2,
           feedback_at = NOW()
       WHERE id = $3::uuid`,
      [feedback, feedbackNote ? JSON.stringify(feedbackNote) : null, decisionId],
    );
  });
}

export async function ackUrgentQueueByDecision(userId: string, decisionId: string): Promise<void> {
  // When the user gives any feedback on an urgent alert, mark its urgent_queue
  // row acknowledged so the (future) urgent-nag cron stops re-pinging it.
  await withUserContext(userId, async (client) => {
    await client.query(
      `UPDATE urgent_queue uq
       SET acknowledged_at = NOW(), ack_method = 'button'
       WHERE uq.acknowledged_at IS NULL
         AND uq.triage_log_id IN (
           SELECT id FROM email_triage_log WHERE decision_id = $1::uuid
         )`,
      [decisionId],
    );
  });
}

export interface DecisionContext {
  classification: string;
  urgency_score:  number;
  reasoning:      string;
  subject:        string;
  sender_email:   string;
}

/** Load the original decision + email context (for Claude's parsing prompt). */
export async function loadDecisionContext(
  userId: string,
  decisionId: string,
): Promise<DecisionContext | null> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<DecisionContext>(
      `SELECT
         (d.decision->>'classification')        AS classification,
         (d.decision->>'urgency_score')::int    AS urgency_score,
         d.reasoning                            AS reasoning,
         etl.subject                            AS subject,
         etl.sender_email                       AS sender_email
       FROM ai_decisions d
       LEFT JOIN email_triage_log etl ON etl.decision_id = d.id
       WHERE d.id = $1::uuid
       LIMIT 1`,
      [decisionId],
    );
    return rows[0] ?? null;
  });
}

// ---------- Claude parse for free-text feedback -----------------------------

export interface ParsedAdjustment {
  user_assessment:        'wrong' | 'partial' | 'correct';
  corrected_classification?: string;
  corrected_urgency?:        number;
  reason:                    string;
  pattern_hint?:             string;
}

const PARSE_FEEDBACK_TOOL: Anthropic.Tool = {
  name: 'record_feedback',
  description: "Extract structured feedback about a triage decision from the user's free-text correction.",
  input_schema: {
    type: 'object',
    properties: {
      user_assessment: {
        type: 'string',
        enum: ['wrong', 'partial', 'correct'],
        description: 'Overall: did the original triage decision get it wrong, partially right, or actually correct?',
      },
      corrected_classification: {
        type: 'string',
        enum: ['urgent', 'action', 'reply_needed', 'fyi', 'newsletter', 'receipt', 'calendar', 'spam'],
        description: 'If the user implied a different classification, name it. Omit if the user did not specify.',
      },
      corrected_urgency: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: "If the user implied a specific urgency level, give a 0-100 score. Omit if not implied.",
      },
      reason: {
        type: 'string',
        description: "One sentence summary of the user's reasoning, in their words.",
      },
      pattern_hint: {
        type: 'string',
        description: 'A reusable rule the system could learn (e.g. "newsletters from billing@stripe should be receipt"). Omit if no generalizable pattern.',
      },
    },
    required: ['user_assessment', 'reason'],
  },
};

export async function parseFeedbackWithClaude(
  userComment: string,
  originalDecision: { classification: string; urgency_score: number; reasoning: string; subject: string; sender: string },
): Promise<ParsedAdjustment> {
  const userMessage = [
    'Original triage decision:',
    `  Email: "${originalDecision.subject}" from ${originalDecision.sender}`,
    `  Classified as: ${originalDecision.classification} (urgency ${originalDecision.urgency_score}/100)`,
    `  Reasoning: ${originalDecision.reasoning}`,
    '',
    "User's correction:",
    `  "${userComment}"`,
    '',
    'Use the record_feedback tool to extract structured signal from the correction.',
  ].join('\n');

  const response = await anthropic.messages.create({
    model:       DEFAULT_MODEL,
    max_tokens:  400,
    system: [
      {
        type: 'text',
        text: 'You parse user corrections on email triage decisions into structured feedback. Use the record_feedback tool. Be conservative — only fill optional fields when the user clearly implied them.',
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [{ ...PARSE_FEEDBACK_TOOL, cache_control: { type: 'ephemeral' } }],
    tool_choice: { type: 'tool', name: 'record_feedback' },
    messages: [{ role: 'user', content: userMessage }],
  });

  const tu = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_feedback',
  );
  if (!tu) throw new Error('Claude did not return record_feedback tool_use');

  return tu.input as ParsedAdjustment;
}
