import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifySessionValue, SESSION_COOKIE, type Session } from './session';

/** Current session or redirect to /login. Use at the top of every page. */
export async function requireSession(): Promise<Session> {
  const jar = await cookies();
  const session = await verifySessionValue(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');
  return session;
}
