'use client';

import { useRef, useState, useTransition } from 'react';
import { toggleHabit, createHabit, archiveHabit } from '@/app/actions';
import type { FamilyHabit } from '@/lib/types';

/**
 * Accountability view: everyone's shared habits grouped by person.
 * You can only tap your own; the other person's are visible read-only.
 */
export function HabitsView({ habits, myUserId }: { habits: FamilyHabit[]; myUserId: string }) {
  const byOwner = new Map<string, { name: string; habits: FamilyHabit[] }>();
  for (const h of habits) {
    const g = byOwner.get(h.user_id) ?? { name: h.owner_name ?? '?', habits: [] };
    g.habits.push(h);
    byOwner.set(h.user_id, g);
  }
  // Show my column first
  const owners = [...byOwner.entries()].sort(([a], [b]) =>
    a === myUserId ? -1 : b === myUserId ? 1 : 0,
  );

  return (
    <div className="flex flex-col gap-5">
      {owners.map(([ownerId, group]) => (
        <section key={ownerId}>
          <h2 className="text-sm font-bold opacity-70 mb-1.5">
            {ownerId === myUserId ? 'You' : group.name}
          </h2>
          <div className="flex flex-col gap-2">
            {group.habits.map((h) => (
              <HabitRow key={h.id} habit={h} mine={ownerId === myUserId} />
            ))}
          </div>
        </section>
      ))}
      <NewHabitForm />
    </div>
  );
}

function HabitRow({ habit, mine }: { habit: FamilyHabit; mine: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className={`flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2.5 ${pending ? 'opacity-50' : ''}`}>
      <button
        aria-label={habit.done_today ? 'Undo today' : 'Check in today'}
        disabled={!mine}
        onClick={() => mine && startTransition(() => toggleHabit(habit.id))}
        className={`h-9 w-9 shrink-0 rounded-full border-2 flex items-center justify-center text-lg
          ${habit.done_today
            ? 'border-green-500 bg-green-500 text-white'
            : 'border-neutral-400 dark:border-neutral-600'}
          ${mine ? '' : 'opacity-60 cursor-default'}`}
      >
        {habit.done_today ? '✓' : ''}
      </button>
      <div className="flex-1 min-w-0">
        <p className="font-medium">{habit.name}</p>
        <div className="flex items-center gap-2 mt-1">
          <div className="flex gap-1">
            {Array.from({ length: habit.target_per_week }, (_, i) => (
              <span
                key={i}
                className={`h-1.5 w-4 rounded-full ${
                  i < habit.week_count ? 'bg-green-500' : 'bg-neutral-200 dark:bg-neutral-800'
                }`}
              />
            ))}
          </div>
          <span className="text-xs opacity-60">{habit.week_count}/{habit.target_per_week} this week</span>
        </div>
      </div>
      {mine && (
        <button
          aria-label="Archive habit"
          onClick={() => {
            if (confirm(`Archive "${habit.name}"? History is kept.`)) startTransition(() => archiveHabit(habit.id));
          }}
          className="p-1 text-neutral-400 hover:text-red-500"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

function NewHabitForm() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLFormElement>(null);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 py-2.5 text-sm font-medium opacity-70"
      >
        + New habit
      </button>
    );
  }

  return (
    <form
      ref={ref}
      action={(fd) => {
        const name = String(fd.get('name') ?? '').trim();
        if (!name) return;
        const target = parseInt(String(fd.get('target') ?? '7'), 10);
        startTransition(async () => {
          await createHabit(name, target);
          ref.current?.reset();
          setOpen(false);
        });
      }}
      className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 flex flex-col gap-2"
    >
      <input name="name" placeholder="Habit (e.g. Meditation)" autoFocus className="bg-transparent outline-none font-medium" autoComplete="off" />
      <div className="flex items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <span className="opacity-60">Target</span>
          <select name="target" defaultValue="7" className="bg-transparent border border-neutral-300 dark:border-neutral-700 rounded-md px-2 py-1 dark:bg-neutral-950">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>{n}×/week</option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={() => setOpen(false)} className="text-sm px-2 py-1 opacity-60">Cancel</button>
          <button type="submit" disabled={pending} className="rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
            Create
          </button>
        </div>
      </div>
    </form>
  );
}
