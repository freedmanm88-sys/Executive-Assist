'use client';

import { useRef, useState, useTransition } from 'react';
import { createTask } from '@/app/actions';
import { TZ } from '@/lib/dates';

export function NewTaskForm({ users }: { users: { id: string; name: string }[] }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function submit(formData: FormData) {
    const title = String(formData.get('title') ?? '').trim();
    if (!title) return;
    const dueDate = String(formData.get('due') ?? '');
    const assigned = String(formData.get('assigned') ?? '');
    const high = formData.get('high') === 'on';
    startTransition(async () => {
      await createTask({
        title,
        notes: String(formData.get('notes') ?? '').trim() || undefined,
        // due date entered as Toronto-local date → store as 11:59 PM Toronto.
        due_at: dueDate ? torontoEndOfDay(dueDate) : null,
        assigned_to: assigned || null,
        priority: high ? 1 : 3,
      });
      formRef.current?.reset();
      setExpanded(false);
    });
  }

  return (
    <form ref={formRef} action={submit} className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          name="title"
          placeholder="Add a task…"
          onFocus={() => setExpanded(true)}
          className="flex-1 bg-transparent outline-none placeholder:text-neutral-400"
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-indigo-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-2 pt-1 border-t border-neutral-200 dark:border-neutral-800">
          <input name="notes" placeholder="Notes (optional)" className="bg-transparent outline-none text-sm" autoComplete="off" />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="opacity-60">Due</span>
              <input name="due" type="date" className="bg-transparent border border-neutral-300 dark:border-neutral-700 rounded-md px-2 py-1" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="opacity-60">For</span>
              <select name="assigned" className="bg-transparent border border-neutral-300 dark:border-neutral-700 rounded-md px-2 py-1 dark:bg-neutral-950">
                <option value="">Anyone</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input name="high" type="checkbox" className="accent-orange-500" />
              <span className="opacity-60">High priority</span>
            </label>
          </div>
        </div>
      )}
    </form>
  );
}

/** '2026-07-24' → ISO instant for 23:59 Toronto that day. */
function torontoEndOfDay(dateStr: string): string {
  // Determine Toronto's UTC offset on that date (handles DST).
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const offsetMin = tzOffsetMinutes(probe);
  const utcMs = Date.parse(`${dateStr}T23:59:00Z`) - offsetMin * 60_000;
  return new Date(utcMs).toISOString();
}

function tzOffsetMinutes(at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +(parts.hour === '24' ? 0 : parts.hour!), +parts.minute!);
  return (asUtc - at.getTime()) / 60_000;
}
