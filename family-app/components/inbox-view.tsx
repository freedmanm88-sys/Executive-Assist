'use client';

/**
 * The feedback environment: every email-triage decision the assistant made,
 * as a card with one-tap corrections. "Not urgent" is the canned adjustment
 * Mark asked for; ✏️ Adjust takes free text that Claude parses into
 * structured feedback (same pipeline as the old Telegram ✏️ button).
 */

import { useState, useTransition } from 'react';
import { sendFeedback, type FeedbackResult } from '@/app/actions';
import type { FeedItem } from '@/lib/types';
import { relativeDay, fmtTime } from '@/lib/dates';

const CLASS_STYLE: Record<string, string> = {
  urgent:       'bg-red-500/15 text-red-600 dark:text-red-400',
  action:       'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  reply_needed: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  calendar:     'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  receipt:      'bg-teal-500/15 text-teal-600 dark:text-teal-400',
  fyi:          'bg-neutral-500/15 text-neutral-600 dark:text-neutral-300',
  newsletter:   'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  spam:         'bg-neutral-500/15 text-neutral-500',
};

const ACTIONABLE = new Set(['urgent', 'action', 'reply_needed', 'calendar']);

export function InboxView({ feed }: { feed: FeedItem[] }) {
  // Default: actionable-and-unreviewed only. Newsletters/bot noise lives
  // under "Everything" — reviewing those is optional training, not homework.
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const shown =
    filter === 'pending'
      ? feed.filter((f) => !f.feedback && ACTIONABLE.has(f.classification))
      : feed;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Inbox decisions</h1>
        <div className="flex rounded-lg border border-neutral-300 dark:border-neutral-700 overflow-hidden text-sm">
          {(['pending', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 font-medium ${filter === f ? 'bg-indigo-600 text-white' : ''}`}
            >
              {f === 'pending' ? 'Needs review' : 'Everything'}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs opacity-60 -mt-2">
        Only urgent / action / reply-needed / calendar emails show here by default.
        Correct anything wrong — every answer becomes a rule or preference on Sunday night.
      </p>
      {shown.length === 0 && (
        <p className="text-sm opacity-60 py-6 text-center">
          {filter === 'pending' ? 'All caught up — nothing needs review. ✅' : 'No triage decisions yet.'}
        </p>
      )}
      {shown.map((item) => (
        <FeedCard key={item.decision_id} item={item} />
      ))}
    </div>
  );
}

function FeedCard({ item }: { item: FeedItem }) {
  const [pending, startTransition] = useTransition();
  const [adjusting, setAdjusting] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<FeedbackResult | null>(null);
  const [localFeedback, setLocalFeedback] = useState(item.feedback);

  const cls = item.classification;
  const urgency = typeof item.decision?.urgency_score === 'number' ? item.decision.urgency_score : null;
  const isUrgentish = cls === 'urgent' || (urgency !== null && urgency >= 70);

  function give(action: 'correct' | 'wrong' | 'adjust', text?: string) {
    startTransition(async () => {
      try {
        const r = await sendFeedback(item.decision_id, action, text);
        setResult(r);
        setLocalFeedback(action === 'adjust' ? 'adjusted' : action);
        setAdjusting(false);
      } catch {
        alert('Could not save feedback — try again.');
      }
    });
  }

  return (
    <div className={`rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 flex flex-col gap-2 ${pending ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium leading-snug">{item.subject ?? '(no subject)'}</p>
          <p className="text-xs opacity-60 truncate">
            {item.sender_name || item.sender_email} · {relativeDay(item.received_at)} {fmtTime(item.received_at)}
            {item.account_label ? ` · ${item.account_label}` : ''}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${CLASS_STYLE[cls] ?? CLASS_STYLE['fyi']}`}>
          {cls}{urgency !== null && cls === 'urgent' ? ` ${urgency}` : ''}
        </span>
      </div>
      {item.reasoning && <p className="text-sm opacity-70 italic">“{item.reasoning}”</p>}

      {localFeedback ? (
        <div className="text-sm font-medium">
          {localFeedback === 'correct' && <span className="text-green-600 dark:text-green-400">✅ Marked correct</span>}
          {localFeedback === 'wrong' && <span className="text-red-500">❌ Marked wrong</span>}
          {localFeedback === 'adjusted' && (
            <div className="text-indigo-600 dark:text-indigo-400">
              📝 Adjustment recorded
              {result?.parsed && (
                <p className="text-xs font-normal opacity-80 mt-1 text-neutral-700 dark:text-neutral-300">
                  {result.parsed.corrected_classification && <>Should be <b>{result.parsed.corrected_classification}</b>. </>}
                  {result.parsed.pattern_hint && <>Rule hint: {result.parsed.pattern_hint}</>}
                </p>
              )}
            </div>
          )}
        </div>
      ) : adjusting ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='e.g. "this is just a calendar confirmation, not urgent"'
            rows={2}
            autoFocus
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-2.5 py-1.5 text-sm"
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setAdjusting(false)} className="text-sm px-2 py-1 opacity-60">Cancel</button>
            <button
              onClick={() => note.trim() && give('adjust', note.trim())}
              disabled={pending || !note.trim()}
              className="rounded-lg bg-indigo-600 text-white px-3 py-1 text-sm font-semibold disabled:opacity-50"
            >
              {pending ? 'Parsing…' : 'Send'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1">
          <FeedbackBtn onClick={() => give('correct')} className="border-green-500/40 text-green-600 dark:text-green-400">
            ✅ Correct
          </FeedbackBtn>
          {isUrgentish && (
            <FeedbackBtn
              onClick={() => give('adjust', 'This is not urgent.')}
              className="border-amber-500/40 text-amber-600 dark:text-amber-400"
            >
              🔕 Not urgent
            </FeedbackBtn>
          )}
          <FeedbackBtn onClick={() => give('wrong')} className="border-red-500/40 text-red-500">
            ❌ Wrong
          </FeedbackBtn>
          <FeedbackBtn onClick={() => setAdjusting(true)} className="border-indigo-500/40 text-indigo-600 dark:text-indigo-400">
            ✏️ Adjust
          </FeedbackBtn>
        </div>
      )}
    </div>
  );
}

function FeedbackBtn({
  onClick,
  className,
  children,
}: {
  onClick: () => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${className}`}>
      {children}
    </button>
  );
}
