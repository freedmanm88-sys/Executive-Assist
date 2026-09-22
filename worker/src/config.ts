/**
 * Centralized env var loading + validation.
 * Fail fast at startup if anything required is missing.
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  DATABASE_URL:        z.string().url(),
  ANTHROPIC_API_KEY:   z.string().startsWith('sk-ant-'),
  TELEGRAM_BOT_TOKEN:  z.string().min(20),
  USER_ID:             z.string().uuid(),
  TELEGRAM_CHAT_ID:    z.string().regex(/^\d+$/),
  INTERNAL_AUTH_TOKEN: z.string().min(16),
  PORT:                z.string().regex(/^\d+$/).default('8080'),
  /** Public base URL of this worker (for Telegram webhook registration). Railway injects RAILWAY_PUBLIC_DOMAIN. */
  WORKER_PUBLIC_URL:   z.string().url().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  NODE_ENV:            z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  PORT: parseInt(parsed.data.PORT, 10),
  isProduction: parsed.data.NODE_ENV === 'production',
  publicUrl:
    parsed.data.WORKER_PUBLIC_URL
    ?? (parsed.data.RAILWAY_PUBLIC_DOMAIN ? `https://${parsed.data.RAILWAY_PUBLIC_DOMAIN}` : null),
};
