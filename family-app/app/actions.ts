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
