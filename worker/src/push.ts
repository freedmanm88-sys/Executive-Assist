/**
 * Web push for the family app.
 *
 * VAPID keys are generated once on first use and persisted in family_settings
 * (key 'vapid_keys') — no env var needed, so no Railway dashboard access
 * required to roll this out. Subscriptions live in push_subscriptions.
 *
 * Every send is best-effort: push failures must never break the Telegram
 * path or the triage pipeline. Expired subscriptions (404/410) are pruned.
 */

import webpush from 'web-push';
import { pool, withUserContext } from './db.js';

export interface PushPayload {
  title: string;
  body:  string;
  url?:  string;   // path the notification opens in the app, e.g. '/inbox'
  tag?:  string;   // collapse key
}

interface VapidKeys { publicKey: string; privateKey: string }

let vapidCache: VapidKeys | null = null;

export async function getVapidKeys(): Promise<VapidKeys> {
  if (vapidCache) return vapidCache;

  const { rows } = await pool.query<{ value: VapidKeys }>(
    `SELECT value FROM family_settings WHERE key = 'vapid_keys'`,
  );
  if (rows[0]?.value?.publicKey) {
    vapidCache = rows[0].value;
    return vapidCache;
  }

  const generated = webpush.generateVAPIDKeys();
  // ON CONFLICT DO NOTHING + re-read guards against a concurrent first call.
  await pool.query(
    `INSERT INTO family_settings (key, value) VALUES ('vapid_keys', $1)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(generated)],
  );
  const reread = await pool.query<{ value: VapidKeys }>(
    `SELECT value FROM family_settings WHERE key = 'vapid_keys'`,
  );
  vapidCache = reread.rows[0]?.value ?? generated;
  return vapidCache;
}

interface SubRow {
  id:       string;
  endpoint: string;
  keys:     { p256dh: string; auth: string };
}

/** Send a push to every device the user has subscribed. Best-effort. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  try {
    const vapid = await getVapidKeys();
    webpush.setVapidDetails('mailto:mark@sophaxconsulting.com', vapid.publicKey, vapid.privateKey);

    const subs = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<SubRow>(
        `SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = $1::uuid`,
        [userId],
      );
      return rows;
    });
    if (subs.length === 0) return 0;

    let sent = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload),
          { TTL: 3600 },
        );
        sent++;
        await withUserContext(userId, (client) =>
          client.query(`UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1::uuid`, [sub.id]),
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await withUserContext(userId, (client) =>
            client.query(`DELETE FROM push_subscriptions WHERE id = $1::uuid`, [sub.id]),
          );
          console.log(`[push] pruned expired subscription for user ${userId}`);
        } else {
          console.error('[push] send failed:', err);
        }
      }
    }
    return sent;
  } catch (err) {
    console.error('[push] sendPushToUser failed (non-fatal):', err);
    return 0;
  }
}
