'use client';

import { useTransition } from 'react';
import { resolveProposal } from '@/app/actions';
import type { FamilyProposal } from '@/lib/types';

/** Suggested tasks/events extracted from emails — accept or dismiss. */
export function Proposals({ proposals, users, myUserId }: {
  proposals: FamilyProposal[];
  users: { id: string; name: string }[];
  myUserId: string;
}) {
  if (proposals.length === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-bold opacity-70 mb-1.5">📬 Suggested from your email</h2>
      <div className="flex flex-col gap-2">
        {proposals.map((p) => (
          <ProposalCard key={p.id} proposal={p} users={users} myUserId={myUserId} />
        ))}
      </div>
    </section>
  );
}

function ProposalCard({ proposal, users, myUserId }: {
  proposal: FamilyProposal;
  users: { id: string; name: string }[];
  myUserId: string;
}) {
  const [pending, startTransition] = useTransition();
  const p = proposal.payload;

  return (
    <div className={`rounded-xl border border-indigo-300 dark:border-indigo-800 bg-indigo-50/40 dark:bg-indigo-950/20 p-3 flex flex-col gap-1.5 ${pending ? 'opacity-50' : ''}`}>
      <p className="font-medium">
        {proposal.kind === 'event' ? '📅' : '📋'} {p.title}
      </p>
      <p className="text-xs opacity-70">
        {p.due_date && `Due ${p.due_date} · `}
        {p.date && `${p.date}${p.time ? ` at ${p.time}` : ''} · `}
        {p.location && `${p.location} · `}
        From: “{proposal.subject}” ({proposal.sender_email})
      </p>
      {p.notes && <p className="text-sm opacity-80">{p.notes}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        {proposal.kind === 'task' ? (
          <>
            {users.map((u) => (
              <button
                key={u.id}
                onClick={() => startTransition(() => resolveProposal(proposal.id, 'accept', u.id))}
                className="rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-sm font-medium"
              >
                ✓ For {u.id === myUserId ? 'me' : u.name}
              </button>
            ))}
            <button
              onClick={() => startTransition(() => resolveProposal(proposal.id, 'accept', null))}
              className="rounded-lg border border-indigo-400 text-indigo-600 dark:text-indigo-400 px-3 py-1.5 text-sm font-medium"
            >
              ✓ Anyone
            </button>
          </>
        ) : (
          <button
            onClick={() => startTransition(() => resolveProposal(proposal.id, 'accept', null))}
            className="rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-sm font-medium"
          >
            ✓ Add to calendar
          </button>
        )}
        <button
          onClick={() => startTransition(() => resolveProposal(proposal.id, 'dismiss', null))}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm opacity-70"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
