/**
 * Google OAuth callback (public — Google's browser redirect lands here) and
 * the admin endpoint that seeds the OAuth client config.
 *
 * GET  /oauth/google/callback?code&state   → store tokens, bounce to the app
 * POST /admin/google-client                → { client_id, client_secret, redirect_uri, app_url }
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { verifyState, exchangeCodeAndStore, setGoogleClient, getGoogleClient } from '../gmail/oauth.js';

export async function googleOauthCallback(req: Request, res: Response): Promise<void> {
  const code = typeof req.query['code'] === 'string' ? req.query['code'] : null;
  const state = typeof req.query['state'] === 'string' ? req.query['state'] : null;
  const gerr = typeof req.query['error'] === 'string' ? req.query['error'] : null;

  let appUrl = '/';
  try { appUrl = (await getGoogleClient()).app_url; } catch { /* fall through to relative */ }

  const bounce = (params: Record<string, string>): void => {
    const u = new URL('/settings', appUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    res.redirect(302, u.toString());
  };

  if (gerr) { bounce({ gmail: 'error', reason: gerr }); return; }
  if (!code || !state) { bounce({ gmail: 'error', reason: 'missing_code_or_state' }); return; }

  const st = verifyState(state);
  if (!st) { bounce({ gmail: 'error', reason: 'bad_state' }); return; }

  try {
    await exchangeCodeAndStore(st.userId, st.label, code);
    bounce({ gmail: 'connected', account: st.label });
  } catch (err) {
    console.error('[oauth] exchange failed:', err);
    bounce({ gmail: 'error', reason: 'exchange_failed' });
  }
}

const ClientSchema = z.object({
  client_id:     z.string().min(10),
  client_secret: z.string().min(10),
  redirect_uri:  z.string().url(),
  app_url:       z.string().url(),
});

export async function setGoogleClientHandler(req: Request, res: Response): Promise<void> {
  const cfg = ClientSchema.parse(req.body);
  await setGoogleClient(cfg);
  res.json({ configured: true, redirect_uri: cfg.redirect_uri });
}
