/**
 * Email classification via Claude with structured tool output.
 *
 * Forces Claude to call the `classify_email` tool — guarantees structured output
 * regardless of whether Claude felt like writing prose. The tool is cached via
 * cache_control: ephemeral, so subsequent calls within ~5 min reuse the cached
 * tool definition + system prompt.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, DEFAULT_MODEL } from '../claude.js';

export type Classification =
  | 'urgent'
  | 'action'
  | 'reply_needed'
  | 'fyi'
  | 'newsletter'
  | 'receipt'
  | 'calendar'
  | 'spam';

export type SuggestedAction =
  | 'none'
  | 'archive'
  | 'label_only'
  | 'reply'
  | 'flag_for_review';

export interface ClassifyInput {
  subject:      string;
  fromHeader:   string;
  receivedAt:   string;
  bodySnippet:  string;
  /** Friendly account label (personal, business1, business2) — affects context */
  accountLabel: 'personal' | 'business1' | 'business2';
}

export interface ClassifyResult {
  classification:   Classification;
  urgency_score:    number;
  reasoning:        string;
  suggested_action: SuggestedAction;
}

const SYSTEM_PROMPT = `You triage Mark's inbox. He runs Sophax Consulting and Stonefield Mortgage from Toronto.

Account context:
- personal:   freedman.m88@gmail.com — personal life, family, friends, hobby subscriptions
- business1:  mark@sophaxconsulting.com — Sophax Consulting client work
- business2:  mark@stonefieldmortgage.ca — Stonefield Mortgage borrower/investor/regulatory

Classify each email and recommend an action. Be aggressive about archiving newsletters, receipts, and notifications. Be careful with anything from real humans — when in doubt, classify as 'fyi' rather than 'spam'.

ONLY use the classify_email tool. Always.`;

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'classify_email',
  description: 'Classify the email and recommend an action.',
  input_schema: {
    type: 'object',
    properties: {
      classification: {
        type: 'string',
        enum: ['urgent', 'action', 'reply_needed', 'fyi', 'newsletter', 'receipt', 'calendar', 'spam'],
        description:
          'Primary category. urgent=needs action <24h. action=needs action this week. reply_needed=human waiting for reply. fyi=informational. newsletter=marketing/digest. receipt=transactional. calendar=invite/booking. spam=junk.',
      },
      urgency_score: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: '0=ignore, 100=interrupt-now-urgent',
      },
      reasoning: {
        type: 'string',
        description: 'One sentence explaining the classification.',
      },
      suggested_action: {
        type: 'string',
        enum: ['none', 'archive', 'label_only', 'reply', 'flag_for_review'],
        description:
          'archive for newsletters/receipts/spam. flag_for_review when uncertain. reply for human-to-human action.',
      },
    },
    required: ['classification', 'urgency_score', 'reasoning', 'suggested_action'],
  },
};

/**
 * Classify a single email. Returns the structured result, or throws on API/format failure.
 */
export async function classifyEmail(input: ClassifyInput): Promise<ClassifyResult> {
  const userMessage = [
    `Account: ${input.accountLabel}`,
    `From: ${input.fromHeader}`,
    `Subject: ${input.subject}`,
    `Received: ${input.receivedAt}`,
    '',
    'Body:',
    input.bodySnippet || '(empty)',
  ].join('\n');

  const response = await anthropic.messages.create({
    model:      DEFAULT_MODEL,
    max_tokens: 512,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    tools: [
      // cache_control on the LAST tool also caches everything before it
      { ...CLASSIFY_TOOL, cache_control: { type: 'ephemeral' } },
    ],
    tool_choice: { type: 'tool', name: 'classify_email' },
    messages:    [{ role: 'user', content: userMessage }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'classify_email',
  );

  if (!toolUse) {
    throw new Error(
      `Claude did not return a classify_email tool_use block. stop_reason=${response.stop_reason}`,
    );
  }

  // Anthropic SDK types tool_use input as `unknown` — validate shape minimally.
  const out = toolUse.input as Partial<ClassifyResult>;
  if (
    !out.classification ||
    typeof out.urgency_score !== 'number' ||
    !out.reasoning ||
    !out.suggested_action
  ) {
    throw new Error(`classify_email returned malformed output: ${JSON.stringify(out)}`);
  }

  return out as ClassifyResult;
}
