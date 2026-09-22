/**
 * Gmail sync — polls each connected Gmail account and feeds new messages to
 * the triage pipeline. Replaces n8n's W3a/b/c Gmail Trigger workflows (ADR 0005).
 *
 * - Every 2 minutes (crons/index.ts); manual: POST /cron/gmail-sync
 * - Query: `in:inbox after:<last_synced - 10 min>`; idempotency is the
 *   (user_id, gmail_message_id) unique index, so overlap is harmless
 * - First run on a freshly connected account starts 1 hour back, not at the
 *   beginning of time
 * - Per-account failures are isolated and recorded on the credential row
 *   (`extra.error`), so one dead account never blocks the others
 *
 * Compliance: business2 (Stonefield) may carry borrower PII. Its message body
 * is NOT passed to Claude — headers + snippet only — until a ZDR agreement is
 * in place. See ADR 0005.
 */

import { withUserContext } from '../db.js';
import { config } from '../config.js';
import { getAccessToken, GmailAuthError } from '../gmail/oauth.js';
import { listMessageIds, getMessage } from '../gmail/api.js';
import { processGmailMessage, type GmailAccountLabel } from '../handlers/gmail-event.js';

/** Accounts whose message body may be sent to Claude. */
export const BODY_ALLOWED_ACCOUNTS: readonly GmailAccountLabel[] = ['personal', 'business1'];

const OVERLAP_MS = 10 * 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 60 * 60 * 1000;
const MAX_PER_RUN = 50;

interface AccountRow {
  id:             string;
  label:          GmailAccountLabel;
  address:        string;
  last_synced_at: Date | null;
  connected:      boolean;
}

export interface SyncResult {
  accounts: { label: string; fetched: number; triaged: number; skipped: number; error: string | null }[];
}

export async function runGmailSync(): Promise<SyncResult> {
  const userId = config.USER_ID;

  const accounts = await withUserContext(userId, async (client) => {
    const { rows } = await client.query<AccountRow>(
      `SELECT ga.id, ga.label, ga.address, ga.last_synced_at,
              (uc.oauth_payload ? 'enc') AS connected
       FROM gmail_accounts ga
       JOIN user_credentials uc ON uc.id = ga.credential_id
       WHERE ga.user_id = $1::uuid AND ga.active
       ORDER BY ga.label`,
      [userId],
    );
    return rows;
  });

  const result: SyncResult = { accounts: [] };

  for (const acct of accounts) {
    if (!acct.connected) {
      result.accounts.push({ label: acct.label, fetched: 0, triaged: 0, skipped: 0, error: 'not_connected' });
      continue;
    }
    const entry = { label: acct.label, fetched: 0, triaged: 0, skipped: 0, error: null as string | null };
    const syncStartedAt = new Date();
    try {
      const token = await getAccessToken(userId, acct.label);
      const since = acct.last_synced_at
        ? acct.last_synced_at.getTime() - OVERLAP_MS
        : Date.now() - FIRST_RUN_LOOKBACK_MS;
      const q = `in:inbox after:${Math.floor(since / 1000)}`;
      const ids = await listMessageIds(token, q, MAX_PER_RUN);
      entry.fetched = ids.length;

      // Oldest first so triage order matches arrival order.
      for (const { id } of [...ids].reverse()) {
        const message = await getMessage(token, id);
        const r = await processGmailMessage(acct.label, message, {
          bodyAllowed: BODY_ALLOWED_ACCOUNTS.includes(acct.label),
        });
        if (r.status === 'triaged') entry.triaged++; else entry.skipped++;
      }

      await withUserContext(userId, (client) =>
        client.query(`UPDATE gmail_accounts SET last_synced_at = $1 WHERE id = $2::uuid`, [syncStartedAt, acct.id]),
      );
    } catch (err) {
      entry.error = err instanceof GmailAuthError ? err.code : (err as Error).message.slice(0, 200);
      console.error(`[gmail-sync] ${acct.label} failed:`, err);
      if (!(err instanceof GmailAuthError)) {
        await withUserContext(userId, (client) =>
          client.query(
            `UPDATE user_credentials SET extra = COALESCE(extra,'{}'::jsonb) || jsonb_build_object('error', $1::text, 'error_at', NOW())
             WHERE user_id = $2::uuid AND service = 'gmail' AND label = $3`,
            [entry.error, userId, acct.label],
          ),
        );
      }
    }
    result.accounts.push(entry);
  }

  const totals = result.accounts.reduce((a, r) => ({ f: a.f + r.fetched, t: a.t + r.triaged }), { f: 0, t: 0 });
  if (totals.f > 0) console.log(`[gmail-sync] fetched=${totals.f} triaged=${totals.t}`);
  return result;
}
