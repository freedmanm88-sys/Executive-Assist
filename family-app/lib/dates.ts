/**
 * Toronto-timezone date formatting. Vercel servers run in UTC, so every
 * user-facing date/time must be formatted with an explicit timeZone.
 */

export const TZ = 'America/Toronto';

export function fmtTime(d: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(d));
}

export function fmtDayLong(d: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date(d));
}

export function fmtDayShort(d: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(d));
}

/** YYYY-MM-DD in Toronto — used as a grouping key. */
export function dayKey(d: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(d));
}

export function todayKey(): string {
  return dayKey(new Date());
}

export function isOverdue(due: string | null): boolean {
  if (!due) return false;
  return dayKey(due) < todayKey();
}

export function relativeDay(d: Date | string): string {
  const key = dayKey(d);
  const today = todayKey();
  if (key === today) return 'Today';
  const tomorrow = dayKey(new Date(Date.now() + 86400_000));
  if (key === tomorrow) return 'Tomorrow';
  const yesterday = dayKey(new Date(Date.now() - 86400_000));
  if (key === yesterday) return 'Yesterday';
  return fmtDayShort(d);
}
