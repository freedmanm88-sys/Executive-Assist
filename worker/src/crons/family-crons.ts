/**
 * Family app notification crons (push-first — both members, not just Mark):
 *
 * - Morning reminder  (9:00)  — tasks due today/overdue for you (or anyone's)
 * - Evening habit nudge (20:00) — your habits still unchecked today
 * - Weekly summary (Sun 18:00) — Claude-written recap of the family's week
 *
 * All best-effort; a user with no push subscriptions just gets nothing.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { pool, withUserContext } from '../db.js';
import { sendPushToUser } from '../push.js';
import { anthropic, DEFAULT_MODEL } from '../claude.js';

interface Member { id: string; name: string }

async function getMembers(): Promise<Member[]> {
  const { rows } = await pool.query<{ id: string; full_name: string | null; email: string }>(
    `SELECT id, full_name, email FROM users WHERE deleted_at IS NULL ORDER BY created_at`,
  );
  return rows.map((r) => ({ id: r.id, name: r.full_name ?? r.email.split('@')[0] ?? '?' }));
}

// ---------- Morning reminder -------------------------------------------------

export async function runMorningReminder(): Promise<{ notified: number }> {
  const members = await getMembers();
  let notified = 0;

  for (const m of members) {
    const rows = await withUserContext(m.id, async (client) => {
      const { rows } = await client.query<{ title: string; overdue: boolean }>(
        `SELECT title,
                (due_at AT TIME ZONE 'America/Toronto')::date < (NOW() AT TIME ZONE 'America/Toronto')::date AS overdue
         FROM family_tasks
         WHERE status = 'open'
           AND due_at IS NOT NULL
           AND (due_at AT TIME ZONE 'America/Toronto')::date <= (NOW() AT TIME ZONE 'America/Toronto')::date
           AND (assigned_to = $1::uuid OR assigned_to IS NULL)
         ORDER BY due_at
         LIMIT 6`,
        [m.id],
      );
      return rows;
    });
    if (rows.length === 0) continue;

    const overdueCount = rows.filter((r) => r.overdue).length;
    const sent = await sendPushToUser(m.id, {
      title: overdueCount > 0
        ? `${rows.length} task${rows.length === 1 ? '' : 's'} need attention (${overdueCount} overdue)`
        : `${rows.length} task${rows.length === 1 ? '' : 's'} due today`,
      body: rows.map((r) => r.title).join(' · '),
      url: '/tasks',
      tag: 'morning-tasks',
    });
    if (sent > 0) notified++;
  }
  console.log(`[cron:morning-reminder] notified=${notified}`);
  return { notified };
}

// ---------- Evening habit nudge ----------------------------------------------

export async function runHabitNudge(): Promise<{ notified: number }> {
  const members = await getMembers();
  let notified = 0;

  for (const m of members) {
    const rows = await withUserContext(m.id, async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `SELECT h.name FROM habits h
         WHERE h.user_id = $1::uuid AND h.active
           AND NOT EXISTS (
             SELECT 1 FROM habit_logs l
             WHERE l.habit_id = h.id
               AND (l.completed_at AT TIME ZONE 'America/Toronto')::date
                   = (NOW() AT TIME ZONE 'America/Toronto')::date
           )
         ORDER BY h.created_at`,
        [m.id],
      );
      return rows;
    });
    if (rows.length === 0) continue;

    const sent = await sendPushToUser(m.id, {
      title: 'Habit check-in',
      body: `Still open today: ${rows.map((r) => r.name).join(', ')}`,
      url: '/habits',
      tag: 'habit-nudge',
    });
    if (sent > 0) notified++;
  }
  console.log(`[cron:habit-nudge] notified=${notified}`);
  return { notified };
}

// ---------- Weekly summary ---------------------------------------------------

export async function runWeeklySummary(): Promise<{ notified: number; summary: string }> {
  const members = await getMembers();
  const anyId = members[0]?.id;
  if (!anyId) return { notified: 0, summary: '' };

  const data = await withUserContext(anyId, async (client) => {
    const done = await client.query(
      `SELECT COALESCE(u.full_name, 'someone') AS name, COUNT(*)::int AS count
       FROM family_tasks t LEFT JOIN users u ON u.id = t.completed_by
       WHERE t.status = 'done' AND t.completed_at > NOW() - INTERVAL '7 days'
       GROUP BY 1`,
    );
    const habits = await client.query(
      `SELECT COALESCE(u.full_name, '?') AS name, h.name AS habit, COUNT(l.id)::int AS count, h.target_per_week
       FROM habits h
       JOIN users u ON u.id = h.user_id
       LEFT JOIN habit_logs l ON l.habit_id = h.id AND l.completed_at > NOW() - INTERVAL '7 days'
       WHERE h.active AND h.shared
       GROUP BY 1, 2, h.target_per_week ORDER BY 1, 2`,
    );
    const upcoming = await client.query(
      `SELECT title, to_char(start_at AT TIME ZONE 'America/Toronto', 'Dy FMHH12:MI am') AS when_str
       FROM family_events
       WHERE start_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
       ORDER BY start_at LIMIT 10`,
    );
    const openTasks = await client.query(
      `SELECT COUNT(*)::int AS count FROM family_tasks WHERE status = 'open'`,
    );
    return {
      done: done.rows, habits: habits.rows, upcoming: upcoming.rows,
      openCount: openTasks.rows[0]?.count ?? 0,
    };
  });

  const prompt = [
    'Write a short, warm weekly summary for a family organizer app used by Mark and Ashley.',
    'Max 60 words, plain text, no markdown headings. Mention wins first, then what is coming up.',
    '',
    `Tasks completed this week: ${JSON.stringify(data.done)}`,
    `Habit check-ins this week (vs weekly target): ${JSON.stringify(data.habits)}`,
    `Upcoming family events next 7 days: ${JSON.stringify(data.upcoming)}`,
    `Open tasks: ${data.openCount}`,
  ].join('\n');

  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text).join(' ').trim();

  let notified = 0;
  for (const m of members) {
    const sent = await sendPushToUser(m.id, {
      title: 'Your week at HQ',
      body: summary,
      url: '/',
      tag: 'weekly-summary',
    });
    if (sent > 0) notified++;
  }
  console.log(`[cron:weekly-summary] notified=${notified}`);
  return { notified, summary };
}
