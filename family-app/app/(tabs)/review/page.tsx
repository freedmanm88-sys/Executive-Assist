import { requireSession } from '@/lib/auth';
import { workerFetch, getUsers } from '@/lib/worker';
import type { ReviewCard } from '@/lib/types';
import { ReviewDeck } from '@/components/review-deck';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const session = await requireSession();
  const [{ cards }, users] = await Promise.all([
    workerFetch<{ cards: ReviewCard[] }>('/family/review?limit=40', { userId: session.uid }),
    getUsers(),
  ]);

  return (
    <ReviewDeck
      cards={cards}
      users={users.map((u) => ({ id: u.id, name: u.name }))}
      myUserId={session.uid}
    />
  );
}
