import { requireSession } from '@/lib/auth';
import { workerFetch, getUsers } from '@/lib/worker';
import type { FamilyList, FamilyListItem, ItemComment } from '@/lib/types';
import { ListsView } from '@/components/lists-view';

export const dynamic = 'force-dynamic';

export default async function ListsPage() {
  const session = await requireSession();
  const [data, users] = await Promise.all([
    workerFetch<{
      lists: FamilyList[];
      items: FamilyListItem[];
      comments: ItemComment[];
    }>('/family/lists', { userId: session.uid }),
    getUsers(),
  ]);

  return (
    <ListsView
      lists={data.lists}
      items={data.items}
      comments={data.comments}
      users={users.map((u) => ({ id: u.id, name: u.name }))}
      myUserId={session.uid}
    />
  );
}
