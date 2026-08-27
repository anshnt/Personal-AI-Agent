import { z } from 'zod';

import { resolveCurrentUser } from '@/lib/db/users';
import { createTask, listTasks } from '@/lib/tasks/store';

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await resolveCurrentUser();
    const params = new URL(request.url).searchParams;
    const includeCompleted = params.get('include_completed') === 'true';

    const rows = await listTasks({ userId: user.id, includeCompleted, limit: 200 });

    return Response.json({
      tasks: rows.map((task) => ({
        id: task.id,
        title: task.title,
        notes: task.notes,
        status: task.status,
        priority: task.priority,
        tags: task.tags,
        due_at: task.dueAt?.toISOString() ?? null,
        created_at: task.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('[tasks] list failed', error);
    return Response.json({ error: 'Could not load tasks' }, { status: 500 });
  }
}

const createBody = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(4000).optional(),
  priority: z.number().int().min(1).max(4).default(3),
  tags: z.array(z.string().min(1).max(24)).max(6).default([]),
  due_at: z.iso.datetime({ offset: true }).optional(),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = createBody.parse(await request.json());
    const user = await resolveCurrentUser();

    const created = await createTask({
      userId: user.id,
      title: body.title,
      notes: body.notes,
      priority: body.priority,
      tags: body.tags,
      dueAt: body.due_at ? new Date(body.due_at) : null,
    });

    return Response.json({ id: created.id, title: created.title }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request';
    return Response.json({ error: message }, { status: 400 });
  }
}
