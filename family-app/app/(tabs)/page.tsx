import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { workerFetch, getUsers } from '@/lib/worker';
import { fetchAllFeeds, type FeedConfig, type MergedEvent } from '@/lib/ics';
import type { FamilyTask, FamilyEvent, FamilyListItem, FamilyList, FeedItem, FamilyHabit, FamilyProposal } from '@/lib/types';
import { Proposals } from '@/components/proposals';
import { dayKey, todayKey, fmtTime, isOverdue } from '@/lib/dates';
import { HomeHabits } from '@/components/home-habits';
import { QuickAdd } from '@/components/quick-add';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await requireSession();
  const now = new Date();
  const in2days = new Date(Date.now() + 2 * 86400_000);

  const [{ tasks }, { events }, listsData, { feed }, { settings }, { habits }, { proposals }, users] = await Promise.all([
    workerFetch<{ tasks: FamilyTask[] }>('/family/tasks?status=open', { userId: session.uid }),
    workerFetch<{ events: FamilyEvent[] }>(
      `/family/events?from=${now.toISOString()}&to=${in2days.toISOString()}`,
      { userId: session.uid },
    ),
    workerFetch<{ lists: FamilyList[]; items: FamilyListItem[] }>('/family/lists', { userId: session.uid }),
    workerFetch<{ feed: FeedItem[] }>('/family/feed?pending=1&actionable=1&limit=100', { userId: session.uid }),
    workerFetch<{ settings: Record<string, unknown> }>('/family/settings', { userId: session.uid }),
    workerFetch<{ habits: FamilyHabit[] }>('/family/habits', { userId: session.uid }),
    workerFetch<{ proposals: FamilyProposal[] }>('/family/proposals', { userId: session.uid }),
    getUsers(),
  ]);

  const feeds = (settings['ics_feeds'] as FeedConfig[] | undefined) ?? [];
  const feedEvents = await fetchAllFeeds(feeds, now, in2days);

  const today = todayKey();
  const todayEvents: MergedEvent[] = [
    ...events.map((e) => ({
      id: e.id, source: 'Family', title: e.title, location: e.location,
      start: e.start_at, end: e.end_at, allDay: e.all_day, editable: true,
    })),
    ...feedEvents,
  ]
    .filter((e) => dayKey(e.start) === today)
    .sort((a, b) => a.start.localeCompare(b.start));

  const dueTasks = tasks.filter((t) => t.due_at && dayKey(t.due_at) <= today);
  const groceryOutstanding = listsData.items.filter((i) => !i.done).length;
  const hour = Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }).format(now),
  );
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold">{greeting}, {session.name}</h1>
        <p className="text-sm opacity-60">
          {new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Toronto', weekday: 'long', month: 'long', day: 'numeric',
          }).format(now)}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <StatCard href="/tasks" label="Tasks open" value={tasks.length} alert={dueTasks.length > 0} />
        <StatCard href="/lists" label="List items" value={groceryOutstanding} />
        <StatCard href="/inbox" label="To review" value={feed.length} alert={feed.length > 0} />
      </div>

      <QuickAdd />

      <Proposals
        proposals={proposals.filter((p) => p.status === 'pending')}
        users={users.map((u) => ({ id: u.id, name: u.name }))}
        myUserId={session.uid}
      />

      <HomeHabits habits={habits} myUserId={session.uid} />

      <section>
        <h2 className="text-sm font-bold opacity-70 mb-1.5">Today</h2>
        {todayEvents.length === 0 ? (
          <p className="text-sm opacity-60">No events today.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {todayEvents.map((ev) => (
              <div key={ev.id} className="flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  ev.source === 'Family' ? 'bg-indigo-500'
                    : ev.source.toLowerCase().startsWith('mark') ? 'bg-emerald-500' : 'bg-pink-500'
                }`} />
                <div className="min-w-0">
                  <p className="font-medium truncate">{ev.title}</p>
                  <p className="text-xs opacity-60">
                    {ev.allDay ? 'All day' : fmtTime(ev.start)}{ev.location ? ` · ${ev.location}` : ''} · {ev.source}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {dueTasks.length > 0 && (
        <section>
          <h2 className="text-sm font-bold opacity-70 mb-1.5">Due</h2>
          <div className="flex flex-col gap-1.5">
            {dueTasks.slice(0, 5).map((t) => (
              <Link key={t.id} href="/tasks" className="flex items-center gap-2 rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2">
                <span className={`text-sm ${isOverdue(t.due_at) ? 'text-red-500' : ''}`}>
                  {isOverdue(t.due_at) ? '⚠' : '•'}
                </span>
                <span className="font-medium text-sm">{t.title}</span>
                {t.assigned_to_name && <span className="text-xs opacity-60 ml-auto">→ {t.assigned_to_name}</span>}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StatCard({ href, label, value, alert }: { href: string; label: string; value: number; alert?: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-xl border px-3 py-2.5 text-center ${
        alert ? 'border-indigo-400 dark:border-indigo-600' : 'border-neutral-200 dark:border-neutral-800'
      }`}
    >
      <p className={`text-2xl font-bold ${alert ? 'text-indigo-600 dark:text-indigo-400' : ''}`}>{value}</p>
      <p className="text-[11px] opacity-60 leading-tight">{label}</p>
    </Link>
  );
}
