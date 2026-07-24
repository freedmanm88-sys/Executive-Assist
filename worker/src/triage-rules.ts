/**
 * Level-1 hard rules + Level-2 learned preferences for email triage.
 *
 * Rules are checked BEFORE Claude (architecture doc: "Hard rules apply
 * instantly and override Claude"). Supported actions:
 *   - 'classify:<classification>' — skip Claude entirely, use this class
 *   - 'never_urgent'  — Claude still classifies, but urgency is capped and
 *                       the email can never trigger an urgent alert
 *   - 'always_urgent' — force urgent regardless of Claude
 *
 * Preferences are plain-text guidance rows injected into the classifier
 * prompt. Both tables are populated by the weekly distillation cron (and
 * can be hand-edited in SQL).
 */

import { withUserContext } from './db.js';
import type { Classification } from './classifiers/email-triage.js';

export interface TriageRule {
  id:            string;
  pattern_type:  'sender_email' | 'sender_domain' | 'subject_contains';
  pattern_value: string;
  action:        string;
}

export interface RuleMatch {
  classify:     Classification | null;
  neverUrgent:  boolean;
  alwaysUrgent: boolean;
  matched:      TriageRule[];
}

export async function loadTriageRules(userId: string): Promise<TriageRule[]> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<TriageRule>(
      `SELECT id, pattern_type, pattern_value, action
       FROM triage_rules
       WHERE active AND domain = 'email_triage'
         AND pattern_type IN ('sender_email', 'sender_domain', 'subject_contains')`,
    );
    return rows;
  });
}

export function matchTriageRules(
  rules: TriageRule[],
  email: { senderEmail: string; subject: string },
): RuleMatch {
  const sender = email.senderEmail.toLowerCase();
  const subject = email.subject.toLowerCase();
  const out: RuleMatch = { classify: null, neverUrgent: false, alwaysUrgent: false, matched: [] };

  for (const rule of rules) {
    const v = rule.pattern_value.toLowerCase();
    const hit =
      (rule.pattern_type === 'sender_email' && sender === v) ||
      (rule.pattern_type === 'sender_domain' && (sender.endsWith(`@${v}`) || sender.endsWith(`.${v}`))) ||
      (rule.pattern_type === 'subject_contains' && subject.includes(v));
    if (!hit) continue;

    out.matched.push(rule);
    if (rule.action.startsWith('classify:')) {
      out.classify = rule.action.slice('classify:'.length) as Classification;
    } else if (rule.action === 'never_urgent') {
      out.neverUrgent = true;
    } else if (rule.action === 'always_urgent') {
      out.alwaysUrgent = true;
    }
  }
  return out;
}

/** Active learned preferences for triage/urgency, highest-confidence first. */
export async function loadTriagePreferences(userId: string): Promise<string[]> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ preference: string }>(
      `SELECT preference FROM learned_preferences
       WHERE active AND domain IN ('email_triage', 'urgency')
       ORDER BY confidence DESC, last_reinforced DESC
       LIMIT 20`,
    );
    return rows.map((r) => r.preference);
  });
}
