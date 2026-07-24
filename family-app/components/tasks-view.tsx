'use client';

import { useState } from 'react';
import type { FamilyTask } from '@/lib/types';
import { TaskRow } from './task-row';
import { NewTaskForm } from './new-task-form';

type WhoFilter = 'all' | 'unassigned' | string; // string = a user id

export function TasksView({
  tasks,
  users,
  categories,
  myUserId,
}: {
  tasks: FamilyTask[];
  users: { id: string; name: string }[];
  categories: string[];
  myUserId: string;
}) {
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const [whoFilter, setWhoFilter] = useState<WhoFilter>('all');
  const usersById = new Map(users.map((u) => [u.id, u.name]));

  const byWho = tasks.filter((t) => {
    if (whoFilter === 'all') return true;
    if (whoFilter === 'unassigned') return !t.assigned_to;
    return t.assigned_to === whoFilter;
  });
  const filtered = catFilter ? byWho.filter((t) => t.category === catFilter) : byWho;
  const open = filtered.filter((t) => t.status === 'open');
  const done = filtered.filter((t) => t.status === 'done').slice(0, 20);
  const usedCategories = [...new Set(tasks.map((t) => t.category).filter(Boolean))] as string[];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Tasks</h1>
      <NewTaskForm users={users} categories={categories} />
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {(
          [
            { key: 'all' as const, label: 'Everyone' },
            ...users.map((u) => ({ key: u.id, label: u.id === myUserId ? 'Mine' : `${u.name}'s` })),
            { key: 'unassigned' as const, label: 'Anyone' },
          ]
        ).map((f) => (
          <button
            key={f.key}
            onClick={() => setWhoFilter(f.key)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium border ${
              whoFilter === f.key ? 'bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900 border-transparent' : 'border-neutral-300 dark:border-neutral-700'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {usedCategories.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          <button
            onClick={() => setCatFilter(null)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium border ${
              catFilter === null ? 'bg-indigo-600 text-white border-indigo-600' : 'border-neutral-300 dark:border-neutral-700'
            }`}
          >
            All
          </button>
          {usedCategories.map((c) => (
            <button
              key={c}
              onClick={() => setCatFilter(catFilter === c ? null : c)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium border ${
                catFilter === c ? 'bg-indigo-600 text-white border-indigo-600' : 'border-neutral-300 dark:border-neutral-700'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      <section className="flex flex-col gap-2">
        {open.length === 0 && (
          <p className="text-sm opacity-60 py-4 text-center">Nothing open. Enjoy it while it lasts. 🎉</p>
        )}
        {open.map((t) => (
          <TaskRow key={t.id} task={t} usersById={usersById} />
        ))}
      </section>
      {done.length > 0 && (
        <details className="mt-2">
          <summary className="text-sm font-medium opacity-60 cursor-pointer">Done ({done.length})</summary>
          <div className="flex flex-col gap-2 mt-2">
            {done.map((t) => (
              <TaskRow key={t.id} task={t} usersById={usersById} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
