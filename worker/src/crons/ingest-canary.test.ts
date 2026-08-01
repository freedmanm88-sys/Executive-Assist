/**
 * Tests for the ingestion canary's state machine.
 *
 * `decideCanary` is deliberately pure so the transitions that matter — alert,
 * throttle, re-alert, recover — can be exercised without a database or an
 * 18-hour wait. Run: `npm test` (from worker/).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCanary, STALE_AFTER_HOURS, REALERT_AFTER_HOURS } from './ingest-canary-policy.js';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

// ---- Happy path: pipe is flowing ---------------------------------------------

test('healthy pipe, never alerted → does nothing', () => {
  const d = decideCanary(2, {}, NOW);
  assert.equal(d.action, 'none');
  assert.equal(d.memo, null, 'must not write the memo on a no-op run');
});

test('healthy pipe while alerting → recovers and clears the flag', () => {
  const d = decideCanary(1, { alerting: true, last_alert_at: hoursAgo(30) }, NOW);
  assert.equal(d.action, 'recover');
  assert.equal(d.memo?.alerting, false);
});

// ---- The failure this was built for ------------------------------------------

test('the 2026-05-06 regression: 87 days of silence → alerts', () => {
  const d = decideCanary(87 * 24, {}, NOW);
  assert.equal(d.action, 'alert');
  assert.equal(d.memo?.alerting, true);
  assert.equal(d.memo?.last_alert_at, new Date(NOW).toISOString());
});

test('stale, never alerted → alerts', () => {
  const d = decideCanary(STALE_AFTER_HOURS + 1, {}, NOW);
  assert.equal(d.action, 'alert');
});

// ---- Throttling: one alarm, not one per run ----------------------------------

test('stale and already alerted an hour ago → throttles', () => {
  const d = decideCanary(40, { alerting: true, last_alert_at: hoursAgo(1) }, NOW);
  assert.equal(d.action, 'throttle');
  assert.equal(d.memo, null, 'throttled runs must not rewrite the memo');
});

test('stale and alerted longer ago than the re-alert window → alerts again', () => {
  const d = decideCanary(200, { alerting: true, last_alert_at: hoursAgo(REALERT_AFTER_HOURS + 1) }, NOW);
  assert.equal(d.action, 'alert');
});

// ---- Boundaries ---------------------------------------------------------------

test('exactly at the staleness threshold → alerts (threshold is inclusive)', () => {
  assert.equal(decideCanary(STALE_AFTER_HOURS, {}, NOW).action, 'alert');
});

test('just under the staleness threshold → stays quiet', () => {
  assert.equal(decideCanary(STALE_AFTER_HOURS - 0.01, {}, NOW).action, 'none');
});

test('exactly at the re-alert window → alerts again', () => {
  const d = decideCanary(200, { alerting: true, last_alert_at: hoursAgo(REALERT_AFTER_HOURS) }, NOW);
  assert.equal(d.action, 'alert');
});

// ---- Degenerate memo ----------------------------------------------------------

test('alerting flag set but timestamp missing → alerts rather than silently throttling forever', () => {
  const d = decideCanary(100, { alerting: true }, NOW);
  assert.equal(d.action, 'alert', 'a corrupt memo must never wedge the canary into permanent silence');
});

test('stale with a stale-but-not-alerting memo → alerts', () => {
  const d = decideCanary(100, { alerting: false, last_alert_at: hoursAgo(1) }, NOW);
  assert.equal(d.action, 'alert');
});
