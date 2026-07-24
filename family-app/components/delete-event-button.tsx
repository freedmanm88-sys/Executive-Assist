'use client';

import { useTransition } from 'react';
import { deleteEvent } from '@/app/actions';

export function DeleteEventButton({ id, title }: { id: string; title: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      aria-label="Delete event"
      disabled={pending}
      onClick={() => {
        if (confirm(`Delete "${title}"?`)) startTransition(() => deleteEvent(id));
      }}
      className="p-1 text-neutral-400 hover:text-red-500 disabled:opacity-40"
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  );
}
