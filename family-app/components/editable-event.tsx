'use client';

import { useState, useTransition } from 'react';
import { updateEvent, deleteEvent } from '@/app/actions';
import type { FamilyEvent } from '@/lib/types';
import { fmtTime, TZ } from '@/lib/dates';

/** A family event row with inline edit + delete (ICS feed events are read-only). */
export function EditableEvent({ event }: { event: FamilyEvent }) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <div className={`flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2 ${pending ? 'opacity-50' : ''}`}>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-indigo-500" />
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{event.title}</p>
          <p className="text-xs opacity-60">
            {event.all_day ? 'All day' : `${fmtTime(event.start_at)}${event.end_at ? `–${fmtTime(event.end_at)}` : ''}`}
            {event.location ? ` · ${event.location}` : ''} · Family
          </p>
        </div>
        <button aria-label="Edit event" onClick={() => setEditing(true)} className="p-1 text-neutral-400 hover:text-indigo-500">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z" />
          </svg>
        </button>
        <button
          aria-label="Delete event"
          onClick={() => { if (confirm(`Delete "${event.title}"?`)) startTransition(() => deleteEvent(event.id)); }}
          className="p-1 text-neutral-400 hover:text-red-500"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  const startLocal = torontoParts(event.start_at);
  const durationMin = event.end_at
    ? Math.round((Date.parse(event.end_at) - Date.parse(event.start_at)) / 60_000)
    : 60;

  function submit(fd: FormData) {
    const title = String(fd.get('title') ?? '').trim();
    const date = String(fd.get('date') ?? '');
    if (!title || !date) return;
    const allDay = fd.get('all_day') === 'on';
    const time = String(fd.get('time') ?? '');
    const dur = parseInt(String(fd.get('duration') ?? '60'), 10);
    const startIso = torontoToIso(date, allDay || !time ? '00:00' : time);
    startTransition(async () => {
      await updateEvent(event.id, {
        title,
        start_at: startIso,
        end_at: allDay || !time ? null : new Date(Date.parse(startIso) + dur * 60_000).toISOString(),
        all_day: allDay || !time,
        location: String(fd.get('location') ?? '').trim() || null,
      });
      setEditing(false);
    });
  }

  return (
    <form action={submit} className="rounded-xl border border-indigo-300 dark:border-indigo-700 p-3 flex flex-col gap-2">
      <input name="title" defaultValue={event.title} className="bg-transparent outline-none font-medium" autoComplete="off" />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <input name="date" type="date" defaultValue={startLocal.date} className="bg-transparent border border-neutral-300 dark:border-neutral-700 rounded-md px-2 py-1" />
        <input name="time" type="time" defaultValue={event.all_day ? '' : startLocal.time} className="bg-transparent border border-neutral-300 dark:border-neutral-700 rounded-md px-2 py-1" />
        <select name="duration" defaultValue={String(durationMin)} className="bg-transparent border border-neutral-300 dark:border-neutral-700 rounded-md px-2 py-1 dark:bg-neutral-950">
          {[30, 60, 90, 120, 180, 240].map((m) => (
            <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} hr`}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5">
          <input name="all_day" type="checkbox" defaultChecked={event.all_day} className="accent-indigo-600" />
          <span className="opacity-60">All day</span>
        </label>
      </div>
      <input name="location" defaultValue={event.location ?? ''} placeholder="Location" className="bg-transparent outline-none text-sm" autoComplete="off" />
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={() => setEditing(false)} className="text-sm px-3 py-1.5 opacity-60">Cancel</button>
        <button type="submit" disabled={pending} className="rounded-lg bg-indigo-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function torontoParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, ...opts }).format(d);
  return {
    date: fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: fmt({ hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

function torontoToIso(dateStr: string, timeStr: string): string {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(probe).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +(parts.hour === '24' ? 0 : parts.hour!), +parts.minute!);
  const offsetMin = (asUtc - probe.getTime()) / 60_000;
  return new Date(Date.parse(`${dateStr}T${timeStr}:00Z`) - offsetMin * 60_000).toISOString();
}
