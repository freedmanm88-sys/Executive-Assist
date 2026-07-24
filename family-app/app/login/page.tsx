'use client';

// Client component: interactive user picker + PIN pad state.

import { useActionState, useState } from 'react';
import { login } from './actions';

const USERS = [
  { email: 'freedman.m88@gmail.com', name: 'Mark', emoji: '👨🏻' },
  { email: 'awronzberg@gmail.com', name: 'Ashley', emoji: '👩🏻' },
];

export default function LoginPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(login, null);

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <div className="text-5xl mb-2">🏠</div>
        <h1 className="text-2xl font-bold">Freedman HQ</h1>
        <p className="text-sm opacity-60 mt-1">Who&apos;s this?</p>
      </div>

      <div className="flex gap-4">
        {USERS.map((u) => (
          <button
            key={u.email}
            onClick={() => setSelected(u.email)}
            className={`flex flex-col items-center gap-2 rounded-2xl px-8 py-6 border-2 transition
              ${selected === u.email
                ? 'border-indigo-500 bg-indigo-500/10'
                : 'border-neutral-300 dark:border-neutral-700'}`}
          >
            <span className="text-4xl">{u.emoji}</span>
            <span className="font-semibold">{u.name}</span>
          </button>
        ))}
      </div>

      {selected && (
        <form action={formAction} className="flex flex-col items-center gap-3 w-full max-w-xs">
          <input type="hidden" name="email" value={selected} />
          <input
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="PIN"
            autoFocus
            className="w-40 text-center text-2xl tracking-widest rounded-xl border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-3"
          />
          {state?.error && <p className="text-sm text-red-500">{state.error}</p>}
          <button
            type="submit"
            disabled={pending}
            className="w-40 rounded-xl bg-indigo-600 text-white font-semibold py-3 disabled:opacity-50"
          >
            {pending ? '…' : 'Enter'}
          </button>
        </form>
      )}
    </main>
  );
}
