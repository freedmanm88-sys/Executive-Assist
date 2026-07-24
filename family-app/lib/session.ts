/**
 * Signed-cookie sessions using Web Crypto (works in both middleware and
 * server runtimes). Payload: { uid, name, exp }. No PII beyond first name.
 */

const COOKIE_NAME = 'fam_session';
const SESSION_DAYS = 90;

export interface Session {
  uid: string;
  name: string;
  exp: number; // unix seconds
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error('AUTH_SECRET env var missing or too short');
  return s;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function createSessionValue(uid: string, name: string): Promise<string> {
  const payload: Session = {
    uid,
    name,
    exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400,
  };
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${b64url(sig)}`;
}

export async function verifySessionValue(value: string | undefined): Promise<Session | null> {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const payloadB64 = value.slice(0, dot);
  const sigB64 = value.slice(dot + 1);
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(),
      b64urlDecode(sigB64) as unknown as ArrayBuffer,
      new TextEncoder().encode(payloadB64),
    );
    if (!ok) return null;
    const session = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as Session;
    if (typeof session.uid !== 'string' || session.exp < Date.now() / 1000) return null;
    return session;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = COOKIE_NAME;
