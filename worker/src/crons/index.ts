/**
 * Cron scheduler. Registers all in-process cron jobs at boot.
 *
 * Each job uses node-cron with America/Toronto timezone. node-cron handles DST.
 * Jobs run on the worker process — there's only one replica in Phase 1, so no
 * leader election needed.
 */

import cron from 'node-cron';
import { runDailyDigest } from './daily-digest.js';
import { runUrgentNag } from './urgent-nag.js';
import { runMorningReminder, runHabitNudge, runWeeklySummary } from './family-crons.js';
import { runDistillation } from './distillation.js';

export function registerCrons(): void {
  // Daily digest at 8:00 AM Toronto, every day
  cron.schedule(
    '0 8 * * *',
    async () => {
      try {
        await runDailyDigest();
      } catch (err) {
        console.error('[cron:daily-digest] failed:', err);
      }
    },
    { timezone: 'America/Toronto' },
  );

  // Urgent nag — re-ping unacknowledged urgent emails. 4-hour spacing avoids
  // pestering (open decision #1 from 2026-05-04 checkpoint: start with 10/14/18).
  cron.schedule(
    '0 10,14,18 * * *',
    async () => {
      try {
        await runUrgentNag();
      } catch (err) {
        console.error('[cron:urgent-nag] failed:', err);
      }
    },
    { timezone: 'America/Toronto' },
  );

  // Family app pushes: morning tasks, evening habit nudge, Sunday weekly summary
  const jobs: [string, string, () => Promise<unknown>][] = [
    ['morning-reminder', '0 9 * * *',  runMorningReminder],
    ['habit-nudge',      '0 20 * * *', runHabitNudge],
    ['weekly-summary',   '0 18 * * 0', runWeeklySummary],
    ['distillation',     '0 21 * * 0', runDistillation],
  ];
  for (const [name, pattern, fn] of jobs) {
    cron.schedule(
      pattern,
      async () => {
        try {
          await fn();
        } catch (err) {
          console.error(`[cron:${name}] failed:`, err);
        }
      },
      { timezone: 'America/Toronto' },
    );
  }

  console.log('[cron] registered: daily-digest @8, urgent-nag @10/14/18, morning @9, nudge @20, weekly Sun@18 (America/Toronto)');
}
