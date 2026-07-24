'use client';

import { useState } from 'react';
import type { MergedEvent } from '@/lib/ics';
import type { FamilyEvent } from '@/lib/types';
import { fmtTime } from '@/lib/dates';
import { EditableEvent } from './editable-event';

/** Day-grouped agenda with a source filter (Family / Mark / Ashley). */
export function CalendarList({
  days,
  familyEvents,
  today,
}: {
  days: { key: string; label: string; events: MergedEvent[] }[];
  familyEvents: FamilyEvent[];
  today: string;
}) {
  const sources = [...new Set(days.flatMap((d) => d.events.map((e) => e.source)))];
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const familyById = new Map(familyEvents.map((e) => [e.id, e]));

  const shown = days
    .map((d) => ({
      ...d,
      events: sourceFilter ? d.events.filter((e) => e.source === sourceFilter) : d.events,
    }))
    .filter((d) => d.events.length > 0);

  return (
    <div className="flex flex-col gap-4">
      {sources.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          <FilterChip active={sourceFilter === null} onClick={() => setSourceFilter(null)}>All</FilterChip>
          {sources.map((s) => (
            <FilterChip key={s} active={sourceFilter === s} onClick={() => setSourceFilter(sourceFilter === s ? null : s)}>
              <span className={`inline-block h-2 w-2 rounded-full mr-1.5 ${dotClass(s)}`} />
              {s}
            </FilterChip>
          ))}
        </div>
      )}
      {shown.length === 0 && <p className="text-sm opacity-60 py-4 text-center">Nothing coming up.</p>}
      {shown.map((day) => (
        <section key={day.key}>
          <h2 className={`text-sm font-bold mb-1.5 ${day.key === today ? 'text-indigo-500' : 'opacity-70'}`}>
            {day.key === today ? 'Today — ' : ''}{day.label}
          </h2>
          <div className="flex flex-col gap-1.5">
            {day.events.map((ev) => {
              const familyEvent = ev.editable ? familyById.get(ev.id) : undefined;
              if (familyEvent) return <EditableEvent key={ev.id} event={familyEvent} />;
              return (
                <div key={ev.id} className="flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass(ev.source)}`} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{ev.title}</p>
                    <p className="text-xs opacity-60">
                      {ev.allDay ? 'All day' : `${fmtTime(ev.start)}${ev.end ? `–${fmtTime(ev.end)}` : ''}`}
                      {ev.location ? ` · ${ev.location}` : ''}
                      {` · ${ev.source}`}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function dotClass(source: string): string {
  if (source === 'Family') return 'bg-indigo-500';
  return source.toLowerCase().startsWith('mark') ? 'bg-emerald-500' : 'bg-pink-500';
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium border inline-flex items-center ${
        active
          ? 'bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900 border-transparent'
          : 'border-neutral-300 dark:border-neutral-700'
      }`}
    >
      {children}
    </button>
  );
}
