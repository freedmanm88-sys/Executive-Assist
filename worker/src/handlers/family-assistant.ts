/**
 * Family quick-add assistant: natural language (typed or dictated) → actions.
 *
 * "add milk to grocery" → list item
 * "task for Ashley: book dentist Friday, kids category" → assigned task
 * "pizza night Saturday 6pm" → family event
 * "log my exercise" → habit check-in
 *
 * One Claude call with tools; we execute at most MAX_ACTIONS tool calls in a
 * loop and return a summary. Everything is created with source='assistant'.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, DEFAULT_MODEL } from '../claude.js';
import { withUserContext, type DbClient } from '../db.js';

const MAX_ACTIONS = 5;

export interface AssistantResult {
  reply: string;
  actions: string[];   // human-readable summaries of what was done
}

interface Ctx {
  userId:   string;
  userName: string;
  users:    { id: string; name: string }[];
  lists:    { id: string; name: string }[];
  habits:   { id: string; name: string }[];
  categories: string[];
}

async function loadCtx(userId: string, users: { id: string; name: string }[]): Promise<Ctx> {
  return withUserContext(userId, async (client) => {
    const lists = await client.query(`SELECT id, name FROM family_lists WHERE NOT archived ORDER BY created_at`);
    const habits = await client.query(
      `SELECT id, name FROM habits WHERE user_id = $1::uuid AND active ORDER BY created_at`,
      [userId],
    );
    const cats = await client.query(`SELECT value FROM family_settings WHERE key = 'task_categories'`);
    return {
      userId,
      userName: users.find((u) => u.id === userId)?.name ?? 'me',
      users,
      lists: lists.rows,
      habits: habits.rows,
      categories: Array.isArray(cats.rows[0]?.value) ? (cats.rows[0].value as string[]) : [],
    };
  });
}

// ---------- Tools ------------------------------------------------------------

function buildTools(ctx: Ctx): Anthropic.Tool[] {
  const userNames = ctx.users.map((u) => u.name);
  return [
    {
      name: 'create_task',
      description: 'Create a shared family task.',
      input_schema: {
        type: 'object',
        properties: {
          title:       { type: 'string' },
          notes:       { type: 'string' },
          assigned_to: { type: 'string', enum: userNames, description: 'Omit if for anyone.' },
          due_date:    { type: 'string', description: 'YYYY-MM-DD (Toronto). Omit if no due date.' },
          category:    { type: 'string', enum: ctx.categories.length ? ctx.categories : undefined, description: 'Omit if unclear.' },
          high_priority: { type: 'boolean' },
        },
        required: ['title'],
      },
    },
    {
      name: 'add_list_item',
      description: 'Add an item to a shared list (grocery, shopping, etc.). Creates the list if it does not exist.',
      input_schema: {
        type: 'object',
        properties: {
          list_name: { type: 'string', description: `Existing lists: ${ctx.lists.map((l) => l.name).join(', ')}` },
          text:      { type: 'string' },
          note:      { type: 'string' },
        },
        required: ['list_name', 'text'],
      },
    },
    {
      name: 'create_event',
      description: 'Create a family calendar event.',
      input_schema: {
        type: 'object',
        properties: {
          title:        { type: 'string' },
          date:         { type: 'string', description: 'YYYY-MM-DD (Toronto)' },
          time:         { type: 'string', description: 'HH:MM 24h Toronto. Omit for all-day.' },
          duration_min: { type: 'integer', description: 'Default 60.' },
          location:     { type: 'string' },
        },
        required: ['title', 'date'],
      },
    },
    {
      name: 'log_habit',
      description: `Check in one of the user's habits for today. Their habits: ${ctx.habits.map((h) => h.name).join(', ')}`,
      input_schema: {
        type: 'object',
        properties: { habit_name: { type: 'string' } },
        required: ['habit_name'],
      },
    },
  ];
}

// ---------- Tool execution ---------------------------------------------------

async function execTool(ctx: Ctx, client: DbClient, name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'create_task': {
      const assignee = ctx.users.find((u) => u.name.toLowerCase() === String(input['assigned_to'] ?? '').toLowerCase());
      const { rows } = await client.query(
        `INSERT INTO family_tasks (title, notes, assigned_to, due_at, priority, category, created_by, source)
         VALUES ($1, $2, $3,
                 CASE WHEN $4::text IS NULL THEN NULL
                      ELSE (($4::date + time '23:59') AT TIME ZONE 'America/Toronto') END,
                 $5, $6, $7::uuid, 'assistant')
         RETURNING title`,
        [
          input['title'], input['notes'] ?? null, assignee?.id ?? null,
          input['due_date'] ?? null, input['high_priority'] ? 1 : 3,
          input['category'] ?? null, ctx.userId,
        ],
      );
      return `Task "${rows[0].title}"${assignee ? ` → ${assignee.name}` : ''}${input['due_date'] ? ` (due ${input['due_date']})` : ''}`;
    }
    case 'add_list_item': {
      const listName = String(input['list_name']);
      let list = ctx.lists.find((l) => l.name.toLowerCase() === listName.toLowerCase());
      if (!list) {
        const { rows } = await client.query(
          `INSERT INTO family_lists (name, kind, created_by) VALUES ($1, 'custom', $2::uuid)
           ON CONFLICT (name) DO UPDATE SET archived = FALSE RETURNING id, name`,
          [listName, ctx.userId],
        );
        list = rows[0] as { id: string; name: string };
        ctx.lists.push(list);
      }
      await client.query(
        `INSERT INTO family_list_items (list_id, text, note, created_by, source)
         VALUES ($1::uuid, $2, $3, $4::uuid, 'assistant')`,
        [list.id, input['text'], input['note'] ?? null, ctx.userId],
      );
      return `"${input['text']}" → ${list.name} list`;
    }
    case 'create_event': {
      const time = input['time'] ? String(input['time']) : null;
      const dur = typeof input['duration_min'] === 'number' ? input['duration_min'] : 60;
      const { rows } = await client.query(
        `INSERT INTO family_events (title, location, start_at, end_at, all_day, created_by, source)
         VALUES ($1, $2,
                 (($3::text || ' ' || COALESCE($4::text, '00:00'))::timestamp AT TIME ZONE 'America/Toronto'),
                 CASE WHEN $4::text IS NULL THEN NULL
                      ELSE ((($3::text || ' ' || $4::text)::timestamp + ($5 || ' minutes')::interval) AT TIME ZONE 'America/Toronto') END,
                 $4::text IS NULL, $6::uuid, 'assistant')
         RETURNING title`,
        [input['title'], input['location'] ?? null, input['date'], time, String(dur), ctx.userId],
      );
      return `Event "${rows[0].title}" on ${input['date']}${time ? ` at ${time}` : ' (all day)'}`;
    }
    case 'log_habit': {
      const habit = ctx.habits.find(
        (h) => h.name.toLowerCase().includes(String(input['habit_name'] ?? '').toLowerCase())
            || String(input['habit_name'] ?? '').toLowerCase().includes(h.name.toLowerCase()),
      );
      if (!habit) return `Could not find a habit matching "${input['habit_name']}"`;
      const dup = await client.query(
        `SELECT 1 FROM habit_logs WHERE habit_id = $1::uuid AND user_id = $2::uuid
           AND (completed_at AT TIME ZONE 'America/Toronto')::date = (NOW() AT TIME ZONE 'America/Toronto')::date`,
        [habit.id, ctx.userId],
      );
      if ((dup.rowCount ?? 0) > 0) return `"${habit.name}" was already checked in today`;
      await client.query(
        `INSERT INTO habit_logs (user_id, habit_id, source) VALUES ($1::uuid, $2::uuid, 'assistant')`,
        [ctx.userId, habit.id],
      );
      return `Checked in "${habit.name}" for today`;
    }
    default:
      return `Unknown tool ${name}`;
  }
}

// ---------- Entry ------------------------------------------------------------

export async function runAssistant(
  userId: string,
  users: { id: string; name: string }[],
  text: string,
): Promise<AssistantResult> {
  const ctx = await loadCtx(userId, users);
  const tools = buildTools(ctx);
  const todayToronto = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  }).format(new Date());

  const system = [
    `You are the quick-add assistant for a family organizer app used by ${ctx.users.map((u) => u.name).join(' and ')}.`,
    `The current user speaking is ${ctx.userName}. Today is ${todayToronto} (America/Toronto).`,
    'Turn their request into tool calls. Resolve relative dates ("Friday", "tomorrow") to YYYY-MM-DD yourself.',
    'Use multiple tool calls if they asked for several things. If the request is ambiguous or not actionable,',
    'do not guess — reply in text asking one short clarifying question instead.',
  ].join(' ');

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: text }];
  const actions: string[] = [];
  let reply = '';

  for (let round = 0; round < 3 && actions.length < MAX_ACTIONS; round++) {
    const response = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 700,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages,
    });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    if (textBlocks.length > 0) reply = textBlocks.map((b) => b.text).join(' ').trim();

    if (toolUses.length === 0) break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    await withUserContext(userId, async (client) => {
      for (const tu of toolUses.slice(0, MAX_ACTIONS - actions.length)) {
        let summary: string;
        try {
          summary = await execTool(ctx, client, tu.name, tu.input as Record<string, unknown>);
          actions.push(summary);
        } catch (err) {
          summary = `Failed: ${(err as Error).message}`;
          console.error(`[assistant] tool ${tu.name} failed:`, err);
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: summary });
      }
    });

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: results });
    if (response.stop_reason !== 'tool_use') break;
  }

  if (!reply && actions.length > 0) reply = 'Done.';
  if (!reply) reply = "I couldn't figure out what to do with that — try e.g. \"add milk to grocery\" or \"task for Ashley: book dentist Friday\".";

  return { reply, actions };
}
