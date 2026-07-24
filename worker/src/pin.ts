/**
 * PIN storage for the family app. Hashes live in family_settings under
 * 'pin_hash:<user_id>' as { salt, hash } (scrypt, hex). If a user has no
 * stored hash yet, the app falls back to its env-var PIN — so first
 * change-PIN writes the hash and the env value stops mattering.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { withUserContext } from './db.js';

interface StoredPin { salt: string; hash: string }

const SCRYPT_KEYLEN = 32;

function hashPin(pin: string, salt: Buffer): Buffer {
  return scryptSync(pin.normalize(), salt, SCRYPT_KEYLEN);
}

export async function setPin(userId: string, newPin: string): Promise<void> {
  const salt = randomBytes(16);
  const stored: StoredPin = {
    salt: salt.toString('hex'),
    hash: hashPin(newPin, salt).toString('hex'),
  };
  await withUserContext(userId, (client) =>
    client.query(
      `INSERT INTO family_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [`pin_hash:${userId}`, JSON.stringify(stored)],
    ),
  );
}

/** Returns 'ok' | 'wrong' | 'no_pin_set'. */
export async function verifyPin(userId: string, pin: string): Promise<'ok' | 'wrong' | 'no_pin_set'> {
  const stored = await withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ value: StoredPin }>(
      `SELECT value FROM family_settings WHERE key = $1`,
      [`pin_hash:${userId}`],
    );
    return rows[0]?.value ?? null;
  });
  if (!stored?.salt || !stored?.hash) return 'no_pin_set';

  const expected = Buffer.from(stored.hash, 'hex');
  const actual = hashPin(pin, Buffer.from(stored.salt, 'hex'));
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? 'ok' : 'wrong';
}
