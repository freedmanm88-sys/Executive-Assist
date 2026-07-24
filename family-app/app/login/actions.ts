'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSessionValue, SESSION_COOKIE } from '@/lib/session';
import { getUsers, workerFetch } from '@/lib/worker';
import { timingSafeEqual } from 'node:crypto';

/**
 * Login identity → PIN env var + the DB emails that identity may appear under.
 * (Mark's users row is mark@sophaxconsulting.com; his Gmail is freedman.m88.)
 * Change PINs in Vercel env settings.
 */
const IDENTITIES: Record<string, { env: string; fallback: string; dbEmails: string[] }> = {
  'freedman.m88@gmail.com': {
    env: 'MARK_PIN', fallback: '1111',
    dbEmails: ['freedman.m88@gmail.com', 'mark@sophaxconsulting.com'],
  },
  'awronzberg@gmail.com': {
    env: 'ASHLEY_PIN', fallback: '2222',
    dbEmails: ['awronzberg@gmail.com'],
  },
};

function pinMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function login(
  _prev: { error: string } | null,
  formData: FormData,
): Promise<{ error: string } | null> {
  const email = String(formData.get('email') ?? '');
  const pin = String(formData.get('pin') ?? '');

  const identity = IDENTITIES[email];
  if (!identity) return { error: 'Unknown user.' };

  const users = await getUsers();
  const user = users.find((u) => identity.dbEmails.includes(u.email.toLowerCase()));
  if (!user) return { error: 'User not found in the database yet — run the migration first.' };

  // Prefer the user-set PIN (hashed, stored via the app's Settings page);
  // fall back to the env-var PIN until one has been set.
  const { result } = await workerFetch<{ result: 'ok' | 'wrong' | 'no_pin_set' }>(
    '/family/pin/verify',
    { method: 'POST', userId: user.id, body: { pin } },
  );
  if (result === 'wrong') return { error: 'Wrong PIN.' };
  if (result === 'no_pin_set') {
    const expected = process.env[identity.env] ?? identity.fallback;
    if (!pinMatches(expected, pin)) return { error: 'Wrong PIN.' };
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, await createSessionValue(user.id, user.name), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 90 * 86400,
    path: '/',
  });
  redirect('/');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}
