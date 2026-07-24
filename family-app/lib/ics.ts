/**
 * Google Calendar ICS feed merge.
 *
 * Each family member pastes their calendar's "Secret address in iCal format"
 * (Google Calendar → Settings → <calendar> → Integrate calendar) into the app's
 * Settings page. Feeds are fetched server-side, parsed with node-ical, and
 * recurring events are expanded within the requested window. Read-only by
 * design — creating events in Google Calendar comes later via OAuth.
 */

import 'server-only';
import ical, { type VEvent } from 'node-ical';

export interface FeedConfig {
  name: string;   // 'Mark', 'Ashley'
  url: string;    // secret .ics URL
}

export interface MergedEvent {
  id: string;
  source: string;         // feed name or 'Family'
  title: string;
  location: string | null;
  start: string;          // ISO
  end: string | null;     // ISO
  allDay: boolean;
  editable: boolean;      // true only for family_events rows
}

interface CacheEntry { events: MergedEvent[]; at: number }
const feedCache = new Map<string, CacheEntry>();
const FEED_TTL_MS = 5 * 60 * 1000;

export async function fetchFeedEvents(
  feed: FeedConfig,
  windowStart: Date,
  windowEnd: Date,
): Promise<MergedEvent[]> {
  const cacheKey = `${feed.url}|${windowStart.toISOString().slice(0, 10)}`;
  const hit = feedCache.get(cacheKey);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.events;

  let text: string;
  try {
    const res = await fetch(feed.url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`ics fetch ${res.status}`);
    text = await res.text();
  } catch (err) {
    console.error(`[ics] failed to fetch feed "${feed.name}":`, err);
    return hit?.events ?? [];  // stale-if-error
  }

  const parsed = ical.sync.parseICS(text);
  const events: MergedEvent[] = [];

  for (const key of Object.keys(parsed)) {
    const ev = parsed[key];
    if (!ev || ev.type !== 'VEVENT') continue;

    const allDay = (ev.datetype as string | undefined) === 'date';
    const durationMs =
      ev.end && ev.start ? new Date(ev.end).getTime() - new Date(ev.start).getTime() : 0;

    if (ev.rrule) {
      // Expand recurrences in window; apply EXDATEs and overridden instances.
      const overridden = new Set(
        ev.recurrences ? Object.keys(ev.recurrences) : [],
      );
      const exdates = new Set(
        ev.exdate ? Object.values(ev.exdate).map((d) => new Date(d as unknown as string).toISOString()) : [],
      );
      let occurrences: Date[] = [];
      try {
        occurrences = ev.rrule.between(windowStart, windowEnd, true);
      } catch (err) {
        console.error(`[ics] rrule expansion failed for "${ev.summary}":`, err);
      }
      for (const occ of occurrences) {
        const occIso = occ.toISOString();
        if (exdates.has(occIso)) continue;
        if (overridden.has(occIso.slice(0, 10))) continue; // handled below
        events.push({
          id: `${feed.name}:${ev.uid}:${occIso}`,
          source: feed.name,
          title: String(ev.summary ?? '(no title)'),
          location: ev.location ? String(ev.location) : null,
          start: occIso,
          end: durationMs ? new Date(occ.getTime() + durationMs).toISOString() : null,
          allDay,
          editable: false,
        });
      }
      // Overridden single instances (moved occurrences)
      if (ev.recurrences) {
        for (const r of Object.values(ev.recurrences) as VEvent[]) {
          if (!r.start) continue;
          const s = new Date(r.start);
          if (s < windowStart || s > windowEnd) continue;
          events.push({
            id: `${feed.name}:${ev.uid}:${s.toISOString()}`,
            source: feed.name,
            title: String(r.summary ?? ev.summary ?? '(no title)'),
            location: r.location ? String(r.location) : null,
            start: s.toISOString(),
            end: r.end ? new Date(r.end).toISOString() : null,
            allDay,
            editable: false,
          });
        }
      }
      continue;
    }

    if (!ev.start) continue;
    const s = new Date(ev.start);
    if (s < windowStart || s > windowEnd) continue;
    events.push({
      id: `${feed.name}:${ev.uid ?? key}`,
      source: feed.name,
      title: String(ev.summary ?? '(no title)'),
      location: ev.location ? String(ev.location) : null,
      start: s.toISOString(),
      end: ev.end ? new Date(ev.end).toISOString() : null,
      allDay,
      editable: false,
    });
  }

  feedCache.set(cacheKey, { events, at: Date.now() });
  return events;
}

export async function fetchAllFeeds(
  feeds: FeedConfig[],
  windowStart: Date,
  windowEnd: Date,
): Promise<MergedEvent[]> {
  const results = await Promise.all(
    feeds
      .filter((f) => f.url && f.url.startsWith('http'))
      .map((f) => fetchFeedEvents(f, windowStart, windowEnd)),
  );
  return results.flat();
}
