/**
 * Anthropic SDK wrapper. Single client instance, cached at module load.
 *
 * Prompt caching: system prompt + tools array are tagged with cache_control.
 * For email triage where every call uses the same system prompt + tools, this
 * saves ~80% of input tokens after the first call within the 5-minute cache TTL.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

export const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * Default model for triage / chat work. Sonnet 4.5 is the right cost/quality balance
 * for email classification — Opus is overkill, Haiku gets the nuanced cases wrong.
 * Bump to a newer model (4.6 / 4.7) when stable.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
