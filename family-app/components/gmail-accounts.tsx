'use client';

import { useTransition } from 'react';
import { getGmailConnectUrl } from '@/app/actions';
import type { GmailAccountStatus } from '@/lib/types';
import { relativeDay, fmtTime } from '@/lib/dates';

/** Settings → Email accounts: connect / reconnect each Gmail inbox (ADR 0005). */
export function GmailAccounts({ accounts, notice }: { accounts: GmailAccountStatus[]; notice: string | null }) {
  const [pending, startTransition] = useTransition();

  function connect(label: string) {
    startTransition(async () => {
      const url = await getGmailConnectUrl(label);
      window.location.href = url;   // off to Google; the worker bounces us back here
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {notice && (
        <p className={`text-sm rounded-lg px-3 py-2 ${notice.startsWith('Connected') ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-600 dark:text-red-400'}`}>
          {notice}
        </p>
      )}
      {accounts.map((a) => (
        <div key={a.label} className="flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${a.error ? 'bg-red-500' : a.connected ? 'bg-green-500' : 'bg-neutral-400'}`} />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{a.address}</p>
            <p className="text-xs opacity-60 truncate">
              {a.error
                ? `Needs reconnect — ${a.error}`
                : a.connected
                  ? a.last_synced_at ? `Synced ${relativeDay(a.last_synced_at)} ${fmtTime(a.last_synced_at)}` : 'Connected — first sync within 2 min'
                  : 'Not connected'}
            </p>
          </div>
          <button
            onClick={() => connect(a.label)}
            disabled={pending}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${
              a.connected && !a.error ? 'border border-neutral-300 dark:border-neutral-700' : 'bg-indigo-600 text-white'
            }`}
          >
            {a.connected && !a.error ? 'Reconnect' : 'Connect'}
          </button>
        </div>
      ))}
      <p className="text-xs opacity-60">
        Each connect opens Google&apos;s consent screen for that inbox. Tokens are stored encrypted on the worker; nothing goes through n8n anymore.
      </p>
    </div>
  );
}
