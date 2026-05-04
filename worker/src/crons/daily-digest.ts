/**
 * Daily Digest — fires at 8 AM Toronto.
 *
 * Pulls the last 24 hours of email triage activity, the current urgent queue,
 * and weekly habit progress. Asks Claude to write a concise Telegram-friendly
 * summary. Sends it. Records the digest in digest_runs (idempotent on period_start).
 */

import { withUserContext } from '../db.js';
import { anthropic, DEFAULT_MODEL } from '../claude.js';
import { sendMessage } from '../telegram.js';
import { config } from '../config.js';

// ---------- Data shapes ------------------------------------------------------

interface TriageStat {
  label:          string;
  classification: string;
  count:          number;
}

interface UrgentItem {
  account_label:   string;
  subject:         string;
  sender_display:  string;
  summary:         string;
  first_pinged_at: string;
}

interface HabitProgress {
  name:                  string;
  target_per_week:       number;
  completed_this_week:   number;
}

interface DigestData {
  period_start: Date;
  period_end:   Date;
  triage_stats: TriageStat[];
  urgent_items: UrgentItem[];
  habit_progress: HabitProgress[];
}

// ---------- Data gathering ---------------------------------------------------

async function gatherDigestData(userId: string, periodStart: Date, periodEnd: Date): Promise<DigestData> {
  return withUserContext(userId, async (client) => {
    const triageStatsRes = await client.query<TriageStat>(
      `SELECT ga.label, etl.classification, COUNT(*)::int AS count
       FROM email_triage_log etl
       JOIN gmail_accounts ga ON etl.gmail_account_id = ga.id
       WHERE etl.processed_at >= $1 AND etl.processed_at < $2
       GROUP BY ga.label, etl.classification
       ORDER BY ga.label, count DESC`,
      [periodStart.toISOString(), periodEnd.toISOString()],
    );

    const urgentRes = await client.query<UrgentItem>(
      `SELECT
         ga.label                                                   AS account_label,
         etl.subject                                                AS subject,
         COALESCE(NULLIF(etl.sender_name, ''), etl.sender_email)    AS sender_display,
         uq.summary                                                  AS summary,
         uq.first_pinged_at                                          AS first_pinged_at
       FROM urgent_queue uq
       JOIN email_triage_log etl ON uq.triage_log_id = etl.id
       JOIN gmail_accounts ga    ON etl.gmail_account_id = ga.id
       WHERE uq.acknowledged_at IS NULL
       ORDER BY uq.first_pinged_at`,
    );

    const habitRes = await client.query<HabitProgress>(
      `SELECT h.name,
              h.target_per_week,
              COALESCE((
                SELECT COUNT(*)::int
                FROM habit_logs hl
                WHERE hl.habit_id = h.id
                  AND hl.completed_at >= date_trunc('week', NOW())
              ), 0) AS completed_this_week
       FROM habits h
       WHERE h.active = TRUE
       ORDER BY h.name`,
    );

    return {
      period_start:   periodStart,
      period_end:     periodEnd,
      triage_stats:   triageStatsRes.rows,
      urgent_items:   urgentRes.rows,
      habit_progress: habitRes.rows,
    };
  });
}

// ---------- Claude summary ---------------------------------------------------

const SYSTEM_PROMPT = `You are Mark's executive assistant writing a brief morning Telegram digest.

Style:
- Plain conversational text, NOT markdown beyond simple bullets
- Be direct and concise — Mark reads this on his phone before coffee
- Highlight only what needs attention; don't pad
- Use 🚨 sparingly, only for genuine urgency
- If a section has nothing notable, write a single short line and move on
- Maximum length: ~150 words. Hard cap: 250 words.
- No "Hello Mark" greeting — just the content. Save the greeting for the first line.`;

