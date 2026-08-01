/**
 * Ingestion-canary policy — when to alarm, when to shut up, when to say it's fixed.
 *
 * Deliberately dependency-free: no db, no config, no Telegram. That keeps the
 * decision logic testable without a database, a bot token, or an 18-hour wait,
 * and keeps `ingest-canary.ts` to just the IO around it.
 */

/**
 * Hours of total silence before the pipe is considered broken. Normal volume is
 * ~100 emails/day across the three accounts, so 18h of nothing is unambiguous
 * while still spanning a quiet overnight without crying wolf.
 */
export const STALE_AFTER_HOURS = 18;

/** While the pipe stays down, don't repeat the alert more often than this. */
export const REALERT_AFTER_HOURS = 24;

export interface CanaryMemo {
  alerting?:      boolean;
  last_alert_at?: string | null;
}

export type CanaryAction = 'none' | 'alert' | 'throttle' | 'recover';

export interface CanaryDecision {
  action: CanaryAction;
  /** Memo to persist, or null when nothing changed. */
  memo:   CanaryMemo | null;
}

/**
 * Decide what the canary should do this run.
 *
 * @param hoursSilent  Hours since the most recent triaged email.
 * @param memo         Persisted canary state from the previous run.
 * @param nowMs        Current time in epoch ms (injected so tests are deterministic).
 */
export function decideCanary(hoursSilent: number, memo: CanaryMemo, nowMs: number): CanaryDecision {
  if (hoursSilent < STALE_AFTER_HOURS) {
    // Only announce recovery if we'd actually raised an alarm.
    return memo.alerting
      ? { action: 'recover', memo: { alerting: false, last_alert_at: memo.last_alert_at ?? null } }
      : { action: 'none', memo: null };
  }

  // A missing timestamp yields Infinity, which alerts rather than throttling —
  // a corrupt memo must never wedge the canary into permanent silence.
  const hoursSinceAlert = memo.last_alert_at
    ? (nowMs - Date.parse(memo.last_alert_at)) / 3_600_000
    : Infinity;

  if (memo.alerting && hoursSinceAlert < REALERT_AFTER_HOURS) {
    return { action: 'throttle', memo: null };
  }

  return {
    action: 'alert',
    memo:   { alerting: true, last_alert_at: new Date(nowMs).toISOString() },
  };
}
