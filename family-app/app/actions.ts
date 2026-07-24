'use server';

/**
 * All mutations. Every action re-derives the acting user from the signed
 * session cookie — the client never supplies a user id.
 */

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';

// ---------- Tasks ------------------------------------------------------------

export async function createTask(input: {
  title: string;
  notes?: string;
  assigned_to?: string | null;
  due_at?: string | null;
  priority?: number;
  category?: string | null;
}): Promise<void> {
  const s = await requireSession();
  await workerFetch('/family/tasks', { method: 'POST', userId: s.uid, body: input });
  revalidatePath('/tasks');
  revalidatePath('/');
}

export async function toggleTask(id: string, done: boolean): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/tasks/${id}`, {
    method: 'PATCH',
    userId: s.uid,
    body: { status: done ? 'done' : 'open' },
  });
  revalidatePath('/tasks');
  revalidatePath('/');
}

export async function deleteTask(id: string): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/tasks/${id}`, { method: 'DELETE', userId: s.uid });
  revalidatePath('/tasks');
}

// ---------- Lists ------------------------------------------------------------

export async function createList(name: string, kind: 'shopping' | 'todo' | 'custom'): Promise<void> {
  const s = await requireSession();
  await workerFetch('/family/lists', { method: 'POST', userId: s.uid, body: { name, kind } });
  revalidatePath('/lists');
}

export async function addListItem(listId: string, text: string, note?: string): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/lists/${listId}/items`, {
    method: 'POST',
    userId: s.uid,
    body: { text, note: note || null },
  });
  revalidatePath('/lists');
  revalidatePath('/');
}

export async function toggleListItem(itemId: string, done: boolean): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/items/${itemId}`, { method: 'PATCH', userId: s.uid, body: { done } });
  revalidatePath('/lists');
  revalidatePath('/');
}

export async function deleteListItem(itemId: string): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/items/${itemId}`, { method: 'DELETE', userId: s.uid });
  revalidatePath('/lists');
}

export async function addItemComment(itemId: string, body: string): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/items/${itemId}/comments`, {
    method: 'POST',
    userId: s.uid,
    body: { body },
  });
  revalidatePath('/lists');
}

// ---------- Events -----------------------------------------------------------

export async function createEvent(input: {
  title: string;
  start_at: string;
  end_at?: string | null;
  all_day?: boolean;
  location?: string | null;
  notes?: string | null;
}): Promise<void> {
  const s = await requireSession();
  await workerFetch('/family/events', { method: 'POST', userId: s.uid, body: input });
  revalidatePath('/calendar');
  revalidatePath('/');
}

export async function updateEvent(
  id: string,
  input: {
    title?: string;
    start_at?: string;
    end_at?: string | null;
    all_day?: boolean;
    location?: string | null;
    notes?: string | null;
  },
): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/events/${id}`, { method: 'PATCH', userId: s.uid, body: input });
  revalidatePath('/calendar');
  revalidatePath('/');
}

export async function deleteEvent(id: string): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/events/${id}`, { method: 'DELETE', userId: s.uid });
  revalidatePath('/calendar');
  revalidatePath('/');
}

// ---------- Habits -----------------------------------------------------------

export async function toggleHabit(habitId: string): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/habits/${habitId}/toggle`, { method: 'POST', userId: s.uid });
  revalidatePath('/habits');
  revalidatePath('/');
}

export async function createHabit(name: string, targetPerWeek: number): Promise<void> {
  const s = await requireSession();
  await workerFetch('/family/habits', {
    method: 'POST',
    userId: s.uid,
    body: { name, target_per_week: targetPerWeek, shared: true },
  });
  revalidatePath('/habits');
  revalidatePath('/');
}

export async function archiveHabit(habitId: string): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/habits/${habitId}`, { method: 'DELETE', userId: s.uid });
  revalidatePath('/habits');
  revalidatePath('/');
}

// ---------- Email proposals --------------------------------------------------

export async function resolveProposal(
  id: string,
  action: 'accept' | 'dismiss',
  assignedTo: string | null,
): Promise<void> {
  const s = await requireSession();
  await workerFetch(`/family/proposals/${id}/resolve`, {
    method: 'POST',
    userId: s.uid,
    body: { action, assigned_to: assignedTo },
  });
  revalidatePath('/');
  revalidatePath('/tasks');
  revalidatePath('/calendar');
}

