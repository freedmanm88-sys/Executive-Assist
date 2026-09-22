'use client';

/**
 * Review deck — one email per screen, action-shaped buttons, optional
 * one-line "why". Every tap has an immediate effect and shows what changed.
 * Spec: docs/2026-09-22/specs/assistant-learning-loop-v2.md §4–5.
 */

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { actOnReview, type ReviewAction, type ActResult } from '@/app/actions';
import type { ReviewCard } from '@/lib/types';
import { relativeDay, fmtTime } from '@/lib/dates';

const CLASS_STYLE: Record<string, string> = {
  urgent:       'bg-red-500/15 text-red-600 dark:text-red-400',
  action:       'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  reply_needed: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  calendar:     'bg-blue-500/15 text-blue-600 dark:text-blue-400',
};

export function ReviewDeck({
  cards,
  users,
  myUserId,
}: {
  cards: ReviewCard[];
  users: { id: string; name: string }[];
  myUserId: string;
}) {
  const [queue, setQueue] = useState(cards);
  const [done, setDone] = useState(0);
  const [lastEffects, setLastEffects] = useState<string[] | null>(null);
  const [note, setNote] = useState('');
  const [assignPick, setAssignPick] = useState(false);
  const [pending, startTransition] = useTransition();

  const card = queue[0];

  function act(action: ReviewAction, assignedTo?: string | null) {
    if (!card) return;
    const id = card.decision_id;
    startTransition(async () => {
      let result: ActResult;
      try {
        result = await actOnReview(id, action, note.trim() || undefined, assignedTo ?? null);
      } catch {
        setLastEffects(['Something went wrong — try again.']);
        return;
      }
      if (result.status === 'not_available') {
        setLastEffects(result.effects);
        return;
      }
      setLastEffects(result.effects);
      setNote('');
      setAssignPick(false);
      setDone((d) => d + 1 + result.also_resolved);
      // A mute clears siblings server-side; drop them locally too.
      const sender = card.sender_email?.toLowerCase() ?? '';
      const domain = sender.split('@')[1] ?? '';
      setQueue((q) =>
        q.filter((c) => {
          if (c.decision_id === id) return false;
          if (action === 'mute_sender' && c.sender_email?.toLowerCase() === sender) return false;
          if (action === 'mute_domain' && c.sender_email?.toLowerCase().endsWith(`@${domain}`)) return false;
          return true;
        }),
      );
    });
  }

  if (!card) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-4xl">✅</p>
        <p className="font-semibold">All caught up.</p>
        {done > 0 && <p className="text-sm opacity-60">{done} handled this session.</p>}
        {lastEffects && <Effects effects={lastEffects} />}
        <Link href="/inbox" className="text-sm text-indigo-500 mt-2">See everything the assistant triaged →</Link>
      </div>
    );
  }

  const urgency = typeof card.decision?.urgency_score === 'number' ? card.decision.urgency_score : null;
  const proposal = card.proposal;
  const partner = users.find((u) => u.id !== myUserId);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Review</h1>
        <span className="text-sm opacity-60">{queue.length} left</span>
      </div>

      {lastEffects && <Effects effects={lastEffects} />}

      <div className={`rounded-2xl border border-neutral-200 dark:border-neutral-800 p-4 flex flex-col gap-3 ${pending ? 'opacity-60' : ''}`}>
        <div className="flex items-start justify-between gap-2">
          <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${CLASS_STYLE[card.classification] ?? CLASS_STYLE['action']}`}>
            {card.classification}{urgency !== null && card.classification === 'urgent' ? ` ${urgency}` : ''}
          </span>
          <span className="text-xs opacity-60">{relativeDay(card.received_at)} {fmtTime(card.received_at)} · {card.account_label}</span>
        </div>
        <p className="font-semibold text-lg leading-snug">{card.subject ?? '(no subject)'}</p>
        <p className="text-sm opacity-70">
          {card.sender_name ? `${card.sender_name} · ` : ''}{card.sender_email}
          {card.sender_relationship ? ` · ${card.sender_relationship}` : ''}
        </p>
        {card.reasoning && <p className="text-sm italic opacity-80">“{card.reasoning}”</p>}
        {proposal && proposal.status === 'pending' && (
          <p className="text-sm rounded-lg bg-indigo-500/10 px-3 py-2">
            {proposal.kind === 'event' ? '📅' : '📋'} Extracted: <b>{String(proposal.payload?.['title'] ?? '')}</b>
            {proposal.payload?.['due_date'] ? ` · due ${proposal.payload['due_date']}` : ''}
            {proposal.payload?.['date'] ? ` · ${proposal.payload['date']}${proposal.payload?.['time'] ? ` ${proposal.payload['time']}` : ''}` : ''}
          </p>
        )}

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why? (optional, one line — it learns from this)"
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          autoComplete="off"
        />

        {assignPick ? (
          <div className="grid grid-cols-3 gap-2">
            <Btn onClick={() => act('make_task', myUserId)} primary>For me</Btn>
            {partner && <Btn onClick={() => act('make_task', partner.id)} primary>For {partner.name}</Btn>}
            <Btn onClick={() => act('make_task', null)}>Anyone</Btn>
            <button onClick={() => setAssignPick(false)} className="col-span-3 text-xs opacity-60 py-1">Cancel</button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Btn onClick={() => setAssignPick(true)} primary>☑ Make task</Btn>
            {proposal?.kind === 'event' && proposal.status === 'pending' ? (
              <Btn onClick={() => act('add_event')} primary>📅 Add event</Btn>
            ) : (
              <Btn onClick={() => act('draft_reply')}>✉ Draft reply</Btn>
            )}
            <Btn onClick={() => act('not_urgent')}>🔕 Not urgent</Btn>
            <Btn onClick={() => act('vip_sender')}>⭐ Always urgent</Btn>
            <Btn onClick={() => act('mute_sender')} danger>🚫 Mute sender</Btn>
            <Btn onClick={() => act('mute_domain')} danger>🚫 Mute domain</Btn>
            <Btn onClick={() => act('fine')}>👍 Fine as is</Btn>
            <Btn onClick={() => act('dismiss')}>Skip</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

function Effects({ effects }: { effects: string[] }) {
  return (
    <div className="rounded-xl border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30 px-3 py-2 text-sm">
      {effects.map((e, i) => (
        <p key={i}>✓ {e}</p>
      ))}
    </div>
  );
}

function Btn({
  onClick, children, primary, danger,
}: { onClick: () => void; children: React.ReactNode; primary?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`min-h-11 rounded-xl px-3 py-2.5 text-sm font-medium border
        ${primary ? 'bg-indigo-600 text-white border-indigo-600'
          : danger ? 'border-red-400/60 text-red-600 dark:text-red-400'
          : 'border-neutral-300 dark:border-neutral-700'}`}
    >
      {children}
    </button>
  );
}
