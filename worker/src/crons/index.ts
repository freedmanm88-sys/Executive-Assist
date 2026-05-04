/**
 * Cron scheduler. Registers all in-process cron jobs at boot.
 *
 * Each job uses node-cron with America/Toronto timezone. node-cron handles DST.
 * Jobs run on the worker process — there's only one replica in Phase 1, so no
 * leader election needed.
 */

import cron from 'node-cron';
import { runDailyDigest } from './daily-digest.js';

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

  console.log('[cron] registered: daily-digest @ 0 8 * * * America/Toronto');
}
