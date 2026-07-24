import { requireSession } from '@/lib/auth';
import { workerFetch, getUsers } from '@/lib/worker';
import type { FamilyTask } from '@/lib/types';
import { TasksView } from '@/components/tasks-view';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const session = await requireSession();
  const [{ tasks }, users, { settings }] = await Promise.all([
    workerFetch<{ tasks: FamilyTask[] }>('/family/tasks?status=all', { userId: session.uid }),
    getUsers(),
    workerFetch<{ settings: Record<string, unknown> }>('/family/settings', { userId: session.uid }),
  ]);
  const categories = Array.isArray(settings['task_categories'])
    ? (settings['task_categories'] as string[])
    : [];

  return (
    <TasksView
      tasks={tasks}
      users={users.map((u) => ({ id: u.id, name: u.name }))}
      categories={categories}
      myUserId={session.uid}
    />
  );
}
