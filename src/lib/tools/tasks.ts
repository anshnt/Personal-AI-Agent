import { tool } from 'ai';
import { z } from 'zod';

import {
  createTask,
  deleteTask,
  findTaskByTitle,
  listTasks,
  updateTask,
} from '@/lib/tasks/store';
import type { Task } from '@/lib/db/schema';
import { describeRelative, formatInTimezone } from '@/lib/time';
import { failure, instrument, type AgentContext } from './context';
import { id, isoDateTime } from './schemas';

const taskStatus = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);

/** Shape a task for the model: absolute time plus the relative reading of it. */
function render(task: Task, timezone: string) {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    status: task.status,
    priority: task.priority,
    tags: task.tags,
    due_at: task.dueAt?.toISOString() ?? null,
    due_local: task.dueAt ? formatInTimezone(task.dueAt, timezone) : null,
    due_relative: task.dueAt ? describeRelative(task.dueAt) : null,
    completed_at: task.completedAt?.toISOString() ?? null,
    created_at: task.createdAt.toISOString(),
  };
}

export function taskTools(context: AgentContext) {
  const timezone = context.user.timezone;

  return {
    create_task: tool({
      description:
        "Create a task on the user's list. Use it whenever they commit to something, ask you to remind them of work to do, or agree to a next step. Resolve relative dates like \"Friday\" into an absolute timestamp first.",
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe('Short and actionable, in imperative form.'),
        notes: z.string().max(4000).optional().describe('Detail that will not fit in the title.'),
        priority: z
          .number()
          .int()
          .min(1)
          .max(4)
          .default(3)
          .describe('1 is highest, 4 is lowest. Leave at 3 unless the user signals urgency.'),
        tags: z.array(z.string().min(1).max(24)).max(6).default([]),
        due_at: isoDateTime.optional().describe("Absolute ISO 8601, resolved in the user's timezone."),
      }),
      execute: instrument('create_task', context, async (input) => {
        const created = await createTask({
          userId: context.user.id,
          title: input.title,
          notes: input.notes,
          priority: input.priority,
          tags: input.tags,
          dueAt: input.due_at ? new Date(input.due_at) : null,
          sourceConversationId: context.conversationId,
        });

        return { ok: true as const, task: render(created, timezone) };
      }),
    }),

    list_tasks: tool({
      description:
        "List the user's tasks. Defaults to everything still open, soonest due first. Use `due_before` for questions like \"what's due this week\".",
      inputSchema: z.object({
        statuses: z
          .array(taskStatus)
          .max(5)
          .optional()
          .describe('Defaults to the open statuses: todo, in_progress, blocked.'),
        tags: z.array(z.string().min(1).max(24)).max(6).optional(),
        due_before: isoDateTime.optional(),
        include_completed: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      execute: instrument('list_tasks', context, async (input) => {
        const rows = await listTasks({
          userId: context.user.id,
          statuses: input.statuses,
          tags: input.tags,
          dueBefore: input.due_before ? new Date(input.due_before) : undefined,
          includeCompleted: input.include_completed,
          limit: input.limit,
        });

        return {
          ok: true as const,
          count: rows.length,
          tasks: rows.map((task) => render(task, timezone)),
        };
      }),
    }),

    find_task: tool({
      description:
        'Find a task by words in its title or notes. Use this to get an id before updating a task the user referred to by name.',
      inputSchema: z.object({
        query: z.string().min(1).max(200),
      }),
      execute: instrument('find_task', context, async (input) => {
        const rows = await findTaskByTitle(context.user.id, input.query);
        return {
          ok: true as const,
          count: rows.length,
          tasks: rows.map((task) => render(task, timezone)),
        };
      }),
    }),

    update_task: tool({
      description:
        'Change a task: mark it done, reschedule it, reprioritise it, or edit its text. Only the fields you pass are changed. Get the id from list_tasks or find_task first.',
      inputSchema: z.object({
        task_id: id,
        title: z.string().min(1).max(200).optional(),
        notes: z.string().max(4000).nullable().optional().describe('Pass null to clear the notes.'),
        status: taskStatus.optional(),
        priority: z.number().int().min(1).max(4).optional(),
        tags: z.array(z.string().min(1).max(24)).max(6).optional(),
        due_at: isoDateTime.nullable().optional().describe('Pass null to remove the due date.'),
      }),
      execute: instrument('update_task', context, async (input) => {
        const { task_id: taskId, due_at: dueAt, ...rest } = input;

        const hasChange =
          dueAt !== undefined ||
          Object.values(rest).some((value) => value !== undefined);
        if (!hasChange) {
          return failure('Pass at least one field to change.');
        }

        const updated = await updateTask(context.user.id, taskId, {
          ...rest,
          ...(dueAt !== undefined ? { dueAt: dueAt === null ? null : new Date(dueAt) } : {}),
        });

        if (!updated) return failure('No task with that id belongs to this user.');
        return { ok: true as const, task: render(updated, timezone) };
      }),
    }),

    delete_task: tool({
      description:
        'Delete a task permanently. Prefer update_task with status "cancelled" unless the user explicitly wants it gone, because cancelling keeps the record.',
      inputSchema: z.object({ task_id: id }),
      execute: instrument('delete_task', context, async (input) => {
        const deleted = await deleteTask(context.user.id, input.task_id);
        return deleted
          ? { ok: true as const, deleted: true }
          : failure('No task with that id belongs to this user.');
      }),
    }),
  };
}
