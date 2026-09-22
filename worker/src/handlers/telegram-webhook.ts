/**
 * Telegram webhook — receives Bot API updates directly (replaces n8n W1/W2).
 *
 * POST /events/telegram
 *   - verified by X-Telegram-Bot-Api-Secret-Token (derived from INTERNAL_AUTH_TOKEN)
 *   - only Mark's chat is honoured; anything else is acknowledged and dropped
 *   - callback_query  → existing feedback button handler
 *   - reply to [FB#…] → existing free-text feedback handler
 *   - /help           → short help
 *   - any other text  → quick-add assistant (same brain as the app's ✨ box)
 *
 * POST /admin/telegram-webhook registers this URL with Telegram (one-time).
 */

import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { pool } from '../db.js';
import { sendMessage } from '../telegram.js';
import { telegramCallbackHandler, telegramFeedbackReplyHandler } from './feedback-event.js';
import { runAssistant } from './family-assistant.js';

export function telegramWebhookSecret(): string {
  return createHash('sha256').update(`${config.INTERNAL_AUTH_TOKEN}:telegram-webhook`).digest('hex').slice(0, 64);
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    reply_to_message?: { message_id: number; text?: string };
  };
  callback_query?: { id: string; from: { id: number }; data: string; message: { message_id: number; chat: { id: number }; text?: string } };
}

export async function telegramWebhookHandler(req: Request, res: Response): Promise<void> {
  if (req.header('X-Telegram-Bot-Api-Secret-Token') !== telegramWebhookSecret()) {
    res.status(401).json({ error: 'bad_secret' });
    return;
  }
  const update = req.body as TgUpdate;
  const chatId = update.callback_query?.message.chat.id ?? update.message?.chat.id;
  if (String(chatId) !== config.TELEGRAM_CHAT_ID) {
    res.status(200).json({ ignored: 'unknown_chat' });   // never error back to Telegram
    return;
  }

  if (update.callback_query) {
    await telegramCallbackHandler(req, res);   // schema tolerates the extra update_id
    return;
  }

  const msg = update.message;
  if (!msg?.text) { res.status(200).json({ ignored: 'no_text' }); return; }

  if (msg.reply_to_message?.text && /^\[FB#[0-9a-f-]{36}#\]/i.test(msg.reply_to_message.text)) {
    await telegramFeedbackReplyHandler(req, res);
    return;
  }

  if (/^\/(help|start)\b/.test(msg.text)) {
    await sendMessage(
      [
        'Freedman HQ assistant. Just type what you need:',
        '• "add milk to grocery"',
        '• "task for Ashley: book dentist Friday"',
        '• "pizza night Saturday 6pm"',
        '• "log my exercise"',
        'Review email decisions in the app → Review tab.',
      ].join('\n'),
    );
    res.status(200).json({ status: 'help' });
    return;
  }

  // Everything else → the quick-add assistant.
  try {
    const { rows } = await pool.query<{ id: string; full_name: string | null; email: string }>(
      `SELECT id, full_name, email FROM users WHERE deleted_at IS NULL ORDER BY created_at`,
    );
    const result = await runAssistant(
      config.USER_ID,
      rows.map((r) => ({ id: r.id, name: r.full_name ?? r.email.split('@')[0] ?? '?' })),
      msg.text,
    );
    const lines = [...result.actions.map((a) => `✓ ${a}`)];
    if (result.actions.length === 0 || result.reply !== 'Done.') lines.push(result.reply);
    await sendMessage(lines.join('\n'));
    res.status(200).json({ status: 'assistant', actions: result.actions.length });
  } catch (err) {
    console.error('[telegram] assistant failed:', err);
    await sendMessage("Sorry — that didn't work. Try again or use the app.");
    res.status(200).json({ status: 'error' });
  }
}

/** One-time: point Telegram at this worker. Returns Telegram's response. */
export async function registerTelegramWebhook(publicUrl: string): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${publicUrl}/events/telegram`,
      secret_token: telegramWebhookSecret(),
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    }),
  });
  return res.json();
}
