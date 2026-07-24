/**
 * Weekly distillation (Sun 21:00 Toronto) — the learning loop.
 *
 * Reads the last 14 days of feedback on triage decisions (wrong / adjusted,
 * plus correct-confirmations for context), asks Claude to propose:
 *   - hard triage_rules (sender/domain/subject patterns → classify:/never_urgent)
 *   - learned_preferences (soft guidance injected into future prompts)
 *
 * Conservative by design: max 8 rules per run, only patterns clearly supported
 * by the feedback. Duplicate rules are skipped. A summary is pushed to Mark.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, DEFAULT_MODEL } from '../claude.js';
import { withUserContext } from '../db.js';
import { sendPushToUser } from '../push.js';
import { sendMessage } from '../telegram.js';
import { config } from '../config.js';

const MAX_RULES_PER_RUN = 8;

interface FeedbackRow {
  feedback:       string;
  feedback_note:  string | null;
  classification: string;
  urgency:        number | null;
  subject:        string | null;
  sender_email:   string | null;
}

const DISTILL_TOOL: Anthropic.Tool = {
  name: 'propose_learnings',
  description: 'Propose triage rules and preferences distilled from user feedback.',
  input_schema: {
    type: 'object',
    properties: {
      rules: {
        type: 'array',
        maxItems: MAX_RULES_PER_RUN,
        items: {
          type: 'object',
          properties: {
            pattern_type:  { type: 'string', enum: ['sender_email', 'sender_domain', 'subject_contains'] },
            pattern_value: { type: 'string' },
            action: {
              type: 'string',
              description: "'classify:<newsletter|fyi|receipt|spam|calendar|action>' to hard-classify, or 'never_urgent' / 'always_urgent'.",
            },
            rationale: { type: 'string' },
          },
          required: ['pattern_type', 'pattern_value', 'action', 'rationale'],
        },
      },
      preferences: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            domain:     { type: 'string', enum: ['email_triage', 'urgency'] },
            preference: { type: 'string', description: 'One clear sentence of guidance for future triage.' },
          },
          required: ['domain', 'preference'],
        },
      },
    },
    required: ['rules', 'preferences'],
  },
};

export async function runDistillation(): Promise<{ rules_added: number; prefs_added: number; skipped: string }> {
  const userId = config.USER_ID;

  const feedback = await withUserContext(userId, async (client) => {
    const { rows } = await client.query<FeedbackRow>(
      `SELECT d.feedback, d.feedback_note,
              (d.decision->>'classification')     AS classification,
              (d.decision->>'urgency_score')::int AS urgency,
              etl.subject, etl.sender_email
       FROM ai_decisions d
       JOIN email_triage_log etl ON etl.decision_id = d.id
       WHERE d.domain = 'email_triage'
         AND d.feedback IS NOT NULL
         AND d.feedback_at > NOW() - INTERVAL '14 days'
       ORDER BY d.feedback_at DESC
       LIMIT 100`,
    );
    return rows;
  });

  const corrections = feedback.filter((f) => f.feedback !== 'correct');
  if (corrections.length < 2) {
    console.log(`[cron:distillation] only ${corrections.length} corrections in window — skipping`);
    return { rules_added: 0, prefs_added: 0, skipped: 'not_enough_feedback' };
  }

  const existingRules = await withUserContext(userId, async (client) => {
    const { rows } = await client.query(
      `SELECT pattern_type, pattern_value, action FROM triage_rules WHERE active AND domain = 'email_triage'`,
    );
    return rows as { pattern_type: string; pattern_value: string; action: string }[];
  });

  const prompt = [
    "Distill the user's email-triage feedback into durable learnings.",
    'Only propose a rule when the feedback clearly supports it (e.g. the user said a sender/type is never urgent).',
    'Prefer sender_domain over sender_email when the pattern is about a service, not a person.',
    'Do not duplicate existing rules. Fewer, higher-confidence learnings beat many guesses.',
    '',
    `Existing rules: ${JSON.stringify(existingRules)}`,
    '',
    'Feedback (newest first):',
    ...feedback.map((f) =>
      `- [${f.feedback}] "${f.subject}" from ${f.sender_email} was classified ${f.classification} (urgency ${f.urgency})` +
      (f.feedback_note ? ` — user note: ${f.feedback_note.slice(0, 300)}` : ''),
    ),
  ].join('\n');

  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1500,
    tools: [DISTILL_TOOL],
    tool_choice: { type: 'tool', name: 'propose_learnings' },
    messages: [{ role: 'user', content: prompt }],
  });

  const tu = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'propose_learnings',
  );
  if (!tu) throw new Error('distillation: no propose_learnings tool_use');
  const proposed = tu.input as {
    rules: { pattern_type: string; pattern_value: string; action: string; rationale: string }[];
    preferences: { domain: string; preference: string }[];
  };

  let rulesAdded = 0;
  let prefsAdded = 0;
  await withUserContext(userId, async (client) => {
    for (const r of proposed.rules.slice(0, MAX_RULES_PER_RUN)) {
      const dup = await client.query(
        `SELECT 1 FROM triage_rules
         WHERE domain = 'email_triage' AND pattern_type = $1 AND lower(pattern_value) = lower($2) AND action = $3`,
        [r.pattern_type, r.pattern_value, r.action],
      );
      if ((dup.rowCount ?? 0) > 0) continue;
      await client.query(
        `INSERT INTO triage_rules (user_id, domain, pattern_type, pattern_value, action)
         VALUES ($1::uuid, 'email_triage', $2, $3, $4)`,
        [userId, r.pattern_type, r.pattern_value, r.action],
      );
      rulesAdded++;
    }
    for (const p of proposed.preferences) {
      const dup = await client.query(
        `SELECT 1 FROM learned_preferences WHERE domain = $1 AND lower(preference) = lower($2)`,
        [p.domain, p.preference],
      );
      if ((dup.rowCount ?? 0) > 0) continue;
      await client.query(
        `INSERT INTO learned_preferences (user_id, domain, preference, confidence, derived_from_count)
         VALUES ($1::uuid, $2, $3, 0.7, $4)`,
        [userId, p.domain, p.preference, corrections.length],
      );
      prefsAdded++;
    }
  });

  if (rulesAdded > 0 || prefsAdded > 0) {
    const summary = [
      `🧠 Learned from your feedback this week: ${rulesAdded} new rule${rulesAdded === 1 ? '' : 's'}, ${prefsAdded} preference${prefsAdded === 1 ? '' : 's'}.`,
      ...proposed.rules.slice(0, MAX_RULES_PER_RUN).map((r) => `• ${r.pattern_type}=${r.pattern_value} → ${r.action}`),
    ].join('\n');
    await sendMessage(summary, { disablePreview: true });
    await sendPushToUser(userId, {
      title: 'Assistant learned from your feedback',
      body: `${rulesAdded} new rules, ${prefsAdded} preferences from ${corrections.length} corrections.`,
      url: '/inbox',
      tag: 'distillation',
    });
  }

  console.log(`[cron:distillation] rules=${rulesAdded} prefs=${prefsAdded} from ${corrections.length} corrections`);
  return { rules_added: rulesAdded, prefs_added: prefsAdded, skipped: '' };
}
