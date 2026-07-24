import { requireSession } from '@/lib/auth';
import { workerFetch, getUsers } from '@/lib/worker';
import type { FamilyTask } from '@/lib/types';
import { TaskRow } from '@/components/task-row';
import { NewTaskForm } from '@/components/new-task-form';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const session = await requireSession();
  const [{ tasks }, users] = await Promise.all([
    workerFetch<{ tasks: FamilyTask[] }>('/family/tasks?status=all', { userId: session.uid }),
    getUsers(),
  ]);

  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done').slice(0, 20);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Tasks</h1>
      <NewTaskForm users={users.map((u) => ({ id: u.id, name: u.name }))} />
      <section className="flex flex-col gap-2">
        {open.length === 0 && (
          <p className="text-sm opacity-60 py-4 text-center">Nothing open. Enjoy it while it lasts. 🎉</p>
        )}
        {open.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </section>
      {done.length > 0 && (
        <details className="mt-2">
          <summary className="text-sm font-medium opacity-60 cursor-pointer">
            Done ({done.length})
          </summary>
          <div className="flex flex-col gap-2 mt-2">
            {done.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
