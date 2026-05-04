/**
 * Feedback handlers — captures user corrections on Claude's email triage decisions.
 *
 * Two endpoints:
 *
 * POST /events/telegram-callback
 *   Fires when the user taps a ✅/❌/✏️ button on an urgent-email alert.
 *   - ✅ → marks ai_decisions.feedback = 'correct', edits message to confirm
 *   - ❌ → marks ai_decisions.feedback = 'wrong', edits message to confirm
 *   - ✏️ → sends a force_reply prompt; user's text reply will hit the next endpoint
 *
 * POST /events/telegram-feedback-reply
 *   Fires when the user replies to the force_reply prompt sent above.
 *   The original prompt's text starts with [FB#<decision_id>#]; we extract that
 *   id, send the user's free-text comment to Claude for structured parsing,
 *   and save it as feedback = 'adjusted' with the parsed structure stored in
 *   feedback_note JSON.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { withUserContext } from '../db.js';
import { anthropic, DEFAULT_MODEL } from '../claude.js';
import {
  sendMessage,
  answerCallbackQuery,
  editMessageReplyMarkup,
  editMessageText,
} from '../telegram.js';
import { config } from '../config.js';

// ---------- Schemas ---------------------------------------------------------

const CallbackQuerySchema = z.object({
  callback_query: z.object({
    id:   z.string(),
    from: z.object({ id: z.number() }),
    data: z.string(),
    message: z.object({
      message_id: z.number(),
      chat:       z.object({ id: z.number() }),
      text:       z.string().optional(),
    }),
  }),
});

const FeedbackReplySchema = z.object({
  message: z.object({
    message_id: z.number(),
    chat:       z.object({ id: z.number() }),
    text:       z.string(),
    reply_to_message: z.object({
      message_id: z.number(),
      text:       z.string().optional(),
    }),
  }),
});

// ---------- Helpers ---------------------------------------------------------

const FB_MARKER = /^\[FB#([0-9a-f-]{36})#\]/i;

interface ParsedCallback {
  action:      'correct' | 'wrong' | 'adjust';
  decisionId:  string;
}

function parseCallbackData(data: string): ParsedCallback | null {
  // Format: fb:<action>:<decision_id>
  const m = data.match(/^fb:(correct|wrong|adjust):([0-9a-f-]{36})$/i);
  if (!m || !m[1] || !m[2]) return null;
  return { action: m[1] as ParsedCallback['action'], decisionId: m[2] };
}

async function recordFeedback(
  userId: string,
  decisionId: string,
  feedback: 'correct' | 'wrong' | 'adjusted',
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

async function ackUrgentQueueByDecision(userId: string, decisionId: string): Promise<void> {
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

// ---------- Claude parse for free-text feedback -----------------------------

interface ParsedAdjustment {
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

async function parseFeedbackWithClaude(
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

// ---------- Endpoint: callback button taps ----------------------------------

export async function telegramCallbackHandler(req: Request, res: Response): Promise<void> {
  const parsed = CallbackQuerySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }

  const cq = parsed.data.callback_query;
  const action = parseCallbackData(cq.data);
  if (!action) {
    await answerCallbackQuery(cq.id, 'unknown action');
    res.status(200).json({ status: 'ignored', reason: 'unknown_callback_data' });
    return;
  }

  const userId  = config.USER_ID;
  const chatId  = cq.message.chat.id;
  const msgId   = cq.message.message_id;

  if (action.action === 'correct' || action.action === 'wrong') {
    const feedback = action.action === 'correct' ? 'correct' : 'wrong';
    await recordFeedback(userId, action.decisionId, feedback, null);
    await ackUrgentQueueByDecision(userId, action.decisionId);

    const indicator = action.action === 'correct' ? '✅ marked correct' : '❌ marked wrong';
    await editMessageReplyMarkup(chatId, msgId, null);                            // strip buttons
    if (cq.message.text) {
      await editMessageText(chatId, msgId, `${cq.message.text}\n\n_${indicator}_`, 'Markdown');
    }
    await answerCallbackQuery(cq.id, indicator);

    res.status(200).json({ status: 'recorded', feedback, decision_id: action.decisionId });
    return;
  }

  // action === 'adjust'
  // Send a force_reply prompt. User's reply hits /events/telegram-feedback-reply.
  const promptText = `[FB#${action.decisionId}#] What should I have done? Reply to this message with details.`;
  await sendMessage(promptText, { chatId, forceReply: true });

  // Strip buttons on the original alert so user can't double-feedback
  await editMessageReplyMarkup(chatId, msgId, null);
  if (cq.message.text) {
    await editMessageText(chatId, msgId, `${cq.message.text}\n\n_✏️ awaiting your adjustment_`, 'Markdown');
  }
  await answerCallbackQuery(cq.id, 'Reply with your correction');

  res.status(200).json({ status: 'awaiting_reply', decision_id: action.decisionId });
}

// ---------- Endpoint: free-text reply after ✏️ ------------------------------

export async function telegramFeedbackReplyHandler(req: Request, res: Response): Promise<void> {
  const parsed = FeedbackReplySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }

  const msg          = parsed.data.message;
  const replyToText  = msg.reply_to_message.text ?? '';
  const markerMatch  = replyToText.match(FB_MARKER);
  if (!markerMatch || !markerMatch[1]) {
    res.status(400).json({ error: 'no_feedback_marker_in_reply_to' });
    return;
  }
  const decisionId = markerMatch[1];
  const userComment = msg.text;
  const userId = config.USER_ID;

  // Pull original decision context for Claude's parsing prompt
  const original = await withUserContext(userId, async (client) => {
    const { rows } = await client.query<{
      classification:  string;
      urgency_score:   number;
      reasoning:       string;
      subject:         string;
      sender_email:    string;
    }>(
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

  if (!original) {
    res.status(404).json({ error: 'decision_not_found', decision_id: decisionId });
    return;
  }

  const parsedAdjustment = await parseFeedbackWithClaude(userComment, {
    classification: original.classification,
    urgency_score:  original.urgency_score,
    reasoning:      original.reasoning,
    subject:        original.subject,
    sender:         original.sender_email,
  });

  await recordFeedback(userId, decisionId, 'adjusted', {
    raw:    userComment,
    parsed: parsedAdjustment,
  });
  await ackUrgentQueueByDecision(userId, decisionId);

  // Send a confirmation reply
  const confirmLines = [
    '📝 Feedback recorded.',
    `*Assessment:* ${parsedAdjustment.user_assessment}`,
  ];
  if (parsedAdjustment.corrected_classification) {
    confirmLines.push(`*Should have been:* ${parsedAdjustment.corrected_classification}`);
  }
  if (parsedAdjustment.pattern_hint) {
    confirmLines.push(`*Future rule hint:* ${parsedAdjustment.pattern_hint}`);
  }
  await sendMessage(confirmLines.join('\n'), {
    chatId: msg.chat.id,
    parseMode: 'Markdown',
  });

  res.status(200).json({
    status:      'recorded',
    decision_id: decisionId,
    parsed:      parsedAdjustment,
  });
}