// ---------- Triage feedback --------------------------------------------------

export interface FeedbackResult {
  status: string;
  feedback: string;
  parsed?: {
    user_assessment: string;
    corrected_classification?: string;
    corrected_urgency?: number;
    reason: string;
    pattern_hint?: string;
  };
}

export async function sendFeedback(
  decisionId: string,
  action: 'correct' | 'wrong' | 'adjust',
  note?: string,
): Promise<FeedbackResult> {
  const s = await requireSession();
  const result = await workerFetch<FeedbackResult>('/family/feedback', {
    method: 'POST',
    userId: s.uid,
    body: { decision_id: decisionId, action, ...(note ? { note } : {}) },
  });
  revalidatePath('/inbox');
  revalidatePath('/');
  return result;
}

export async function saveTaskCategories(categories: string[]): Promise<void> {
  const s = await requireSession();
  await workerFetch('/family/settings', {
    method: 'PUT',
    userId: s.uid,
    body: { task_categories: categories.map((c) => c.trim()).filter(Boolean).slice(0, 20) },
  });
  revalidatePath('/tasks');
  revalidatePath('/settings');
}

// ---------- PIN change -------------------------------------------------------

export async function changePin(
  currentPin: string,
  newPin: string,
): Promise<{ error?: string; ok?: boolean }> {
  const s = await requireSession();
  if (!/^\d{4,12}$/.test(newPin)) return { error: 'New PIN must be 4–12 digits.' };

  const { result } = await workerFetch<{ result: 'ok' | 'wrong' | 'no_pin_set' }>(
    '/family/pin/verify',
    { method: 'POST', userId: s.uid, body: { pin: currentPin } },
  );
  if (result === 'wrong') return { error: 'Current PIN is wrong.' };
  if (result === 'no_pin_set') {
    // Still on the env-var PIN — verify against it before allowing the change.
    const users = await import('@/lib/worker').then((m) => m.getUsers());
    const me = users.find((u) => u.id === s.uid);
    const envName = me?.email === 'awronzberg@gmail.com' ? 'ASHLEY_PIN' : 'MARK_PIN';
    const expected = process.env[envName] ?? '';
    if (currentPin !== expected) return { error: 'Current PIN is wrong.' };
  }

  await workerFetch('/family/pin/set', { method: 'POST', userId: s.uid, body: { pin: newPin } });
  return { ok: true };
}

// ---------- Quick-add assistant ----------------------------------------------

export async function askAssistant(text: string): Promise<{ reply: string; actions: string[] }> {
  const s = await requireSession();
  const result = await workerFetch<{ reply: string; actions: string[] }>('/family/assistant', {
    method: 'POST',
    userId: s.uid,
    body: { text },
  });
  revalidatePath('/');
  revalidatePath('/tasks');
  revalidatePath('/lists');
  revalidatePath('/calendar');
  revalidatePath('/habits');
  return result;
}

// ---------- Web push ---------------------------------------------------------

export async function getVapidPublicKey(): Promise<string> {
  const s = await requireSession();
  const { publicKey } = await workerFetch<{ publicKey: string }>(
    '/family/push/vapid-public-key',
    { userId: s.uid },
  );
  return publicKey;
}

export async function savePushSubscription(subscription: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<void> {
  const s = await requireSession();
  await workerFetch('/family/push/subscribe', {
    method: 'POST',
    userId: s.uid,
    body: { subscription },
  });
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  const s = await requireSession();
  await workerFetch('/family/push/unsubscribe', {
    method: 'POST',
    userId: s.uid,
    body: { endpoint },
  });
}

export async function sendTestPush(): Promise<number> {
  const s = await requireSession();
  const { sent } = await workerFetch<{ sent: number }>('/family/push/test', {
    method: 'POST',
    userId: s.uid,
  });
  return sent;
}

// ---------- Settings ---------------------------------------------------------

export async function saveIcsFeeds(feeds: { name: string; url: string }[]): Promise<void> {
  const s = await requireSession();
  await workerFetch('/family/settings', {
    method: 'PUT',
    userId: s.uid,
    body: { ics_feeds: feeds.filter((f) => f.url.trim() !== '') },
  });
  revalidatePath('/calendar');
  revalidatePath('/settings');
  revalidatePath('/');
}
