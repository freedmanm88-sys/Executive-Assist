'use client';

import { useRef, useState, useTransition } from 'react';
import { askAssistant } from '@/app/actions';

/**
 * Natural-language quick add, powered by the assistant endpoint (Claude).
 * On phones, the keyboard mic button gives you voice → text for free.
 */
export function QuickAdd() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ reply: string; actions: string[] } | null>(null);
  const ref = useRef<HTMLFormElement>(null);

  return (
    <div className="flex flex-col gap-2">
      <form
        ref={ref}
        action={(fd) => {
          const text = String(fd.get('text') ?? '').trim();
          if (!text) return;
          setResult(null);
          startTransition(async () => {
            try {
              setResult(await askAssistant(text));
              ref.current?.reset();
            } catch {
              setResult({ reply: 'Something went wrong — try again.', actions: [] });
            }
          });
        }}
        className="flex gap-2"
      >
        <input
          name="text"
          placeholder='✨ Try: "add milk to grocery" or "task for Ashley: book dentist Friday"'
          className="flex-1 rounded-xl border border-indigo-300 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/30 px-3 py-2.5 text-sm outline-none placeholder:text-neutral-400"
          autoComplete="off"
          enterKeyHint="send"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-indigo-600 text-white px-4 font-semibold text-sm disabled:opacity-50"
        >
          {pending ? '…' : 'Go'}
        </button>
      </form>
      {pending && <p className="text-xs opacity-60">Thinking…</p>}
      {result && (
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm">
          {result.actions.map((a, i) => (
            <p key={i} className="text-green-600 dark:text-green-400">✓ {a}</p>
          ))}
          {(result.actions.length === 0 || result.reply !== 'Done.') && <p className="opacity-80">{result.reply}</p>}
        </div>
      )}
    </div>
  );
}
