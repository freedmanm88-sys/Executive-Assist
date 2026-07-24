'use client';

import { useState } from 'react';
import type { FamilyTask } from '@/lib/types';
import { TaskRow } from './task-row';
import { NewTaskForm } from './new-task-form';

export function TasksView({
  tasks,
  users,
  categories,
}: {
  tasks: FamilyTask[];
  users: { id: string; name: string }[];
  categories: string[];
}) {
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const usersById = new Map(users.map((u) => [u.id, u.name]));

  const filtered = catFilter ? tasks.filter((t) => t.category === catFilter) : tasks;
  const open = filtered.filter((t) => t.status === 'open');
  const done = filtered.filter((t) => t.status === 'done').slice(0, 20);
  const usedCategories = [...new Set(tasks.map((t) => t.category).filter(Boolean))] as string[];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Tasks</h1>
      <NewTaskForm users={users} categories={categories} />
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
