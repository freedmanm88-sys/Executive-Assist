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

import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  recordFeedback,
  ackUrgentQueueByDecision,
  loadDecisionContext,
  parseFeedbackWithClaude,
} from '../feedback-core.js';
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

// recordFeedback / ackUrgentQueueByDecision / parseFeedbackWithClaude live in
// feedback-core.ts — shared with the family app API.

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
  const original = await loadDecisionContext(userId, decisionId);

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
