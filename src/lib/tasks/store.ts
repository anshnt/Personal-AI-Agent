import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { tasks, type NewTask, type Task, type TaskStatus } from '@/lib/db/schema';

const OPEN_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked'];

export interface CreateTaskInput {
  userId: string;
  title: string;
  notes?: string;
  priority?: number;
  tags?: string[];
  dueAt?: Date | null;
  sourceConversationId?: string | null;
}

export interface ListTasksOptions {
  userId: string;
  statuses?: TaskStatus[];
  tags?: string[];
  /** Only tasks due at or before this instant. */
  dueBefore?: Date;
  includeCompleted?: boolean;
  limit?: number;
}

function clampPriority(priority: number | undefined): number {
  if (priority === undefined || !Number.isFinite(priority)) return 3;
  return Math.min(4, Math.max(1, Math.round(priority)));
}

function normaliseTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const cleaned = tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0);
  return [...new Set(cleaned)];
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const title = input.title.trim();
  if (title.length === 0) throw new Error('A task needs a title');

  const values: NewTask = {
    userId: input.userId,
    title,
    notes: input.notes?.trim() ?? null,
    priority: clampPriority(input.priority),
    tags: normaliseTags(input.tags),
    dueAt: input.dueAt ?? null,
    sourceConversationId: input.sourceConversationId ?? null,
  };

  const [created] = await db.insert(tasks).values(values).returning();
  if (!created) throw new Error('Failed to create task');
  return created;
}

export async function listTasks(options: ListTasksOptions): Promise<Task[]> {
  const statuses = options.statuses ?? (options.includeCompleted ? undefined : OPEN_STATUSES);

  const filters = [eq(tasks.userId, options.userId)];
  if (statuses && statuses.length > 0) filters.push(inArray(tasks.status, statuses));
  if (options.tags && options.tags.length > 0) {
    filters.push(sql`${tasks.tags} && ${normaliseTags(options.tags)}::text[]`);
  }
  if (options.dueBefore) {
    filters.push(isNotNull(tasks.dueAt), lte(tasks.dueAt, options.dueBefore));
  }

  return db
    .select()
    .from(tasks)
    .where(and(...filters))
    .orderBy(
      // Anything with a due date comes first, soonest first; then by priority.
      sql`${tasks.dueAt} asc nulls last`,
      asc(tasks.priority),
      desc(tasks.createdAt),
    )
    .limit(Math.min(options.limit ?? 50, 200));
}

export interface UpdateTaskInput {
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: number;
  tags?: string[];
  dueAt?: Date | null;
}

export async function updateTask(
  userId: string,
  taskId: string,
  patch: UpdateTaskInput,
): Promise<Task | undefined> {
  const changes: Partial<NewTask> = { updatedAt: new Date() };

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (title.length === 0) throw new Error('A task needs a title');
    changes.title = title;
  }
  if (patch.notes !== undefined) changes.notes = patch.notes?.trim() ?? null;
  if (patch.priority !== undefined) changes.priority = clampPriority(patch.priority);
  if (patch.tags !== undefined) changes.tags = normaliseTags(patch.tags);
  if (patch.dueAt !== undefined) changes.dueAt = patch.dueAt;

  if (patch.status !== undefined) {
    changes.status = patch.status;
    // Keep completedAt consistent with status rather than trusting the caller.
    changes.completedAt = patch.status === 'done' ? new Date() : null;
  }

  const [updated] = await db
    .update(tasks)
    .set(changes)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .returning();

  return updated;
}

export async function deleteTask(userId: string, taskId: string): Promise<boolean> {
  const deleted = await db
    .delete(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .returning({ id: tasks.id });
  return deleted.length > 0;
}

export async function findTaskByTitle(userId: string, query: string): Promise<Task[]> {
  const term = query.trim();
  if (term.length === 0) return [];

  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        sql`(${tasks.title} ilike ${'%' + term + '%'} or coalesce(${tasks.notes}, '') ilike ${'%' + term + '%'})`,
      ),
    )
    .orderBy(
      // Open tasks first: a search for "renew passport" almost always means the
      // live one, not the copy that was completed last year.
      sql`case when ${tasks.status} in ('todo', 'in_progress', 'blocked') then 0 else 1 end`,
      asc(tasks.priority),
      desc(tasks.createdAt),
    )
    .limit(10);
}

/** Compact one-line summaries used to prime the system prompt. */
export async function openTaskSummaries(userId: string, limit = 8): Promise<string[]> {
  const open = await listTasks({ userId, limit });
  return open.map((task) => {
    const parts = [task.title];
    if (task.dueAt) parts.push(`due ${task.dueAt.toISOString()}`);
    if (task.status !== 'todo') parts.push(task.status);
    if (task.priority <= 2) parts.push(`p${task.priority}`);
    return parts.join(' — ');
  });
}
