/**
 * Telegram Bot API outbound. Just enough for our needs — sendMessage with optional
 * Markdown formatting. No need for the full SDK.
 */

import { config } from './config.js';

const BASE = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

export interface InlineKeyboardButton {
  text:           string;
  callback_data?: string;
  url?:           string;
}

interface SendMessageOptions {
  chatId?:         number | string;       // defaults to config.TELEGRAM_CHAT_ID
  parseMode?:      'Markdown' | 'MarkdownV2' | 'HTML';
  disablePreview?: boolean;
  inlineKeyboard?: InlineKeyboardButton[][];
  forceReply?:     boolean;
}

interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface SentMessage {
  message_id: number;
  chat:       { id: number };
}

/**
 * Send a Telegram message. Throws on API failure. Returns the sent message metadata.
 */
export async function sendMessage(
  text: string,
  opts: SendMessageOptions = {},
): Promise<SentMessage> {
  const chatId = opts.chatId ?? config.TELEGRAM_CHAT_ID;

  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.parseMode)      body['parse_mode']            = opts.parseMode;
  if (opts.disablePreview) body['link_preview_options']  = { is_disabled: true };

  if (opts.inlineKeyboard) {
    body['reply_markup'] = { inline_keyboard: opts.inlineKeyboard };
  } else if (opts.forceReply) {
    body['reply_markup'] = { force_reply: true, selective: false };
  }

  const resp = await fetch(`${BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = (await resp.json()) as TelegramResponse<SentMessage>;
  if (!json.ok || !json.result) {
    throw new Error(`Telegram sendMessage failed: ${json.description ?? `status ${resp.status}`}`);
  }
  return json.result;
}

/**
 * Acknowledge a callback_query. Without this, the spinning-wheel on the user's
 * tapped button stays forever.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) body['text'] = text;

  const resp = await fetch(`${BASE}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await resp.json()) as TelegramResponse;
  if (!json.ok) {
    throw new Error(`Telegram answerCallbackQuery failed: ${json.description ?? resp.status}`);
  }
}

/**
 * Replace a message's reply markup (e.g. remove inline keyboard buttons after a tap).
 * Pass null to clear all buttons.
 */
export async function editMessageReplyMarkup(
  chatId: number | string,
  messageId: number,
  inlineKeyboard: InlineKeyboardButton[][] | null,
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId };
  body['reply_markup'] = inlineKeyboard ? { inline_keyboard: inlineKeyboard } : { inline_keyboard: [] };

  const resp = await fetch(`${BASE}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await resp.json()) as TelegramResponse;
  // "message is not modified" is non-fatal — Telegram throws if the new markup
  // matches the old. Treat as success.
  if (!json.ok && !(json.description ?? '').includes('not modified')) {
    throw new Error(`Telegram editMessageReplyMarkup failed: ${json.description ?? resp.status}`);
  }
}

/**
 * Edit a message's text. Used to append a status indicator after feedback ack.
 */
export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML',
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
  if (parseMode) body['parse_mode'] = parseMode;

  const resp = await fetch(`${BASE}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await resp.json()) as TelegramResponse;
  if (!json.ok && !(json.description ?? '').includes('not modified')) {
    throw new Error(`Telegram editMessageText failed: ${json.description ?? resp.status}`);
  }
}

/**
 * Markdown-escape user content. Telegram's Markdown V1 escapes `*_[`.
 */
export function escapeMarkdown(s: string): string {
  return String(s).replace(/[*_`[\]]/g, (m) => '\\' + m);
}
