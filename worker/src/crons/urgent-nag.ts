/**
 * Urgent Nag — re-pings unacknowledged urgent emails so they don't become
 * write-once-and-forgotten. Runs 10:00 / 14:00 / 18:00 Toronto (see crons/index).
 *
 * Per the architecture doc: ONE consolidated ping listing everything still
 * pending — never one message per item (a backlog would flood the chat).
 *
 * Rules:
 * - Items unacknowledged for >7 days auto-expire (ack_method='expired') —
 *   if it's been ignored a week, nagging isn't working; it stays visible in
 *   the app's inbox instead.
 * - Skip the run entirely if everything pending was already pinged <1h ago.
 * - Feedback on the original alert (or in the app) acknowledges items.
 */

import { withUserContext } from '../db.js';
import { sendMessage } from '../telegram.js';
import { sendPushToUser } from '../push.js';
import { config } from '../config.js';

const EXPIRE_AFTER_DAYS = 7;
const MAX_LISTED = 10;

interface NagRow {
  id:           string;
  summary:      string;
  ping_count:   number;
  subject:      string | null;
  sender_email: string | null;
}

export async function runUrgentNag(): Promise<{ expired: number; pending: number; pinged: boolean }> {
  const userId = config.USER_ID; // Phase 1: single email-triage user

  const { expired, rows } = await withUserContext(userId, async (client) => {
    const exp = await client.query(
      `UPDATE urgent_queue
       SET acknowledged_at = NOW(), ack_method = 'expired'
       WHERE acknowledged_at IS NULL
         AND first_pinged_at < NOW() - INTERVAL '${EXPIRE_AFTER_DAYS} days'`,
    );
    const { rows } = await client.query<NagRow>(
      `SELECT uq.id, uq.summary, uq.ping_count, etl.subject, etl.sender_email
       FROM urgent_queue uq
       JOIN email_triage_log etl ON etl.id = uq.triage_log_id
       WHERE uq.acknowledged_at IS NULL
         AND uq.last_pinged_at < NOW() - INTERVAL '1 hour'
       ORDER BY uq.first_pinged_at DESC`,
    );
    return { expired: exp.rowCount ?? 0, rows };
  });

  if (rows.length === 0) {
    console.log(`[cron:urgent-nag] nothing to nag (expired=${expired})`);
    return { expired, pending: 0, pinged: false };
  }

  const listed = rows.slice(0, MAX_LISTED);
  const lines = [
    `🔁 *${rows.length} urgent email${rows.length === 1 ? '' : 's'} still waiting:*`,
    ...listed.map(
      (r) => `• *${escapeMarkdown(r.subject ?? '(no subject)')}* — ${escapeMarkdown(r.sender_email ?? 'unknown')}`,
    ),
  ];
  if (rows.length > listed.length) lines.push(`…and ${rows.length - listed.length} more.`);
  lines.push('_Reply on the original alert or review in the app to clear these._');

  await sendMessage(lines.join('\n'), { parseMode: 'Markdown', disablePreview: true });

  await sendPushToUser(userId, {
    title: `${rows.length} urgent email${rows.length === 1 ? '' : 's'} still waiting`,
    body:  listed.map((r) => r.subject ?? '(no subject)').join(' · '),
    url:   '/inbox',
    tag:   'urgent-nag',
  });

  await withUserContext(userId, (client) =>
    client.query(
      `UPDATE urgent_queue SET last_pinged_at = NOW(), ping_count = ping_count + 1
       WHERE acknowledged_at IS NULL`,
    ),
  );

  console.log(`[cron:urgent-nag] consolidated ping sent (pending=${rows.length}, expired=${expired})`);
  return { expired, pending: rows.length, pinged: true };
}

function escapeMarkdown(s: string): string {
  return s.replace(/([_*[\]`])/g, '\\$1');
}
