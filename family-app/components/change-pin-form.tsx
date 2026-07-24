'use client';

import { useRef, useState, useTransition } from 'react';
import { changePin } from '@/app/actions';

export function ChangePinForm() {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLFormElement>(null);

  if (!open) {
    return (
      <div className="flex flex-col gap-1.5">
        <button
          onClick={() => setOpen(true)}
          className="self-start rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-sm font-medium"
        >
          Change PIN
        </button>
        {msg && <p className={`text-sm ${msg.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg.text}</p>}
      </div>
    );
  }

  return (
    <form
      ref={ref}
      action={(fd) => {
        const current = String(fd.get('current') ?? '');
        const next = String(fd.get('next') ?? '');
        const confirm = String(fd.get('confirm') ?? '');
        if (next !== confirm) {
          setMsg({ text: 'New PINs don’t match.', ok: false });
          return;
        }
        startTransition(async () => {
          const res = await changePin(current, next);
          if (res.error) {
            setMsg({ text: res.error, ok: false });
          } else {
            setMsg({ text: 'PIN updated — use it next time you log in.', ok: true });
            ref.current?.reset();
            setOpen(false);
          }
        });
      }}
      className="flex flex-col gap-2 max-w-xs"
    >
      {(['current', 'next', 'confirm'] as const).map((field) => (
        <input
          key={field}
          name={field}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          placeholder={field === 'current' ? 'Current PIN' : field === 'next' ? 'New PIN (4–12 digits)' : 'Confirm new PIN'}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
        />
      ))}
      <div className="flex gap-2">
        <button type="button" onClick={() => setOpen(false)} className="text-sm px-3 py-1.5 opacity-60">Cancel</button>
        <button type="submit" disabled={pending} className="rounded-lg bg-indigo-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
          {pending ? 'Saving…' : 'Save PIN'}
        </button>
      </div>
      {msg && <p className={`text-sm ${msg.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg.text}</p>}
    </form>
  );
}
