import { requireSession } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import type { FeedItem } from '@/lib/types';
import { InboxView } from '@/components/inbox-view';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const session = await requireSession();
  const { feed } = await workerFetch<{ feed: FeedItem[] }>('/family/feed?limit=60', {
    userId: session.uid,
  });

  return <InboxView feed={feed} />;
}
