'use client';

import { useState, useTransition, useRef } from 'react';
import {
  addListItem,
  toggleListItem,
  deleteListItem,
  addItemComment,
  createList,
} from '@/app/actions';
import type { FamilyList, FamilyListItem, ItemComment } from '@/lib/types';

export function ListsView({
  lists,
  items,
  comments,
}: {
  lists: FamilyList[];
  items: FamilyListItem[];
  comments: ItemComment[];
}) {
  const [activeListId, setActiveListId] = useState<string | null>(lists[0]?.id ?? null);
  const [showNewList, setShowNewList] = useState(false);
  const active = lists.find((l) => l.id === activeListId) ?? lists[0];
  const listItems = items.filter((i) => i.list_id === active?.id);
  const open = listItems.filter((i) => !i.done);
  const done = listItems.filter((i) => i.done).slice(0, 25);
  const commentsByItem = new Map<string, ItemComment[]>();
  for (const c of comments) {
    const arr = commentsByItem.get(c.item_id) ?? [];
    arr.push(c);
    commentsByItem.set(c.item_id, arr);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {lists.map((l) => (
          <button
            key={l.id}
            onClick={() => setActiveListId(l.id)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium border
              ${l.id === active?.id
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'border-neutral-300 dark:border-neutral-700'}`}
          >
            {l.name}
            <span className="ml-1.5 opacity-70 text-xs">
              {items.filter((i) => i.list_id === l.id && !i.done).length}
            </span>
          </button>
        ))}
        <button
          onClick={() => setShowNewList((v) => !v)}
          className="shrink-0 rounded-full px-3 py-1.5 text-sm border border-dashed border-neutral-400 dark:border-neutral-600 opacity-70"
        >
          + New
        </button>
      </div>

      {showNewList && <NewListForm onDone={() => setShowNewList(false)} />}

      {active && (
        <>
          <NewItemForm listId={active.id} />
          <section className="flex flex-col gap-2">
            {open.length === 0 && (
              <p className="text-sm opacity-60 py-4 text-center">List is empty.</p>
            )}
            {open.map((i) => (
              <ItemRow key={i.id} item={i} comments={commentsByItem.get(i.id) ?? []} />
            ))}
          </section>
          {done.length > 0 && (
            <details>
              <summary className="text-sm font-medium opacity-60 cursor-pointer">
                Checked off ({done.length})
              </summary>
              <div className="flex flex-col gap-2 mt-2">
                {done.map((i) => (
                  <ItemRow key={i.id} item={i} comments={commentsByItem.get(i.id) ?? []} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function NewListForm({ onDone }: { onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(fd) => {
        const name = String(fd.get('name') ?? '').trim();
        if (!name) return;
        startTransition(async () => {
          await createList(name, 'custom');
          onDone();
        });
      }}
      className="flex gap-2"
    >
      <input
        name="name"
        placeholder="List name (e.g. Costco, Cottage packing)"
        autoFocus
        className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
        autoComplete="off"
      />
      <button disabled={pending} className="rounded-lg bg-indigo-600 text-white px-4 text-sm font-semibold disabled:opacity-50">
        Create
      </button>
    </form>
  );
}

function NewItemForm({ listId }: { listId: string }) {
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={ref}
      action={(fd) => {
        const text = String(fd.get('text') ?? '').trim();
        if (!text) return;
        startTransition(async () => {
          await addListItem(listId, text);
          ref.current?.reset();
        });
      }}
      className="flex gap-2"
    >
      <input
        name="text"
        placeholder="Add item…"
        className="flex-1 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-transparent px-3 py-2.5"
        autoComplete="off"
      />
      <button disabled={pending} className="rounded-xl bg-indigo-600 text-white px-4 font-semibold text-sm disabled:opacity-50">
        Add
      </button>
    </form>
  );
}

function ItemRow({ item, comments }: { item: FamilyListItem; comments: ItemComment[] }) {
  const [pending, startTransition] = useTransition();
  const [showThread, setShowThread] = useState(false);
  const ref = useRef<HTMLFormElement>(null);

  return (
    <div className={`rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2.5 ${pending ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-3">
        <button
          aria-label={item.done ? 'Uncheck' : 'Check off'}
          onClick={() => startTransition(() => toggleListItem(item.id, !item.done))}
          className={`h-6 w-6 shrink-0 rounded-md border-2 flex items-center justify-center
            ${item.done ? 'border-green-500 bg-green-500 text-white' : 'border-neutral-400 dark:border-neutral-600'}`}
        >
          {item.done && (
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          )}
        </button>
        <span className={`flex-1 ${item.done ? 'line-through opacity-60' : ''}`}>{item.text}</span>
        <button
          onClick={() => setShowThread((v) => !v)}
          className={`text-xs px-2 py-1 rounded-md ${comments.length > 0 ? 'text-indigo-500 font-semibold' : 'text-neutral-400'}`}
        >
          💬{comments.length > 0 ? ` ${comments.length}` : ''}
        </button>
        <button
          aria-label="Delete item"
          onClick={() => startTransition(() => deleteListItem(item.id))}
          className="p-1 text-neutral-400 hover:text-red-500"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {showThread && (
        <div className="mt-2 ml-9 flex flex-col gap-1.5 border-l-2 border-neutral-200 dark:border-neutral-800 pl-3">
          {comments.map((c) => (
            <p key={c.id} className="text-sm">
              <span className="font-semibold">{c.author_name ?? '?'}:</span> {c.body}
            </p>
          ))}
          <form
            ref={ref}
            action={(fd) => {
              const body = String(fd.get('body') ?? '').trim();
              if (!body) return;
              startTransition(async () => {
                await addItemComment(item.id, body);
                ref.current?.reset();
              });
            }}
            className="flex gap-2 mt-1"
          >
            <input
              name="body"
              placeholder="Comment…"
              className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
              autoComplete="off"
            />
            <button className="text-sm text-indigo-500 font-semibold">Send</button>
          </form>
        </div>
      )}
    </div>
  );
}
