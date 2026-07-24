import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import { fetchAllFeeds, type FeedConfig, type MergedEvent } from '@/lib/ics';
import type { FamilyEvent } from '@/lib/types';
import { dayKey, todayKey, fmtDayLong } from '@/lib/dates';
import { NewEventForm } from '@/components/new-event-form';
import { CalendarList } from '@/components/calendar-list';

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
  const days = [...byDay.keys()].sort().map((key) => {
    const events = byDay.get(key) ?? [];
    return { key, label: events[0] ? fmtDayLong(events[0].start) : key, events };
  });

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
      <CalendarList days={days} familyEvents={familyEvents} today={today} />
    </div>
  );
}
