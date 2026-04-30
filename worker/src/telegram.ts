/**
 * Telegram Bot API outbound. Just enough for our needs — sendMessage with optional
 * Markdown formatting. No need for the full SDK.
 */

import { config } from './config.js';

const BASE = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

interface SendMessageOptions {
  chatId?: number | string;       // defaults to config.TELEGRAM_CHAT_ID
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  disablePreview?: boolean;
}

interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

/**
 * Send a Telegram message. Throws on API failure (network or non-ok response).
 */
export async function sendMessage(text: string, opts: SendMessageOptions = {}): Promise<void> {
  const chatId = opts.chatId ?? config.TELEGRAM_CHAT_ID;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (opts.parseMode)      body['parse_mode'] = opts.parseMode;
  if (opts.disablePreview) body['link_preview_options'] = { is_disabled: true };

  const resp = await fetch(`${BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = (await resp.json()) as TelegramResponse;
  if (!json.ok) {
    throw new Error(`Telegram sendMessage failed: ${json.description ?? `status ${resp.status}`}`);
  }
}

/**
 * Markdown-escape user content. Telegram's Markdown V1 escapes `*_[`.
 */
export function escapeMarkdown(s: string): string {
  return String(s).replace(/[*_`[\]]/g, (m) => '\\' + m);
}
