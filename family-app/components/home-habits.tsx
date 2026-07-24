'use client';

import Link from 'next/link';
import { useTransition } from 'react';
import { toggleHabit } from '@/app/actions';
import type { FamilyHabit } from '@/lib/types';

/** Compact check-in strip for Home: my habits as toggle pills + partner status. */
export function HomeHabits({ habits, myUserId }: { habits: FamilyHabit[]; myUserId: string }) {
  const [pending, startTransition] = useTransition();
  const mine = habits.filter((h) => h.user_id === myUserId);
  const theirs = habits.filter((h) => h.user_id !== myUserId && h.shared);
  const partnerName = theirs[0]?.owner_name;
  const partnerDone = theirs.filter((h) => h.done_today).length;

  if (mine.length === 0) return null;

  return (
    <section>
      <div className="flex items-baseline justify-between mb-1.5">
        <h2 className="text-sm font-bold opacity-70">Habits today</h2>
        <Link href="/habits" className="text-xs text-indigo-500 font-medium">All habits →</Link>
      </div>
      <div className={`flex flex-wrap gap-2 ${pending ? 'opacity-60' : ''}`}>
        {mine.map((h) => (
          <button
            key={h.id}
            onClick={() => startTransition(() => toggleHabit(h.id))}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium border
              ${h.done_today
                ? 'bg-green-500 border-green-500 text-white'
                : 'border-neutral-300 dark:border-neutral-700'}`}
          >
            {h.done_today ? '✓ ' : ''}{h.name}
          </button>
        ))}
      </div>
      {partnerName && (
        <p className="text-xs opacity-60 mt-1.5">
          {partnerName}: {partnerDone}/{theirs.length} today
        </p>
      )}
    </section>
  );
}
