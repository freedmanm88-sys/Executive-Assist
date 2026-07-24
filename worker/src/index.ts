/**
 * Executive Assistant worker — Express entry point.
 * Receives webhook events from n8n; routes to handlers.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import { config } from './config.js';
import { requireInternalAuth } from './auth.js';
import { gmailEventHandler } from './handlers/gmail-event.js';
import { telegramCallbackHandler, telegramFeedbackReplyHandler } from './handlers/feedback-event.js';
import { familyRouter, runMigrations } from './handlers/family-api.js';
import { pool } from './db.js';
import { registerCrons } from './crons/index.js';
import { runDailyDigest } from './crons/daily-digest.js';
import { runUrgentNag } from './crons/urgent-nag.js';
import { runMorningReminder, runHabitNudge, runWeeklySummary } from './crons/family-crons.js';
import { runDistillation } from './crons/distillation.js';

const app = express();

// Trust Railway's edge proxy so req.ip is correct (mirrors n8n's N8N_PROXY_HOPS=1).
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' })); // Gmail messages can be chunky

// ---------- Public routes ----------------------------------------------------

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, service: 'executive-assist-worker', uptime_s: Math.round(process.uptime()) });
});

// ---------- Authenticated routes ---------------------------------------------

app.post('/events/gmail',                  requireInternalAuth, asyncHandler(gmailEventHandler));
app.post('/events/telegram-callback',      requireInternalAuth, asyncHandler(telegramCallbackHandler));
app.post('/events/telegram-feedback-reply', requireInternalAuth, asyncHandler(telegramFeedbackReplyHandler));

// Family app API (Next.js frontend on Vercel → here). Same shared secret,
// plus per-request X-Family-User member validation inside the router.
app.use('/family', requireInternalAuth, familyRouter);

// Idempotent migration runner — applies all embedded migrations in order.
app.post('/admin/migrate', requireInternalAuth, asyncHandler(runMigrations));

// Manual cron trigger — useful for testing without waiting for 8 AM.
// Same auth as /events/* so n8n could trigger it on demand if needed.
app.post('/cron/daily-digest', requireInternalAuth, asyncHandler(async (_req, res) => {
  const result = await runDailyDigest();
  res.status(200).json(result);
}));

app.post('/cron/urgent-nag', requireInternalAuth, asyncHandler(async (_req, res) => {
  const result = await runUrgentNag();
  res.status(200).json(result);
}));

app.post('/cron/morning-reminder', requireInternalAuth, asyncHandler(async (_req, res) => {
  res.status(200).json(await runMorningReminder());
}));
app.post('/cron/habit-nudge', requireInternalAuth, asyncHandler(async (_req, res) => {
  res.status(200).json(await runHabitNudge());
}));
app.post('/cron/weekly-summary', requireInternalAuth, asyncHandler(async (_req, res) => {
  res.status(200).json(await runWeeklySummary());
}));
app.post('/cron/distillation', requireInternalAuth, asyncHandler(async (_req, res) => {
  res.status(200).json(await runDistillation());
}));

// ---------- 404 + error handler ----------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'invalid_request', details: err.flatten() });
    return;
  }
  console.error('[error]', err.stack ?? err);
  res.status(500).json({
    error: 'internal_error',
    message: config.isProduction ? 'see server logs' : err.message,
  });
});

// ---------- Start ------------------------------------------------------------

const server = app.listen(config.PORT, () => {
  console.log(`[ready] worker listening on :${config.PORT} (env=${config.NODE_ENV})`);
  registerCrons();
});

// ---------- Graceful shutdown ------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] received ${signal}, closing server + db pool`);
  server.close(() => console.log('[shutdown] http server closed'));
  await pool.end();
  console.log('[shutdown] db pool closed');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));

// ---------- Helpers ----------------------------------------------------------

/**
 * Wrap async route handlers so thrown promises hit the global error handler
 * instead of crashing the process.
 */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
