/**
 * At-rest encryption for OAuth tokens stored in user_credentials.oauth_payload.
 *
 * Key is derived (HKDF) from INTERNAL_AUTH_TOKEN, which already lives only in
 * Railway's env — so the DB alone cannot yield usable Google tokens. A
 * dedicated CREDENTIALS_KEY env var takes precedence when present (rotate by
 * setting it and re-connecting accounts). AES-256-GCM, random IV per write.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env['CREDENTIALS_KEY'] ?? config.INTERNAL_AUTH_TOKEN;
  cachedKey = Buffer.from(hkdfSync('sha256', secret, 'executive-assist', 'gmail-credentials-v1', 32));
  return cachedKey;
}

/** JSON → base64( iv | tag | ciphertext ). */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptJson<T>(blob: string): T {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}
