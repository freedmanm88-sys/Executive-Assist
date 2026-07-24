/**
 * Server-side client for the Executive-Assist worker's /family API.
 * The shared secret stays server-side — never import this from client code.
 */

import 'server-only';

const WORKER_URL = process.env.WORKER_URL ?? '';
const WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN ?? '';

if (!WORKER_URL || !WORKER_AUTH_TOKEN) {
  throw new Error('WORKER_URL / WORKER_AUTH_TOKEN env vars are required');
}

export class WorkerError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`worker ${status}: ${JSON.stringify(body)}`);
  }
}

export async function workerFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown; userId?: string } = {},
): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'X-Internal-Auth': WORKER_AUTH_TOKEN,
      ...(opts.userId ? { 'X-Family-User': opts.userId } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new WorkerError(res.status, json);
  return json as T;
}

export interface FamilyUser {
  id: string;
  email: string;
  name: string;
}

let userCache: { users: FamilyUser[]; at: number } | null = null;

/** Directory of family members (cached 5 min; pre-auth safe). */
export async function getUsers(): Promise<FamilyUser[]> {
  if (userCache && Date.now() - userCache.at < 5 * 60 * 1000) return userCache.users;
  const { users } = await workerFetch<{ users: FamilyUser[] }>('/family/users');
  userCache = { users, at: Date.now() };
  return users;
}
