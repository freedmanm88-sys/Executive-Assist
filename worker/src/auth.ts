/**
 * Tiny shared-secret auth middleware.
 *
 * n8n's HTTP Request node sends header `X-Internal-Auth: <token>` on every
 * webhook forward. This middleware rejects requests missing or mismatching
 * that token. Prevents random POSTs from triggering Claude calls.
 */

import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

export function requireInternalAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('X-Internal-Auth');
  if (provided !== config.INTERNAL_AUTH_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
