'use client';

import { useTransition } from 'react';
import { toggleTask, deleteTask } from '@/app/actions';
import type { FamilyTask } from '@/lib/types';
import { relativeDay, isOverdue } from '@/lib/dates';

export function TaskRow({ task }: { task: FamilyTask }) {
  const [pending, startTransition] = useTransition();
  const done = task.status === 'done';
  const overdue = !done && isOverdue(task.due_at);

  return (
    <div
      className={`flex items-start gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2.5
        ${pending ? 'opacity-50' : ''} ${done ? 'opacity-60' : ''}`}
    >
      <button
        aria-label={done ? 'Reopen task' : 'Complete task'}
        onClick={() => startTransition(() => toggleTask(task.id, !done))}
        className={`mt-0.5 h-6 w-6 shrink-0 rounded-full border-2 flex items-center justify-center
          ${done ? 'border-green-500 bg-green-500 text-white' : 'border-neutral-400 dark:border-neutral-600'}`}
      >
        {done && (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`font-medium ${done ? 'line-through' : ''}`}>{task.title}</p>
        {task.notes && <p className="text-sm opacity-60 whitespace-pre-wrap">{task.notes}</p>}
        <div className="flex flex-wrap gap-x-3 text-xs mt-0.5 opacity-70">
          {task.due_at && (
            <span className={overdue ? 'text-red-500 font-semibold opacity-100' : ''}>
              {overdue ? '⚠ ' : ''}{relativeDay(task.due_at)}
            </span>
          )}
          {task.assigned_to_name && <span>→ {task.assigned_to_name}</span>}
          {task.priority === 1 && <span className="text-orange-500 font-semibold">high</span>}
        </div>
      </div>
      <button
        aria-label="Delete task"
        onClick={() => {
          if (confirm(`Delete "${task.title}"?`)) startTransition(() => deleteTask(task.id));
        }}
        className="p-1 text-neutral-400 hover:text-red-500"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
