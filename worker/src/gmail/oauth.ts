/**
 * Google OAuth for Gmail — replaces n8n's credential vault.
 *
 * Flow: app Settings → "Connect" → server action asks the worker for an auth
 * URL (signed state) → browser goes to Google → Google redirects to
 * /oauth/google/callback on the worker → tokens encrypted into
 * user_credentials → browser bounced back to the app.
 *
 * The OAuth client id/secret live in family_settings under the server-only
 * key 'google_oauth_client' (seeded once via POST /admin/google-client), so
 * rolling this out needs no Railway env changes.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool, withUserContext } from '../db.js';
import { config } from '../config.js';
import { encryptJson, decryptJson } from './crypto.js';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const STATE_TTL_MS = 15 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;

export interface GoogleClientConfig {
  client_id:     string;
  client_secret: string;
  redirect_uri:  string;   // https://<worker>/oauth/google/callback
  app_url:       string;   // where to send the browser afterwards
}

interface StoredTokens {
  refresh_token: string;
  access_token:  string;
  expires_at:    number;   // epoch ms
  scope?:        string;
}

export class GmailAuthError extends Error {
  constructor(public code: 'not_connected' | 'reauth_required' | 'client_not_configured', msg?: string) {
    super(msg ?? code);
  }
}

// ---------- Client config ----------------------------------------------------

let clientCache: { cfg: GoogleClientConfig; at: number } | null = null;

export async function getGoogleClient(): Promise<GoogleClientConfig> {
  if (clientCache && Date.now() - clientCache.at < 5 * 60 * 1000) return clientCache.cfg;
  const { rows } = await pool.query<{ value: GoogleClientConfig }>(
    `SELECT value FROM family_settings WHERE key = 'google_oauth_client'`,
  );
  const cfg = rows[0]?.value;
  if (!cfg?.client_id || !cfg.client_secret || !cfg.redirect_uri) {
    throw new GmailAuthError('client_not_configured', 'google_oauth_client setting missing');
  }
  clientCache = { cfg, at: Date.now() };
  return cfg;
}

export async function setGoogleClient(cfg: GoogleClientConfig): Promise<void> {
  await pool.query(
    `INSERT INTO family_settings (key, value, updated_at) VALUES ('google_oauth_client', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(cfg)],
  );
  clientCache = null;
}

// ---------- Signed state -----------------------------------------------------

interface StatePayload { userId: string; label: string; ts: number }

function sign(data: string): string {
  return createHmac('sha256', config.INTERNAL_AUTH_TOKEN).update(data).digest('base64url');
}

export function makeState(userId: string, label: string): string {
  const payload = Buffer.from(JSON.stringify({ userId, label, ts: Date.now() } satisfies StatePayload)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyState(state: string): StatePayload | null {
  const dot = state.indexOf('.');
  if (dot < 0) return null;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as StatePayload;
    if (Date.now() - parsed.ts > STATE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------- Auth URL + code exchange ----------------------------------------

export async function buildAuthUrl(userId: string, label: string, loginHint?: string): Promise<string> {
  const cfg = await getGoogleClient();
  const params = new URLSearchParams({
    client_id:     cfg.client_id,
    redirect_uri:  cfg.redirect_uri,
    response_type: 'code',
    scope:         GMAIL_SCOPES.join(' '),
    access_type:   'offline',
    prompt:        'consent',          // force a refresh_token every time
    include_granted_scopes: 'true',
    state:         makeState(userId, label),
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token:  string;
  expires_in:    number;
  refresh_token?: string;
  scope?:        string;
  error?:        string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const cfg = await getGoogleClient();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, ...body }).toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) {
    const err = new Error(`google token error: ${json.error ?? res.status} ${json.error_description ?? ''}`);
    (err as Error & { googleError?: string }).googleError = json.error;
    throw err;
  }
  return json;
}

export async function exchangeCodeAndStore(userId: string, label: string, code: string): Promise<void> {
  const cfg = await getGoogleClient();
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: cfg.redirect_uri });
  if (!t.refresh_token) throw new Error('google did not return a refresh_token (revoke app access and reconnect)');
  await storeTokens(userId, label, {
    refresh_token: t.refresh_token,
    access_token:  t.access_token,
    expires_at:    Date.now() + t.expires_in * 1000,
    ...(t.scope ? { scope: t.scope } : {}),
  });
}

async function storeTokens(userId: string, label: string, tokens: StoredTokens): Promise<void> {
  await withUserContext(userId, (client) =>
    client.query(
      `UPDATE user_credentials
       SET oauth_payload = $1,
           expires_at    = to_timestamp($2 / 1000.0),
           extra         = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('managed_by', 'worker', 'connected_at', NOW(), 'error', NULL)
       WHERE user_id = $3::uuid AND service = 'gmail' AND label = $4`,
      [JSON.stringify({ enc: encryptJson(tokens) }), tokens.expires_at, userId, label],
    ),
  );
}

async function markError(userId: string, label: string, error: string): Promise<void> {
  await withUserContext(userId, (client) =>
    client.query(
      `UPDATE user_credentials
       SET extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('error', $1::text, 'error_at', NOW())
       WHERE user_id = $2::uuid AND service = 'gmail' AND label = $3`,
      [error, userId, label],
    ),
  );
}

// ---------- Access tokens (with refresh) ------------------------------------

const accessCache = new Map<string, { token: string; expires_at: number }>();

export async function getAccessToken(userId: string, label: string): Promise<string> {
  const cacheKey = `${userId}:${label}`;
  const hit = accessCache.get(cacheKey);
  if (hit && hit.expires_at - Date.now() > REFRESH_SKEW_MS) return hit.token;

  const row = await withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ oauth_payload: { enc?: string } }>(
      `SELECT oauth_payload FROM user_credentials WHERE user_id = $1::uuid AND service = 'gmail' AND label = $2`,
      [userId, label],
    );
    return rows[0] ?? null;
  });
  if (!row?.oauth_payload?.enc) throw new GmailAuthError('not_connected', `gmail ${label} not connected`);

  const stored = decryptJson<StoredTokens>(row.oauth_payload.enc);
  if (stored.expires_at - Date.now() > REFRESH_SKEW_MS) {
    accessCache.set(cacheKey, { token: stored.access_token, expires_at: stored.expires_at });
    return stored.access_token;
  }

  try {
    const t = await tokenRequest({ refresh_token: stored.refresh_token, grant_type: 'refresh_token' });
    const next: StoredTokens = {
      ...stored,
      access_token: t.access_token,
      expires_at:   Date.now() + t.expires_in * 1000,
    };
    await storeTokens(userId, label, next);
    accessCache.set(cacheKey, { token: next.access_token, expires_at: next.expires_at });
    return next.access_token;
  } catch (err) {
    const g = (err as Error & { googleError?: string }).googleError;
    if (g === 'invalid_grant') {
      await markError(userId, label, 'invalid_grant — reconnect required (token revoked or expired)');
      accessCache.delete(cacheKey);
      throw new GmailAuthError('reauth_required', `gmail ${label} needs re-authorization`);
    }
    throw err;
  }
}

// ---------- Status for the app ----------------------------------------------

export interface GmailAccountStatus {
  label:          string;
  address:        string;
  active:         boolean;
  connected:      boolean;
  managed_by:     string | null;
  error:          string | null;
  last_synced_at: string | null;
}

export async function listAccountStatus(userId: string): Promise<GmailAccountStatus[]> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<GmailAccountStatus>(
      `SELECT ga.label, ga.address, ga.active,
              (uc.oauth_payload ? 'enc')          AS connected,
              uc.extra->>'managed_by'             AS managed_by,
              uc.extra->>'error'                  AS error,
              ga.last_synced_at
       FROM gmail_accounts ga
       JOIN user_credentials uc ON uc.id = ga.credential_id
       WHERE ga.user_id = $1::uuid
       ORDER BY ga.label`,
      [userId],
    );
    return rows;
  });
}
