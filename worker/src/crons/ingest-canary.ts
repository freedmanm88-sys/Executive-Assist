/**
 * Ingestion canary — alerts when the Gmail → n8n → worker pipe goes silent.
 *
 * Why this exists: email ingestion stopped on 2026-05-06 and nobody noticed for
 * 87 days. The W99 error alerter only fires on n8n *errors* — an expired OAuth
 * credential that simply stops yielding messages, or a workflow toggled
 * inactive, is completely silent. Nothing in the system could tell the
 * difference between "no email arrived" and "email can no longer arrive".
 * See docs/decisions/0003-ingestion-staleness-canary.md.
 *
 * Runs 09:00 and 17:00 Toronto. Alerts once when the pipe goes stale, then
 * stays quiet (re-alerting at most daily) until it recovers — recovery sends
 * its own ping so a fix is visibly confirmed rather than assumed.
 */

import { pool, withUserContext } from '../db.js';
import { sendMessage } from '../telegram.js';
import { sendPushToUser } from '../push.js';
import { config } from '../config.js';
import { decideCanary, type CanaryMemo } from './ingest-canary-policy.js';

/** Settings key holding the canary's own state. Server-only, never sent to the app. */
const MEMO_KEY = 'ingest_canary';

export type CanaryState = 'ok' | 'alerted' | 'throttled' | 'recovered' | 'no_data';

export interface CanaryResult {
  state:         CanaryState;
  last_email_at: string | null;
  hours_silent:  number | null;
}

export async function runIngestCanary(): Promise<CanaryResult> {
  const userId = config.USER_ID; // Phase 1: single email-triage user

  const lastAt = await withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ last_at: Date | null }>(
      `SELECT MAX(processed_at) AS last_at FROM email_triage_log`,
    );
    return rows[0]?.last_at ?? null;
  });

  // A brand-new install has no baseline to judge against — stay quiet.
  if (!lastAt) {
    console.log('[cron:ingest-canary] no triage rows yet — nothing to compare against');
    return { state: 'no_data', last_email_at: null, hours_silent: null };
  }

  const now = Date.now();
  const hoursSilent = (now - lastAt.getTime()) / 3_600_000;
  const result = (state: CanaryState): CanaryResult => ({
    state,
    last_email_at: lastAt.toISOString(),
    hours_silent:  Math.round(hoursSilent * 10) / 10,
  });

  const decision = decideCanary(hoursSilent, await readMemo(), now);

  if (decision.action === 'none') return result('ok');

  if (decision.action === 'throttle') {
    console.log(`[cron:ingest-canary] still stale (${hoursSilent.toFixed(1)}h) — alert throttled`);
    return result('throttled');
  }

  // ---- Recovered -------------------------------------------------------------
  if (decision.action === 'recover') {
    await sendMessage(
      `✅ *Email ingestion recovered* — triage is flowing again (last email ${formatSpan(hoursSilent)} ago).`,
      { parseMode: 'Markdown', disablePreview: true },
    );
    await sendPushToUser(userId, {
      title: 'Email ingestion recovered',
      body:  'Triage is flowing again.',
      url:   '/inbox',
      tag:   'ingest-canary',
    });
    // Persist only after the notice actually went out — a failed send should
    // leave the alerting flag set so the next run retries rather than going
    // silently quiet. Same ordering as the alert branch below.
    if (decision.memo) await writeMemo(decision.memo);
    console.log('[cron:ingest-canary] recovered');
    return result('recovered');
  }

  // ---- Stale -----------------------------------------------------------------
  const lines = [
    '🚨 *Email ingestion looks dead.*',
    `Nothing triaged in *${formatSpan(hoursSilent)}* — last email ${formatUtc(lastAt)} UTC.`,
    '',
    'Most likely the Gmail OAuth credential in n8n expired, or the triage workflow was switched off.',
    'Check that `03a - Email Triage (Personal)` is Active, then re-authorize the Gmail credential.',
  ];

  await sendMessage(lines.join('\n'), { parseMode: 'Markdown', disablePreview: true });
  await sendPushToUser(userId, {
    title: 'Email ingestion looks dead',
    body:  `Nothing triaged in ${formatSpan(hoursSilent)}. Check the n8n Gmail credential.`,
    url:   '/inbox',
    tag:   'ingest-canary',
  });
  if (decision.memo) await writeMemo(decision.memo);

  console.warn(`[cron:ingest-canary] ALERT — silent for ${hoursSilent.toFixed(1)}h`);
  return result('alerted');
}

// ---------- Memo helpers ------------------------------------------------------
// family_settings is shared-readable, so these use the pool directly (same
// pattern as push.ts reading the VAPID keys).

async function readMemo(): Promise<CanaryMemo> {
  const { rows } = await pool.query<{ value: CanaryMemo }>(
    `SELECT value FROM family_settings WHERE key = $1`,
    [MEMO_KEY],
  );
  return rows[0]?.value ?? {};
}

async function writeMemo(memo: CanaryMemo): Promise<void> {
  await pool.query(
    `INSERT INTO family_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [MEMO_KEY, JSON.stringify(memo)],
  );
}

// ---------- Formatting --------------------------------------------------------

/** Hours → a span a human reads at a glance ("20h", "87 days"). */
function formatSpan(hours: number): string {
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)} days`;
}

/** Date → "2026-05-06 20:55" (no seconds, no timezone suffix). */
function formatUtc(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
