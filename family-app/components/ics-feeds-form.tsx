'use client';

import { useState, useTransition } from 'react';
import { saveIcsFeeds } from '@/app/actions';

interface Feed { name: string; url: string }

export function IcsFeedsForm({ initial }: { initial: Feed[] }) {
  const [feeds, setFeeds] = useState<Feed[]>(
    initial.length > 0 ? initial : [{ name: 'Mark', url: '' }, { name: 'Ashley', url: '' }],
  );
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  function update(i: number, patch: Partial<Feed>) {
    setSaved(false);
    setFeeds(feeds.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  return (
    <div className="flex flex-col gap-3">
      {feeds.map((f, i) => (
        <div key={i} className="flex flex-col gap-1 text-sm">
          <div className="flex items-center gap-2">
            <input
              value={f.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="Name (e.g. Mark, Ashley, Family)"
              className="w-40 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-2.5 py-1.5 font-medium"
              autoComplete="off"
            />
            <button
              aria-label="Remove calendar"
              onClick={() => { setSaved(false); setFeeds(feeds.filter((_, j) => j !== i)); }}
              className="text-neutral-400 hover:text-red-500 px-1"
            >
              ×
            </button>
          </div>
          <input
            value={f.url}
            onChange={(e) => update(i, { url: e.target.value })}
            placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-2.5 py-2 text-xs font-mono"
            autoComplete="off"
          />
        </div>
      ))}
      <div className="flex gap-2">
        <button
          onClick={() => setFeeds([...feeds, { name: '', url: '' }])}
          className="rounded-lg border border-dashed border-neutral-400 dark:border-neutral-600 px-3 py-1.5 text-sm opacity-70"
        >
          + Add calendar
        </button>
        <button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await saveIcsFeeds(feeds.filter((f) => f.name.trim() && f.url.trim()));
              setSaved(true);
            })
          }
          className="rounded-lg bg-indigo-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
        >
          {pending ? 'Saving…' : saved ? 'Saved ✓' : 'Save calendars'}
        </button>
      </div>
    </div>
  );
}