function formatDataForClaude(data: DigestData): string {
  const lines: string[] = [];
  lines.push(`Period: ${data.period_start.toISOString()} to ${data.period_end.toISOString()} (last 24h)`);
  lines.push('');

  // Triage stats
  lines.push('Email triage:');
  if (data.triage_stats.length === 0) {
    lines.push('  (no new emails triaged)');
  } else {
    const byAccount: Record<string, TriageStat[]> = {};
    for (const r of data.triage_stats) {
      if (!byAccount[r.label]) byAccount[r.label] = [];
      byAccount[r.label]!.push(r);
    }
    for (const [label, rows] of Object.entries(byAccount)) {
      const total = rows.reduce((s, r) => s + r.count, 0);
      const breakdown = rows.map((r) => `${r.classification}:${r.count}`).join(', ');
      lines.push(`  ${label}: ${total} total — ${breakdown}`);
    }
  }
  lines.push('');

  // Urgent queue
  lines.push(`Urgent queue (${data.urgent_items.length} unacked):`);
  if (data.urgent_items.length === 0) {
    lines.push('  (clean — nothing urgent open)');
  } else {
    for (const u of data.urgent_items) {
      lines.push(`  - [${u.account_label}] "${u.subject}" from ${u.sender_display}`);
      lines.push(`    Reason: ${u.summary}`);
    }
  }
  lines.push('');

  // Habits
  lines.push('Habits this week:');
  if (data.habit_progress.length === 0) {
    lines.push('  (no active habits configured)');
  } else {
    for (const h of data.habit_progress) {
      lines.push(`  - ${h.name}: ${h.completed_this_week}/${h.target_per_week}`);
    }
  }

  return lines.join('\n');
}

async function summarize(data: DigestData): Promise<string> {
  const userMessage = formatDataForClaude(data);

  const response = await anthropic.messages.create({
    model:      DEFAULT_MODEL,
    max_tokens: 600,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error(`Daily digest: Claude returned no text. stop_reason=${response.stop_reason}`);
  }

  return textBlock.text;
}

// ---------- Persistence ------------------------------------------------------

async function saveDigestRun(
  userId: string,
  periodStart: Date,
  periodEnd: Date,
  summary: string,
  data: DigestData,
  telegramMessageId: number | null,
): Promise<void> {
  await withUserContext(userId, async (client) => {
    await client.query(
      `INSERT INTO digest_runs
         (user_id, digest_type, period_start, period_end, summary, metrics, telegram_message_id)
       VALUES (current_user_id(), 'daily', $1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (user_id, digest_type, period_start) DO NOTHING`,
      [
        periodStart.toISOString(),
        periodEnd.toISOString(),
        summary,
        JSON.stringify({
          triage_count_total: data.triage_stats.reduce((s, r) => s + r.count, 0),
          urgent_open:        data.urgent_items.length,
          habits_active:      data.habit_progress.length,
        }),
        telegramMessageId,
      ],
    );
  });
}

// ---------- Public entry point -----------------------------------------------

export interface RunDailyDigestOptions {
  /** Override the period (for backfill / testing). Default: now-24h to now. */
  periodEnd?: Date;
}

export interface DailyDigestResult {
  status:        'sent' | 'skipped_already_ran';
  period_start:  string;
  period_end:    string;
  metrics:       Record<string, unknown>;
  summary:       string;
}

/**
 * Run the daily digest. Idempotent: if a digest already exists for this period,
 * does nothing.
 */
export async function runDailyDigest(opts: RunDailyDigestOptions = {}): Promise<DailyDigestResult> {
  const periodEnd   = opts.periodEnd ?? new Date();
  const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);

  const userId = config.USER_ID;

  // Idempotency check
  const existing = await withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ id: string; summary: string }>(
      `SELECT id, summary FROM digest_runs
       WHERE digest_type = 'daily' AND period_start = $1
       LIMIT 1`,
      [periodStart.toISOString()],
    );
    return rows[0] ?? null;
  });

  if (existing) {
    console.log(`[digest] daily digest for period ${periodStart.toISOString()} already exists, skipping`);
    return {
      status:       'skipped_already_ran',
      period_start: periodStart.toISOString(),
      period_end:   periodEnd.toISOString(),
      metrics:      {},
      summary:      existing.summary,
    };
  }

  const data    = await gatherDigestData(userId, periodStart, periodEnd);
  const summary = await summarize(data);

  // Send to Telegram. We don't get message_id back from our minimal sendMessage,
  // so pass null. Could enhance to capture it later.
  await sendMessage(summary, { disablePreview: true });

  await saveDigestRun(userId, periodStart, periodEnd, summary, data, null);

  console.log(`[digest] daily digest sent for ${periodStart.toISOString()}`);

  return {
    status:       'sent',
    period_start: periodStart.toISOString(),
    period_end:   periodEnd.toISOString(),
    metrics: {
      triage_count_total: data.triage_stats.reduce((s, r) => s + r.count, 0),
      urgent_open:        data.urgent_items.length,
      habits_active:      data.habit_progress.length,
    },
    summary,
  };
}
