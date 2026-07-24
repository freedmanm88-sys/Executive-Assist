/**
 * Urgent Nag — re-pings unacknowledged urgent emails so they don't become
 * write-once-and-forgotten. Runs 10:00 / 14:00 / 18:00 Toronto (see crons/index).
 *
 * Rules:
 * - Only items with acknowledged_at IS NULL
 * - Skip anything pinged within the last hour (e.g. the initial alert just fired)
 * - Re-send with the same ✅/❌/✏️ feedback buttons; any feedback ack's the item
 */

import { withUserContext } from '../db.js';
import { sendMessage } from '../telegram.js';
import { config } from '../config.js';

interface NagRow {
  id:            string;
  summary:       string;
  ping_count:    number;
  subject:       string | null;
  sender_email:  string | null;
  decision_id:   string | null;
}

export async function runUrgentNag(): Promise<{ pinged: number; skipped: number }> {
  const userId = config.USER_ID; // Phase 1: single email-triage user

  const rows = await withUserContext(userId, async (client) => {
    const { rows } = await client.query<NagRow>(
      `SELECT uq.id, uq.summary, uq.ping_count,
              etl.subject, etl.sender_email, etl.decision_id
       FROM urgent_queue uq
       JOIN email_triage_log etl ON etl.id = uq.triage_log_id
       WHERE uq.acknowledged_at IS NULL
         AND uq.last_pinged_at < NOW() - INTERVAL '1 hour'
       ORDER BY uq.first_pinged_at`,
    );
    return rows;
  });

  let pinged = 0;
  for (const row of rows) {
    const lines = [
      `🔁 *Still waiting on this urgent email* (nag #${row.ping_count})`,
      `*${escapeMarkdown(row.subject ?? '(no subject)')}*`,
      `From: ${escapeMarkdown(row.sender_email ?? 'unknown')}`,
      escapeMarkdown(row.summary),
    ];
    await sendMessage(lines.join('\n'), {
      parseMode: 'Markdown',
      disablePreview: true,
      ...(row.decision_id
        ? {
            inlineKeyboard: [[
              { text: '✅ Correct', callback_data: `fb:correct:${row.decision_id}` },
              { text: '❌ Wrong',   callback_data: `fb:wrong:${row.decision_id}` },
              { text: '✏️ Adjust',  callback_data: `fb:adjust:${row.decision_id}` },
            ]],
          }
        : {}),
    });

    await withUserContext(userId, (client) =>
      client.query(
        `UPDATE urgent_queue SET last_pinged_at = NOW(), ping_count = ping_count + 1
         WHERE id = $1::uuid`,
        [row.id],
      ),
    );
    pinged++;
  }

  const skipped = rows.length - pinged;
  console.log(`[cron:urgent-nag] pinged=${pinged} skipped=${skipped}`);
  return { pinged, skipped };
}

function escapeMarkdown(s: string): string {
  return s.replace(/([_*[\]`])/g, '\\$1');
}
