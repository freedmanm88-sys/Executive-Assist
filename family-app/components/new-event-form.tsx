'use client';

import { useRef, useState, useTransition } from 'react';
import { createEvent } from '@/app/actions';
import { TZ } from '@/lib/dates';

export function NewEventForm() {
  const [open, setOpen] = useState(false);
  const [allDay, setAllDay] = useState(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLFormElement>(null);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 py-2.5 text-sm font-medium opacity-70"
      >
        + Add family event
      </button>
    );
  }

  function submit(fd: FormData) {
    const title = String(fd.get('title') ?? '').trim();
    const date = String(fd.get('date') ?? '');
    if (!title || !date) return;
    const time = String(fd.get('time') ?? '');
    const durationMin = parseInt(String(fd.get('duration') ?? '60'), 10);
    const startIso = torontoToIso(date, allDay || !time ? '00:00' : time);
    const endIso = allDay || !time ? null : new Date(Date.parse(startIso) + durationMin * 60_000).toISOString();
    startTransition(async () => {
      await createEvent({
        title,
        start_at: startIso,
        end_at: endIso,
        all_day: allDay || !time,
        location: String(fd.get('location') ?? '').trim() || null,
        notes: String(fd.get('notes') ?? '').trim() || null,
      });
      ref.current?.reset();
      setOpen(false);
      setAllDay(false);
    });
  }

  return (
    <form ref={ref} action={submit} className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 flex flex-col gap-2">
      <input name="title" placeholder="Event title" autoFocus className="bg-transparent outline-none font-medium" autoComplete="off" />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <input name="date" type="date" className="bg-transparent border border-neutral-300 dark:border-neutral-700 rounded-md px-2 py-1" />
        {!allDay && (
          <>
            <input name="time" type="time" className="bg-transparent border border-neutral-300 dark:border-neutral-700 rounded-md px-2 py-1" />
            <select name="duration" defaultValue="60" className="bg-transparent border border-neutral-300 dark:border-neutral-700 rounded-md px-2 py-1 dark:bg-neutral-950">
              <option value="30">30 min</option>
              <option value="60">1 hr</option>
              <option value="90">1.5 hr</option>
              <option value="120">2 hr</option>
              <option value="180">3 hr</option>
              <option value="240">4 hr</option>
            </select>
          </>
        )}
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-indigo-600" />
          <span className="opacity-60">All day</span>
        </label>
      </div>
      <input name="location" placeholder="Location (optional)" className="bg-transparent outline-none text-sm" autoComplete="off" />
      <input name="notes" placeholder="Notes (optional)" className="bg-transparent outline-none text-sm" autoComplete="off" />
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={() => setOpen(false)} className="text-sm px-3 py-1.5 opacity-60">
          Cancel
        </button>
        <button type="submit" disabled={pending} className="rounded-lg bg-indigo-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/** Toronto-local date+time → UTC ISO (DST-aware). */
function torontoToIso(dateStr: string, timeStr: string): string {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(probe).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +(parts.hour === '24' ? 0 : parts.hour!), +parts.minute!);
  const offsetMin = (asUtc - probe.getTime()) / 60_000;
  const utcMs = Date.parse(`${dateStr}T${timeStr}:00Z`) - offsetMin * 60_000;
  return new Date(utcMs).toISOString();
}
