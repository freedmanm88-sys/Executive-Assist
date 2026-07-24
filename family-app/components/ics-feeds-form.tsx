'use client';

import { useState, useTransition } from 'react';
import { saveIcsFeeds } from '@/app/actions';

export function IcsFeedsForm({ initial }: { initial: { name: string; url: string }[] }) {
  const [feeds, setFeeds] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {feeds.map((f, i) => (
        <label key={f.name} className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{f.name}&apos;s calendar</span>
          <input
            value={f.url}
            onChange={(e) => {
              setSaved(false);
              setFeeds(feeds.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)));
            }}
            placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-2.5 py-2 text-xs font-mono"
            autoComplete="off"
          />
        </label>
      ))}
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await saveIcsFeeds(feeds);
            setSaved(true);
          })
        }
        className="self-start rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {pending ? 'Saving…' : saved ? 'Saved ✓' : 'Save calendars'}
      </button>
    </div>
  );
}
