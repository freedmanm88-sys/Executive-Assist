'use client';

import { useState, useTransition } from 'react';
import { saveTaskCategories } from '@/app/actions';

export function CategoriesForm({ initial }: { initial: string[] }) {
  const [cats, setCats] = useState(initial);
  const [draft, setDraft] = useState('');
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  function save(next: string[]) {
    setCats(next);
    setSaved(false);
    startTransition(async () => {
      await saveTaskCategories(next);
      setSaved(true);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {cats.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 rounded-full border border-neutral-300 dark:border-neutral-700 px-3 py-1 text-sm">
            {c}
            <button
              aria-label={`Remove ${c}`}
              onClick={() => save(cats.filter((x) => x !== c))}
              className="text-neutral-400 hover:text-red-500"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = draft.trim();
          if (v && !cats.includes(v)) save([...cats, v]);
          setDraft('');
        }}
        className="flex gap-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add category (e.g. School)"
          className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm"
          autoComplete="off"
        />
        <button className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 text-sm font-medium">Add</button>
      </form>
      <p className="text-xs opacity-60">{pending ? 'Saving…' : saved ? 'Saved ✓' : 'Changes save automatically.'}</p>
    </div>
  );
}
