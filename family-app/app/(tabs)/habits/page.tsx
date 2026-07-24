import { requireSession } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import type { FamilyHabit } from '@/lib/types';
import { HabitsView } from '@/components/habits-view';

export const dynamic = 'force-dynamic';

export default async function HabitsPage() {
  const session = await requireSession();
  const { habits } = await workerFetch<{ habits: FamilyHabit[] }>('/family/habits', {
    userId: session.uid,
  });

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Habits</h1>
      <p className="text-xs opacity-60 -mt-2">
        Check in daily. You can see each other&apos;s progress — that&apos;s the point. 💪
      </p>
      <HabitsView habits={habits} myUserId={session.uid} />
    </div>
  );
}
