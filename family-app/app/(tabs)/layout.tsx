import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import { BottomNav } from '@/components/nav';

export default async function TabsLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  // Pending-feedback badge for the inbox tab. Non-fatal if the worker is briefly down.
  let pendingCount = 0;
  try {
    const { feed } = await workerFetch<{ feed: unknown[] }>(
      '/family/feed?pending=1&limit=100',
      { userId: session.uid },
    );
    pendingCount = feed.length;
  } catch {
    /* badge is best-effort */
  }

  return (
    <div className="mx-auto w-full max-w-lg flex-1 flex flex-col">
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 py-3 bg-white/95 dark:bg-neutral-950/95 backdrop-blur border-b border-neutral-200 dark:border-neutral-800">
        <span className="font-bold text-lg">🏠 Freedman HQ</span>
        <Link href="/settings" aria-label="Settings" className="text-neutral-500 dark:text-neutral-400 p-1">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a7.723 7.723 0 0 1 0-.255c.007-.378-.138-.75-.43-.991l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        </Link>
      </header>
      <main className="flex-1 px-4 py-4 pb-24">{children}</main>
      <BottomNav pendingCount={pendingCount} />
    </div>
  );
}
