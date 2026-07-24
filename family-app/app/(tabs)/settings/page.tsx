import { requireSession } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import type { FeedConfig } from '@/lib/ics';
import { IcsFeedsForm } from '@/components/ics-feeds-form';
import { LogoutButton } from '@/components/logout-button';
import { PushToggle } from '@/components/push-toggle';
import { ChangePinForm } from '@/components/change-pin-form';
import { CategoriesForm } from '@/components/categories-form';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requireSession();
  const { settings } = await workerFetch<{ settings: Record<string, unknown> }>(
    '/family/settings',
    { userId: session.uid },
  );
  const feeds = (settings['ics_feeds'] as FeedConfig[] | undefined) ?? [];
  const categories = Array.isArray(settings['task_categories'])
    ? (settings['task_categories'] as string[])
    : [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold">Settings</h1>

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
