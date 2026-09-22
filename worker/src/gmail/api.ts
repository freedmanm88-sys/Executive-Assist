/**
 * Thin Gmail REST client (no googleapis dependency). Every call takes a
 * ready access token from oauth.ts. Message shapes are Gmail's own — the
 * same shape n8n forwarded, so the triage pipeline is unchanged.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`gmail api ${status}: ${body.slice(0, 200)}`);
  }
}

async function gmailFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new GmailApiError(res.status, await res.text());
  return (await res.json()) as T;
}

export interface GmailHeader { name: string; value: string }
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** Ids of messages matching a Gmail search query, newest first. */
export async function listMessageIds(token: string, q: string, maxResults = 50): Promise<{ id: string; threadId: string }[]> {
  const params = new URLSearchParams({ q, maxResults: String(maxResults) });
  const json = await gmailFetch<{ messages?: { id: string; threadId: string }[] }>(token, `/messages?${params}`);
  return json.messages ?? [];
}

export async function getMessage(token: string, id: string): Promise<GmailMessage> {
  return gmailFetch<GmailMessage>(token, `/messages/${id}?format=full`);
}

export async function getAttachment(token: string, messageId: string, attachmentId: string): Promise<string> {
  const json = await gmailFetch<{ data: string }>(token, `/messages/${messageId}/attachments/${attachmentId}`);
  return json.data; // base64url
}

/** Create a Gmail draft (optionally as a reply in a thread). Never sends. */
export async function createDraft(token: string, draft: {
  to: string; subject: string; body: string; threadId?: string; inReplyTo?: string;
}): Promise<{ id: string }> {
  const headers = [
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    ...(draft.inReplyTo ? [`In-Reply-To: ${draft.inReplyTo}`, `References: ${draft.inReplyTo}`] : []),
  ];
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${draft.body}`).toString('base64url');
  const json = await gmailFetch<{ id: string }>(token, '/drafts', {
    method: 'POST',
    body: JSON.stringify({ message: { raw, ...(draft.threadId ? { threadId: draft.threadId } : {}) } }),
  });
  return json;
}

/** Walk a payload for PDF attachments (Phase 4). */
export function findPdfAttachments(payload: GmailPart | undefined): { filename: string; attachmentId: string; size: number }[] {
  const out: { filename: string; attachmentId: string; size: number }[] = [];
  const walk = (p: GmailPart | undefined): void => {
    if (!p) return;
    if (p.mimeType === 'application/pdf' && p.body?.attachmentId && p.filename) {
      out.push({ filename: p.filename, attachmentId: p.body.attachmentId, size: p.body.size ?? 0 });
    }
    p.parts?.forEach(walk);
  };
  walk(payload);
  return out;
}
