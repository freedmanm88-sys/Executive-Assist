import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import { fetchAllFeeds, type FeedConfig, type MergedEvent } from '@/lib/ics';
import type { FamilyEvent } from '@/lib/types';
import { dayKey, todayKey, fmtDayLong, fmtTime } from '@/lib/dates';
import { NewEventForm } from '@/components/new-event-form';
import { DeleteEventButton } from '@/components/delete-event-button';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 45;

export default async function CalendarPage() {
  const session = await requireSession();
  const windowStart = new Date(Date.now() - 86400_000); // include today regardless of TZ math
  const windowEnd = new Date(Date.now() + WINDOW_DAYS * 86400_000);

  const [{ events: familyEvents }, { settings }] = await Promise.all([
    workerFetch<{ events: FamilyEvent[] }>(
      `/family/events?from=${windowStart.toISOString()}&to=${windowEnd.toISOString()}`,
      { userId: session.uid },
    ),
    workerFetch<{ settings: Record<string, unknown> }>('/family/settings', { userId: session.uid }),
  ]);

  const feeds = (settings['ics_feeds'] as FeedConfig[] | undefined) ?? [];
  const feedEvents = await fetchAllFeeds(feeds, windowStart, windowEnd);

  const merged: MergedEvent[] = [
    ...familyEvents.map((e) => ({
      id: e.id,
      source: 'Family',
      title: e.title,
      location: e.location,
      start: e.start_at,
      end: e.end_at,
      allDay: e.all_day,
      editable: true,
    })),
    ...feedEvents,
  ].sort((a, b) => a.start.localeCompare(b.start));

  const today = todayKey();
  const byDay = new Map<string, MergedEvent[]>();
  for (const ev of merged) {
    const key = dayKey(ev.start);
    if (key < today) continue;
    const arr = byDay.get(key) ?? [];
    arr.push(ev);
    byDay.set(key, arr);
  }
  const days = [...byDay.keys()].sort();

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Calendar</h1>
      <NewEventForm />
      {feeds.length === 0 && (
        <p className="text-sm rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
          No Google Calendars connected yet — add your secret ICS links in{' '}
          <Link href="/settings" className="underline font-medium">Settings</Link>{' '}
          to see them here.
        </p>
      )}
      {days.length === 0 && <p className="text-sm opacity-60 py-4 text-center">Nothing coming up.</p>}
      {days.map((key) => {
        const events = byDay.get(key) ?? [];
        const first = events[0];
        return (
          <section key={key}>
            <h2 className={`text-sm font-bold mb-1.5 ${key === today ? 'text-indigo-500' : 'opacity-70'}`}>
              {key === today ? 'Today — ' : ''}{first ? fmtDayLong(first.start) : key}
            </h2>
            <div className="flex flex-col gap-1.5">
              {events.map((ev) => (
                <div
                  key={ev.id}
                  className="flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2"
                >
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                      ev.source === 'Family'
                        ? 'bg-indigo-500'
                        : ev.source.toLowerCase().startsWith('mark')
                          ? 'bg-emerald-500'
                          : 'bg-pink-500'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{ev.title}</p>
                    <p className="text-xs opacity-60">
                      {ev.allDay ? 'All day' : `${fmtTime(ev.start)}${ev.end ? `–${fmtTime(ev.end)}` : ''}`}
                      {ev.location ? ` · ${ev.location}` : ''}
                      {` · ${ev.source}`}
                    </p>
                  </div>
                  {ev.editable && <DeleteEventButton id={ev.id} title={ev.title} />}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
