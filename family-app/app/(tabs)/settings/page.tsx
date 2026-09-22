import { requireSession } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import type { FeedConfig } from '@/lib/ics';
import { IcsFeedsForm } from '@/components/ics-feeds-form';
import { LogoutButton } from '@/components/logout-button';
import { PushToggle } from '@/components/push-toggle';
import { ChangePinForm } from '@/components/change-pin-form';
import { CategoriesForm } from '@/components/categories-form';
import { GmailAccounts } from '@/components/gmail-accounts';
import type { GmailAccountStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const [{ settings }, gmail] = await Promise.all([
    workerFetch<{ settings: Record<string, unknown> }>('/family/settings', { userId: session.uid }),
    workerFetch<{ accounts: GmailAccountStatus[] }>('/family/gmail/accounts', { userId: session.uid })
      .catch(() => ({ accounts: [] as GmailAccountStatus[] })),
  ]);
  const feeds = (settings['ics_feeds'] as FeedConfig[] | undefined) ?? [];
  const categories = Array.isArray(settings['task_categories'])
    ? (settings['task_categories'] as string[])
    : [];

  // Bounce-back notice from the worker's OAuth callback (?gmail=connected|error)
  const gmailNotice =
    sp['gmail'] === 'connected' ? `Connected ${String(sp['account'] ?? '')} — first sync runs within 2 minutes.`
    : sp['gmail'] === 'error' ? `Couldn't connect: ${String(sp['reason'] ?? 'unknown error')}.`
    : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold">Settings</h1>

      {gmail.accounts.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">Email accounts</h2>
          <p className="text-sm opacity-70">
            The assistant reads these inboxes directly. Connect each one once; reconnect if it shows an error.
          </p>
          <GmailAccounts accounts={gmail.accounts} notice={gmailNotice} />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Google Calendars</h2>
        <p className="text-sm opacity-70">
          Paste each calendar&apos;s <b>secret iCal address</b>: Google Calendar →
          ⚙ Settings → pick the calendar → “Integrate calendar” → <i>Secret address
          in iCal format</i>. Events show up read-only in the app within ~5 minutes.
        </p>
        <IcsFeedsForm initial={feeds} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Task categories</h2>
        <p className="text-sm opacity-70">Used to tag and filter tasks (Family, Logan, Jackson…). Edit freely.</p>
        <CategoriesForm initial={categories} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Notifications</h2>
        <p className="text-sm opacity-70">
          Get urgent-email alerts, the morning digest, and reminders as real
          notifications on this device.
        </p>
        <PushToggle />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Signed in as</h2>
        <p className="text-sm opacity-70">{session.name}</p>
        <ChangePinForm />
        <LogoutButton />
      </section>
    </div>
  );
}
